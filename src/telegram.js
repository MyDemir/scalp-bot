'use strict';

/**
 * Telegram — kart / mesaj gönderimi + komutlar + butonlar (Node'un yerleşik fetch'i ile, harici kütüphane yok)
 *
 * Eskiden node-telegram-bot-api kullanılıyordu: bağımlılık zincirinde 9 güvenlik açığı (2 kritik)
 * vardı ve hız sınırı / yetki kontrolü yoktu.
 *
 *   • Yetki: komutlara YALNIZCA TELEGRAM_CHAT_ID sohbetinden yanıt verilir
 *   • Hız: grupta dakikada 20 mesaj limiti → mesajlar arası ≥ cfg.telegramMinIntervalMs
 *   • 429: Telegram'ın verdiği retry_after kadar beklenip TEKRAR denenir (sinyal kaybolmaz)
 *   • Birikme: kuyrukta bekleyen sinyaller 4096 karakter sınırına kadar tek mesajda birleştirilir
 *   • 409: aynı token'la başka bir kopya çalışıyorsa açık uyarı
 *
 * Bu modül yüklenince ağa çıkmaz; komut dinleme start() ile başlar.
 */

require('dotenv').config();
const cfg = require('./config');

const API_BASE = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const TOKEN    = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID  = process.env.TELEGRAM_CHAT_ID;

const MAX_LEN = 4000;         // Telegram sınırı 4096
const SEP     = '\n\n';
const sleep   = ms => new Promise(r => setTimeout(r, ms));

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── API ────────────────────────────────────────────────────────────────────

