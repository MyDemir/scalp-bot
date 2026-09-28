'use strict';

/**
 * Telegram — sinyal gönderimi + komutlar (Node'un yerleşik fetch'i ile, harici kütüphane yok)
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
const db  = require('./db');

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
        await api('sendMessage', body);
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
function sendText(text, keyboard = null) {
  enqueue('reply', CHAT_ID, text, keyboard ? { keyboard } : {});
}

/**
 * Bilgi kartı: kendi mesajı olarak gider (birleştirilmez), butonlu, istenirse sessiz.
 * 2 dakikadan uzun kuyrukta kalırsa başına "gecikmeli" satırı eklenir.
 */
function sendCard({ text, keyboard, silent = false }) {
  enqueue('card', CHAT_ID, text, { keyboard, silent });
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

// ── Sinyal mesajı ──────────────────────────────────────────────────────────

function bar(filled, total, maxWidth = 10) {
  const f = Math.max(0, Math.min(maxWidth, Math.round((filled / total) * maxWidth)));
  return '█'.repeat(f) + '░'.repeat(maxWidth - f);
}

/**
 * Sinyali kuyruğa alır (beklemez). Sıra, hız sınırı ve 429 tekrarları kuyrukta yönetilir.
 */
function sendSignalAlert(sig, breakdown) {
  const regime_icon = sig.regime === 'REVERSAL' ? '✅' : sig.regime === 'NEUTRAL' ? '❓' : '⚠️';
  const emc_line    = sig.hasEMC
    ? `\n⚡ <b>EMC</b> — Extreme Momentum Condition (15m RSI 95+)`
    : '';

  const text = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔴 <b>SHORT SİNYALİ</b>  |  Derece: <b>${esc(sig.grade)}</b>  [${sig.score}/100]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💰 <b>$${esc(sig.symbol)}</b>
📍 Fiyat: <code>${sig.entryPrice}</code>
🔹 Rejim: <b>${esc(sig.regime)}</b> ${regime_icon}${emc_line}

📊 <b>RSI Analizi:</b>
  ⏱ 5m  → ${sig.rsi5m?.toFixed(1) ?? '—'}${sig.rsi5m >= 95 ? '  🔥' : sig.rsi5m >= cfg.rsi5mMin ? '  ✅' : ''}
  ⏱ 15m → ${sig.rsi15m?.toFixed(1) ?? '—'}${sig.rsi15m >= 95 ? '  🔥' : sig.rsi15m >= cfg.rsi15mMin ? '  ✅' : ''}
  ⏱ 1h  → ${sig.rsi1h?.toFixed(1) ?? '—'}  ✅
  ⏱ 4h  → ${sig.rsi4h?.toFixed(1) ?? '—'}  ✅

📐 EMA21 uzaklık: <b>${sig.ema21Distance?.toFixed(2)} × ATR</b>  ✅
${sig.dailyResistance ? `🧱 Günlük direnç: <code>${sig.dailyResistance}</code>` : ''}${sig.dailyEMA200 ? `  |  EMA200: <code>${sig.dailyEMA200}</code>` : ''}
📦 Volume: <b>${sig.volumeRatio?.toFixed(1)}×</b> ortalama
📈 CVD: ${sig.cvdDirection === 'NEGATIVE' ? 'Negatife dönüyor ✅' : sig.cvdDirection === 'POSITIVE' ? 'Pozitif ⚠️' : 'Nötr'}
${sig.oiDeltaPct != null ? `📊 OI Delta: <b>${sig.oiDeltaPct > 0 ? '+' : ''}${sig.oiDeltaPct.toFixed(2)}%</b>` : ''}

🎯 TP-A: <code>${sig.tpA}</code>
🎯 TP-B: <code>${sig.tpB ?? '—'}</code>

🧠 <b>Skor: ${sig.score}/100</b>
  RSI şiddeti    ${bar(breakdown.rsi,    25)}  ${breakdown.rsi}/25
  EMA21 uzaklık  ${bar(breakdown.ema21,  20)}  ${breakdown.ema21}/20
  Direnç         ${bar(breakdown.resist, 20)}  ${breakdown.resist}/20
  Volume + CVD   ${bar(breakdown.volume, 15)}  ${breakdown.volume}/15
  OI delta       ${bar(breakdown.oi,     10)}  ${breakdown.oi}/10
  Divergence     ${bar(breakdown.diverge,10)}  ${breakdown.diverge}/10
${breakdown.emcBonus > 0 ? `  ⚡ EMC bonus    +${breakdown.emcBonus}` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `.trim();

  enqueue('alert', CHAT_ID, text);
}

// ── Komutlar ───────────────────────────────────────────────────────────────

const outcomeIcon = o => o === 'WIN' ? '✅' : o === 'LOSS' ? '❌' : o === 'LOSS_THEN_RECOVER' ? '↩️' : o === 'NEUTRAL' ? '➖' : '⏳';

const legacyCommands = {
  signals() {
    const signals = db.getRecentSignals(10);
    if (!signals.length) return 'Henüz sinyal yok.';
    const lines = signals.map(s => {
      const r = s.rMultiple != null ? ` | R: ${s.rMultiple.toFixed(2)}` : '';
      return `${outcomeIcon(s.outcome)} <b>${esc(s.symbol)}</b> [${esc(s.grade)} ${s.score}]${r}`;
    }).join('\n');
    return `<b>Son 10 Sinyal:</b>\n${lines}`;
  },

  stats() {
    const s = db.getStats();
    if (!s || !s.total) return 'Henüz sonuçlanmış sinyal yok.';
    const winRate = ((s.wins / s.total) * 100).toFixed(1);
    return `
📊 <b>Genel İstatistik</b>
Toplam: ${s.total}
✅ Win: ${s.wins} | ❌ Loss: ${s.losses} | ↩️ Stop sonrası dönüş: ${s.ltr} | ➖ Nötr: ${s.neutrals}
Win rate: <b>${winRate}%</b>
TP-B'ye ulaşan: ${s.tpBReached}
Ort. R: <b>${s.avgR ?? '—'}</b>
Ort. MFE: ${s.avgMFE ?? '—'}%
Ort. MAE: ${s.avgMAE ?? '—'}%`.trim();
  },

  winrate() {
    const rows = db.getWinrateByGrade();
    if (!rows.length) return 'Henüz veri yok.';
    const lines = rows.map(r => `<b>${esc(r.grade)}</b>: ${r.winPct}% win | ${r.total} sinyal | Ort R: ${r.avgR ?? '—'}`).join('\n');
    return `📈 <b>Dereceye Göre Win Rate:</b>\n${lines}`;
  },

  regime() {
    const rows = db.getWinrateByRegime();
    if (!rows.length) return 'Henüz veri yok.';
    const lines = rows.map(r => `<b>${esc(r.regime)}</b>: ${r.winPct}% win | ${r.total} sinyal | Ort R: ${r.avgR ?? '—'}`).join('\n');
    return `🔍 <b>Rejime Göre Win Rate:</b>\n${lines}`;
  },

  emc() {
    const rows = db.getEMCStats();
    if (!rows.length) return 'Henüz veri yok.';
    const w = rows.find(r => r.hasEMC === 1);
    const wo = rows.find(r => r.hasEMC === 0);
    return `
⚡ <b>EMC (Extreme Momentum Condition) Analizi</b>
EMC Var:  ${w  ? `${w.winPct}% win | ${w.total} sinyal`   : '—'}
EMC Yok:  ${wo ? `${wo.winPct}% win | ${wo.total} sinyal` : '—'}`.trim();
  },

  best() {
    const rows = db.getBestSymbols();
    if (!rows.length) return 'Henüz yeterli veri yok.';
    return `🏆 <b>En Başarılı Coinler:</b>\n` + rows.map((r, i) => `${i + 1}. <b>${esc(r.symbol)}</b>: ${r.winPct}% (${r.total} sinyal)`).join('\n');
  },

  worst() {
    const rows = db.getWorstSymbols();
    if (!rows.length) return 'Henüz yeterli veri yok.';
    return `⚠️ <b>En Başarısız Coinler:</b>\n` + rows.map((r, i) => `${i + 1}. <b>${esc(r.symbol)}</b>: ${r.winPct}% (${r.total} sinyal)`).join('\n');
  },

  report() {
    const s = db.getStats();
    const rows = db.getWinrateByGrade();
    if (!s || !s.total) return 'Henüz veri yok.';
    const winRate  = ((s.wins / s.total) * 100).toFixed(1);
    const gradeStr = rows.map(r => `  ${esc(r.grade)}: ${r.winPct}% (${r.total})`).join('\n');
    return `
📋 <b>Performans Raporu</b>

Toplam sinyal: ${s.total}
Win rate: <b>${winRate}%</b>
Ort. R-multiple: <b>${s.avgR ?? '—'}</b>

<b>Dereceye göre:</b>
${gradeStr}`.trim();
  },

  help() {
    return `
<b>Scalp Sinyal Motoru — Komutlar</b>

/signals  — Son 10 sinyal
/stats    — Genel istatistik
/winrate  — Dereceye göre win rate
/regime   — Rejime göre win rate
/emc      — EMC analizi
/best     — En başarılı coinler
/worst    — En başarısız coinler
/report   — Performans raporu`.trim();
  },
};

// Aktif komut tablosu — bilgi botu setCommands() ile kendi komutlarını koyar
let commands = { ...legacyCommands };
function setCommands(table) { commands = { ...table }; }

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

async function handleCallback(cq) {
  if (String(cq.message?.chat?.id) !== String(CHAT_ID)) { ignoredChats++; return; }
  let res = null;
  try { res = callbackHandler ? await callbackHandler(cq) : null; }
  catch (err) { console.error('[TELEGRAM] buton işlenemedi:', err.message); res = { text: 'Hata oluştu.' }; }
  try {
    await api('answerCallbackQuery', { callback_query_id: cq.id, text: res?.text ? String(res.text).slice(0, 200) : undefined, show_alert: Boolean(res?.alert) });
  } catch (err) { console.warn(`[TELEGRAM] answerCallbackQuery: ${err.message}`); }
}

async function handleUpdate(u) {
  if (u.callback_query) return handleCallback(u.callback_query);
  const msg = u.message;
  if (!msg?.text || !msg.text.startsWith('/')) return;

  // Yetki: yalnızca yapılandırılmış sohbet
  if (String(msg.chat?.id) !== String(CHAT_ID)) { ignoredChats++; return; }

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
  if (typeof reply === 'object') enqueue('reply', msg.chat.id, reply.text, reply.keyboard ? { keyboard: reply.keyboard } : {});
  else enqueue('reply', msg.chat.id, reply);
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
  start, stop, sendSignalAlert, sendText, sendCard, flush, takeStats, queueLength, esc,
  setCommands, onCallback, isAdmin, editMessage,
  _internal: { handleUpdate, get commands() { return commands; }, queue },
};