class TelegramError extends Error {
  constructor(message, code, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function api(method, body, timeoutMs = 15_000) {
  // URL token içerir — hata mesajlarına/loglara URL asla yazılmaz
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${TOKEN}/${method}`, {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new TelegramError(`ağ hatası (${err.name === 'TimeoutError' ? 'zaman aşımı' : err.cause?.code || err.message})`, 0);
  }
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) {
    throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code ?? res.status, data.parameters?.retry_after);
  }
  return data.result;
}

/** Dosyalı istek (sendPhoto) — Node'un yerleşik FormData/Blob'u ile, harici kütüphane yok */
async function apiMultipart(method, fields, photo, timeoutMs = 30_000) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  fd.append('photo', new Blob([photo], { type: 'image/png' }), 'grafik.png');
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${TOKEN}/${method}`, { method: 'POST', body: fd, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    throw new TelegramError(`ağ hatası (${err.name === 'TimeoutError' ? 'zaman aşımı' : err.cause?.code || err.message})`, 0);
  }
  const data = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
  if (!data.ok) throw new TelegramError(data.description || `HTTP ${res.status}`, data.error_code ?? res.status, data.parameters?.retry_after);
  return data.result;
}

// Fotoğraf açıklaması (caption) sınırı: görünen metin 1024 karakter
const CAPTION_MAX = 1024;
// multipart gönderimde satır sonları \r\n'e çevrilir → her satır sonu 2 karakter sayılır (güvenli taraf)
const visibleLen = html => {
  const t = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return t.length + (t.match(/\n/g) || []).length;
};

/**
 * Grafikli mesaj: metin açıklamaya sığıyorsa tek mesaj (fotoğraf + açıklama + butonlar).
 * Sığmıyorsa önce açılır "Detaylar" bloğu çıkarılır; yine sığmıyorsa fotoğraf yalnız başlıkla,
 * tam metin + butonlar ayrı mesajla gider.
 */
async function sendWithPhoto(body, photo) {
  const base = { chat_id: body.chat_id, message_thread_id: body.message_thread_id, parse_mode: 'HTML', disable_notification: body.disable_notification };
  let caption = body.text;
  // Sığmıyorsa "Detaylar" bloğunu sondan satır satır kırp (önemli satırlar başta)
  while (visibleLen(caption) > CAPTION_MAX) {
    // Önce SON kutu (Ayrıntılar) sondan satır satır kırpılır; boşalınca kaldırılır, sonra bir önceki kutu
    const open = caption.lastIndexOf('<blockquote expandable>');
    if (open < 0) break;
    const close = caption.indexOf('</blockquote>', open);
    if (close < 0) break;
    const endTag = close + '</blockquote>'.length;
    const lines = caption.slice(open + '<blockquote expandable>'.length, close).split('\n');
    // Sondan kırp, ama kutunun sonundaki etiket satırını (#…) koru
    let i = lines.length - 1;
    while (i >= 0 && /^#/.test(lines[i])) i--;
    if (i < 0) lines.length = 0; else lines.splice(i, 1);
    const keepTagsOnly = lines.length && lines.every(x => /^#/.test(x)) && caption.slice(0, open).includes('<blockquote expandable>');
    const repl = lines.length && !(lines.length === 1 && lines[0] === '<b>Ayrıntılar</b>') && !keepTagsOnly ? `<blockquote expandable>${lines.join('\n')}</blockquote>` : '';
    caption = (caption.slice(0, open) + repl + caption.slice(endTag)).replace(/\n+$/, '');
  }
  if (visibleLen(caption) <= CAPTION_MAX) {
    return apiMultipart('sendPhoto', { ...base, caption, reply_markup: body.reply_markup }, photo);
  }
  await apiMultipart('sendPhoto', { ...base, caption: body.text.split('\n')[0] }, photo);
  return api('sendMessage', body);
}

// ── Gönderim kuyruğu ───────────────────────────────────────────────────────

const queue = [];   // { kind: 'alert'|'reply'|'card', chatId, text, attempts, keyboard?, silent?, createdAt }
let pumping = false;
let lastSentAt = 0;
const stats = { sent: 0, failed: 0, retried429: 0, merged: 0 };

function enqueue(kind, chatId, text, extra = {}) {
  queue.push({ kind, chatId, text, attempts: 0, createdAt: Date.now(), ...extra });
  pump();
}

// Kuyrukta bu kadar bekleyen kartın başına "gecikmeli" etiketi eklenir (hiçbir kart atılmaz)
const LATE_MS = 2 * 60_000;

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.length) {
      const wait = lastSentAt + cfg.telegramMinIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);

      const item = queue.shift();
      // Birikmiş sinyalleri tek mesajda topla (grup limitine takılmadan hepsi hızlıca ulaşsın)
      if (item.kind === 'alert') {
        while (queue.length && queue[0].kind === 'alert' && queue[0].chatId === item.chatId &&
               item.text.length + SEP.length + queue[0].text.length <= MAX_LEN) {
          item.text += SEP + queue.shift().text;
          stats.merged++;
        }
      }

      try {
        const body = { chat_id: item.chatId, text: item.text, parse_mode: 'HTML', disable_web_page_preview: true };
        if (item.thread) body.message_thread_id = item.thread;       // konulu (forum) grupta hedef konu
        if (item.kind === 'card') {
          const waited = Date.now() - item.createdAt;
          if (waited > LATE_MS) {
            body.text = `⏳ <i>gecikmeli (${Math.round(waited / 60000)} dk kuyrukta bekledi)</i>\n` + item.text;
          }
          if (item.keyboard) body.reply_markup = { inline_keyboard: item.keyboard };
          if (item.silent) body.disable_notification = true;
        } else if (item.keyboard) {
          body.reply_markup = { inline_keyboard: item.keyboard };
        }
        if (item.silent) body.disable_notification = true;
        if (item.replyTo) body.reply_parameters = { message_id: item.replyTo, allow_sending_without_reply: true };
        if (item.photo) await sendWithPhoto(body, item.photo);
        else await api('sendMessage', body);
        stats.sent++;
        lastSentAt = Date.now();
      } catch (err) {
        lastSentAt = Date.now();
        if (err.code === 429) {
          const sec = err.retryAfter ?? 5;
          stats.retried429++;
          console.warn(`[TELEGRAM] 429 hız sınırı — ${sec} sn sonra tekrar denenecek (kuyrukta ${queue.length + 1})`);
          queue.unshift(item);
          await sleep(sec * 1000);
          continue;
        }
        if (item.thread && err.code === 400 && /thread|topic/i.test(err.message)) {
          // Konu silinmiş/kapatılmış → mesajı kaybetme, genel akışa gönder
          console.warn(`[TELEGRAM] Konu ${item.thread} bulunamadı (${err.message}) — mesaj genel akışa gönderiliyor. /konu ile yeniden bağla.`);
          item.thread = null;
          queue.unshift(item);
          continue;
        }
        if (item.photo && err.code >= 400 && err.code < 500) {
          // Grafik reddedildiyse (boyut/biçim) kartı kaybetme — metin olarak tekrar dene
          console.warn(`[TELEGRAM] Grafikli gönderim reddedildi (${err.code}: ${err.message}) — grafiksiz tekrar deneniyor`);
          item.photo = null;
          queue.unshift(item);
          continue;
        }
        if (err.code >= 400 && err.code < 500) {
          stats.failed++;
          console.error(`[TELEGRAM] Mesaj gönderilemedi (${err.code}: ${err.message}) — kalıcı hata, atlandı`);
          continue;
        }
        item.attempts++;
        if (item.attempts < 4) {
          console.warn(`[TELEGRAM] Gönderim hatası (${err.message}) — ${5 * item.attempts} sn sonra tekrar (${item.attempts}/3)`);
          queue.unshift(item);
          await sleep(5000 * item.attempts);
        } else {
          stats.failed++;
          console.error(`[TELEGRAM] Mesaj 3 denemede gönderilemedi: ${err.message}`);
        }
      }
    }
  } finally {
    pumping = false;
  }
}

/** Düz metin mesajı kuyruğa al (HTML) — ör. backtest özet raporu */
function sendText(text, keyboard = null, thread = null) {
  enqueue('reply', CHAT_ID, text, { ...(keyboard ? { keyboard } : {}), ...(thread ? { thread } : {}) });
}

/**
 * Bilgi kartı: kendi mesajı olarak gider (birleştirilmez), butonlu, istenirse sessiz.
 * 2 dakikadan uzun kuyrukta kalırsa başına "gecikmeli" satırı eklenir.
 */
function sendCard({ text, keyboard, silent = false, photo = null, thread = null }) {
  enqueue('card', CHAT_ID, text, { keyboard, silent, photo, thread });
}

function queueLength() { return queue.length; }

/**
 * Kuyruk boşalana kadar bekle (kısa ömürlü süreçler — backtest — çıkmadan önce).
 * @returns {Promise<boolean>} kuyruk boşaldıysa true, zaman aşımına uğradıysa false
 */
function flush(timeoutMs = 60_000) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      if (!pumping && queue.length === 0) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/** Heartbeat için */
function takeStats() {
  const s = { ...stats, queued: queue.length };
  stats.sent = stats.failed = stats.retried429 = stats.merged = 0;
  return s;
}

// ── Komutlar ───────────────────────────────────────────────────────────────

// Aktif komut tablosu — bilgi botu setCommands() ile kendi komutlarını koyar
let commands = {};
function setCommands(table) { commands = { ...table }; }

/**
 * Komut menüsünü Telegram'a kaydeder: sohbette "/" yazınca ya da Menü butonuna basınca açıklamalarıyla listelenir.
 * Hem hedef grup (chat kapsamı) hem özel sohbet (varsayılan kapsam) için. Hata botu durdurmaz.
 * @param {{command:string, description:string}[]} list
 */
async function publishCommands(list) {
  const commandsList = list.map(c => ({ command: c.command, description: c.description.slice(0, 256) }));
  for (const scope of [{ type: 'chat', chat_id: CHAT_ID }, { type: 'default' }]) {
    try { await api('setMyCommands', { commands: commandsList, scope }); }
    catch (err) { console.warn(`[TELEGRAM] komut menüsü kaydedilemedi (${scope.type}): ${err.message}`); return false; }
  }
  console.log(`[TELEGRAM] komut menüsü kaydedildi (${commandsList.length} komut)`);
  return true;
}

// Buton tıklamaları (callback_query) — bilgi botu onCallback() ile işleyici verir
let callbackHandler = null;
function onCallback(fn) { callbackHandler = fn; }

// ── Yetki: ayar değiştirme / susturma yalnızca yöneticiler ─────────────────
// TELEGRAM_ADMIN_IDS (virgüllü kullanıcı ID listesi) tanımlıysa yalnızca onlar;
// tanımlı değilse grubun yöneticileri (getChatMember: creator/administrator), 10 dk önbellekli.
const adminCache = new Map();
async function isAdmin(userId) {
  if (userId == null) return false;
  const env = String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (env.length) return env.includes(String(userId));
  const hit = adminCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    const m = await api('getChatMember', { chat_id: CHAT_ID, user_id: userId });
    ok = ['creator', 'administrator'].includes(m?.status);
  } catch (err) {
    console.warn(`[TELEGRAM] getChatMember başarısız (${err.message}) — yetki verilmedi`);
  }
  adminCache.set(userId, { ok, until: Date.now() + 10 * 60_000 });
  return ok;
}

/** Mesaj düzenleme (ayar menüsü gibi kullanıcı tetiklemeli, nadir işlemler — kuyruğa girmez) */
async function editMessage(chatId, messageId, text, keyboard) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };
  try { await api('editMessageText', body); }
  catch (err) { if (!/not modified/i.test(err.message)) console.warn(`[TELEGRAM] mesaj düzenlenemedi: ${err.message}`); }
}

// ── Komut dinleme (long polling) ───────────────────────────────────────────

let botUsername = null;
let polling     = false;
let startedAt   = 0;
let ignoredChats = 0;
const loggedChats = new Set();
/** Yetkisiz sohbetten gelen komutu bir kez logla — yeni grubun ID'sini bulmak için (fly logs) */
function noteForeign(chat) {
  ignoredChats++;
  const id = String(chat?.id ?? '');
  if (!id || loggedChats.has(id)) return;
  loggedChats.add(id);
  console.log(`[TELEGRAM] Tanımsız sohbetten mesaj yok sayıldı: ${chat.title ? `"${chat.title}" ` : ''}ID ${id}${chat.is_forum ? ' (konulu grup)' : ''} — bu sohbeti kullanmak için: fly secrets set TELEGRAM_CHAT_ID=${id}`);
}

/** Grup üyesi mi (özel sohbette Detay isteği için) — 10 dk önbellek */
const memberCache = new Map();
async function isMember(userId) {
  if (userId == null) return false;
  const hit = memberCache.get(userId);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    const m = await api('getChatMember', { chat_id: CHAT_ID, user_id: userId });
    ok = ['creator', 'administrator', 'member', 'restricted'].includes(m?.status);
  } catch (err) {
    console.warn(`[TELEGRAM] getChatMember (üyelik) başarısız: ${err.message}`);
  }
  memberCache.set(userId, { ok, until: Date.now() + 10 * 60_000 });
  return ok;
}

/**
 * Kullanıcıya ÖZEL mesaj (bot ile özel sohbet). Kullanıcı botu hiç başlatmadıysa Telegram izin vermez (403) → false.
 * Kuyruğa girmez: özel sohbet grup hız sınırından bağımsızdır ve sonucun hemen bilinmesi gerekir.
 */
async function sendPrivate(userId, text) {
  try {
    await api('sendMessage', { chat_id: userId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (err) {
    if (err.code !== 403 && err.code !== 400) console.warn(`[TELEGRAM] özel mesaj gönderilemedi (${err.code}: ${err.message})`);
    return false;
  }
}

// Özel sohbette yalnızca "/start <parametre>" kabul edilir (📋 Detay bağlantısı) — işleyiciyi bilgi botu verir
let privateStartHandler = null;
function onPrivateStart(fn) { privateStartHandler = fn; }

async function handleCallback(cq) {
  if (String(cq.message?.chat?.id) !== String(CHAT_ID)) { noteForeign(cq.message?.chat); return; }
  let res = null;
  try { res = callbackHandler ? await callbackHandler(cq) : null; }
  catch (err) { console.error('[TELEGRAM] buton işlenemedi:', err.message); res = { text: 'Hata oluştu.' }; }
  try {
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: res?.text ? String(res.text).slice(0, 200) : undefined, show_alert: Boolean(res?.alert), ...(res?.url ? { url: res.url } : {}) });
  } catch (err) { console.warn(`[TELEGRAM] answerCallbackQuery: ${err.message}`); }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg?.text || !msg.text.startsWith('/')) return;

  // Özel sohbet: yalnızca /start <parametre> (📋 Detay) — başka komut çalışmaz
  if (msg.chat?.type === 'private') {
    const pm = msg.text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?/i);
    if (!pm || !privateStartHandler) return;
    let reply = null;
    try { reply = await privateStartHandler(pm[1] || '', msg); }
    catch (err) { console.error('[TELEGRAM] özel /start hatası:', err.message); reply = 'Hata oluştu.'; }
    if (reply) await sendPrivate(msg.chat.id, reply);
    return;
  }

  // Yetki: yalnızca yapılandırılmış sohbet
  if (String(msg.chat?.id) !== String(CHAT_ID)) { noteForeign(msg.chat); return; }

  // Bot başlamadan önce yazılmış eski komutları yanıtlama
  if (msg.date * 1000 < startedAt - 60_000) return;

  const m = msg.text.match(/^\/([a-zçğıöşü]+)(?:@(\w+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return;
  const [, cmd, target, rest] = m;
  if (target && botUsername && target.toLowerCase() !== botUsername.toLowerCase()) return;   // başka bota yazılmış

  const handler = commands[cmd.toLowerCase()];
  if (!handler) return;

  let reply;
  try { reply = await handler((rest || '').trim(), msg); }
  catch (err) { console.error(`[TELEGRAM] /${cmd} hatası:`, err.message); reply = 'Komut çalıştırılırken hata oluştu.'; }
  if (reply == null) return;
  const thread = msg.is_topic_message ? msg.message_thread_id : null;   // yanıt, komutun yazıldığı konuya
  if (typeof reply === 'object') enqueue('reply', msg.chat.id, reply.text, { ...(reply.keyboard ? { keyboard: reply.keyboard } : {}), ...(reply.photo ? { photo: reply.photo } : {}), ...(thread ? { thread } : {}) });
  else enqueue('reply', msg.chat.id, reply, thread ? { thread } : {});
}

async function pollLoop() {
  let offset = 0;
  while (polling) {
    try {
      const updates = await api('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 65_000);
      for (const u of updates) {
        offset = u.update_id + 1;
        handleUpdate(u).catch(err => console.error('[TELEGRAM] Güncelleme işlenemedi:', err.message));
      }
    } catch (err) {
      if (!polling) break;
      if (err.code === 409) {
        console.warn(`[TELEGRAM] 409 çakışma: ${err.message} — aynı token'la başka bir kopya çalışıyor olabilir (ör. lokalde npm start). 30 sn sonra tekrar.`);
        await sleep(30_000);
      } else if (err.code === 401 || err.code === 404) {
        console.error('[TELEGRAM] Token geçersiz (401/404) — komut dinleme durduruldu. TELEGRAM_BOT_TOKEN\'ı kontrol et.');
        polling = false;
      } else {
        await sleep(5_000);
      }
    }
  }
}

/**
 * Ortam değişkenlerini doğrular, bot kimliğini kontrol eder ve komut dinlemeyi başlatır.
 * Eksik/yanlış yapılandırmada açık hata fırlatır (bot sessizce çalışmaya devam etmesin).
 */
async function start() {
  const missing = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Eksik ortam değişkeni: ${missing.join(', ')} (fly secrets set ... ile tanımla)`);
  if (!/^-?\d+$/.test(String(CHAT_ID))) throw new Error(`TELEGRAM_CHAT_ID sayı olmalı (grup için -100... ile başlar), gelen: "${CHAT_ID}"`);

  try {
    const me = await api('getMe', {});
    botUsername = me.username;
    console.log(`[TELEGRAM] @${botUsername} bağlı — hedef sohbet ${CHAT_ID}, komutlar yalnızca bu sohbetten kabul edilir`);
  } catch (err) {
    if (err.code === 401 || err.code === 404) throw new Error('TELEGRAM_BOT_TOKEN geçersiz (Telegram 401/404)');
    console.warn(`[TELEGRAM] getMe başarısız (${err.message}) — ağ sorunu olabilir, devam ediliyor`);
  }

  startedAt = Date.now();
  polling = true;
  pollLoop();
}

function stop() {
  polling = false;
}

module.exports = {
  start, stop, sendText, sendCard, flush, takeStats, queueLength, esc,
  sendPrivate, onPrivateStart, isMember, getBotUsername: () => botUsername, setCommands, publishCommands, onCallback, isAdmin, editMessage,
  _internal: { handleUpdate, get commands() { return commands; }, queue },
};
