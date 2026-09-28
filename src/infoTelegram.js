'use strict';

/**
 * Bilgi botunun Telegram komutları ve buton işleyicileri.
 *
 *   Herkes      : /yardim /ayarlar (görüntüleme) /coin /durum /sessiz /takip (liste) /benkimim, ℹ️ Özet
 *   Yöneticiler : ayar butonları, /ayar, /sustur, /ac, /takip SEMBOL, 🔕 ve ⭐ butonları
 *                 (TELEGRAM_ADMIN_IDS tanımlıysa o liste, değilse grubun yöneticileri)
 */

const { formatCard, summaryText, esc, px } = require('./infoCard');
const { evaluate } = require('./infoEngine');

const HOUR = 3_600_000;

function normSym(x) {
  const s = String(x || '').trim().toUpperCase().replace(/[^A-Z0-9一-鿿]/g, '');
  if (!s) return null;
  return s.endsWith('USDT') ? s : s + 'USDT';
}

/**
 * @param {object} p
 * @param {object} p.telegram   telegram.js
 * @param {object} p.settings   infoSettings
 * @param {object} p.tracker    infoEngine tracker
 * @param {function} p.getSeries (sym) → Series | undefined
 * @param {function} p.ctx       değerlendirme bağlamı { funding, btc1h }
 * @param {function} p.status    () → durum metni
 */
function installInfoTelegram({ telegram, settings, tracker, getSeries, ctx, status }) {
  const defs = settings.defs;

  function menu() {
    const v = settings.get();
    const lines = defs.map(d => `${d.type === 'bool' ? (v[d.key] ? '✅' : '▫️') : '•'} ${esc(d.label)}: <b>${d.type === 'bool' ? (v[d.key] ? 'açık' : 'kapalı') : v[d.key]}</b>`);
    const text = `⚙️ <b>Bilgi botu ayarları</b>\n${lines.join('\n')}\n\n<i>− / + ve aç-kapa butonları yalnızca yöneticiler içindir. Değişiklik anında geçerli olur ve kalıcıdır.</i>`;
    const kb = [];
    for (const d of defs.filter(x => x.type !== 'bool')) {
      kb.push([
        { text: '➖', callback_data: `s:${d.key}:-1` },
        { text: `${d.short}: ${v[d.key]}`, callback_data: 'n' },
        { text: '➕', callback_data: `s:${d.key}:1` },
      ]);
    }
    const bools = defs.filter(x => x.type === 'bool');
    for (let i = 0; i < bools.length; i += 2) {
      kb.push(bools.slice(i, i + 2).map(d => ({ text: `${v[d.key] ? '✅' : '▫️'} ${d.short}`, callback_data: `t:${d.key}` })));
    }
    return { text, keyboard: kb };
  }

  const denied = { text: 'Bu işlem için grup yöneticisi olmalısın.', alert: true };

  async function onCallback(cq) {
    const data = String(cq.data || '');
    const uid = cq.from?.id;
    if (data === 'n') return null;

    const [kind, a, b] = data.split(':');
    if (kind === 'o') {
      const sr = getSeries(a);
      return { text: summaryText(a, tracker.log(a), sr ? sr.price() : null), alert: true };
    }
    if (!(await telegram.isAdmin(uid))) return denied;

    if (kind === 'm') {
      settings.mute(a, HOUR);
      console.log(`[AYAR] ${a} 1 saat susturuldu (kullanıcı ${uid})`);
      return { text: `🔕 ${a} 1 saat susturuldu. Açmak için: /ac ${a.replace(/USDT$/, '')}` };
    }
    if (kind === 'f') {
      const on = settings.toggleFollow(a);
      return { text: on ? `⭐ ${a} takipte — kartları her zaman sesli gelir.` : `☆ ${a} takipten çıkarıldı.` };
    }
    if (kind === 's' || kind === 't') {
      const r = kind === 's' ? settings.bump(a, Number(b)) : settings.bump(a, 0);
      if (!r.ok) return { text: r.error, alert: true };
      console.log(`[AYAR] ${a} = ${r.value} (kullanıcı ${uid})`);
      const m = menu();
      await telegram.editMessage(cq.message.chat.id, cq.message.message_id, m.text, m.keyboard);
      return { text: `${a} = ${r.value}` };
    }
    return null;
  }

  const adminOnly = fn => async (args, msg) => ((await telegram.isAdmin(msg.from?.id)) ? fn(args, msg) : 'Bu komut için grup yöneticisi olmalısın.');

  const help = () => `
<b>Bilgi Botu — Komutlar</b>

/ayarlar — ayarları gör / butonlarla değiştir
/ayar anahtar değer — tek ayarı değiştir (ör. <code>/ayar rsiMin 95</code>) · <code>/ayar sifirla</code>
/coin ETH — coinin anlık durumu (şart aranmaz)
/sustur ETH [dk] — coini sustur (varsayılan 60 dk) · /ac ETH
/sessiz — susturulanlar
/takip [ETH] — takip listesi / ekle-çıkar (takip edilenlerin kartları sesli gelir)
/durum — bot durumu
/benkimim — Telegram kullanıcı ID'n

Kart ne zaman gelir: 3m/5m/15m'den en az <b>${settings.get().minTFs}</b> tanesinde RSI ≥ <b>${settings.get().rsiMin}</b>${settings.get().levelRequired ? ` ve fiyatın üstünde en fazla <b>%${settings.get().levelMaxPct}</b> uzakta bir seviye (4h/1d MA200 · EMA200 · günlük direnç)` : ''}. Kontrol: 3m/5m/15m kapanışları + hacimli her 1m mum. Önceki karttan bu yana yeni veri yoksa kart gitmez.${settings.get().seriesBursts ? ' Seri sürerken (5m RSI ' + settings.get().resetRsi + ' altına inmeden) gelen hacimli mumlar şart aranmadan kart olur (#SERI).' : ''}`.trim();

  const commands = {
    help, yardim: help, start: help,

    ayarlar: () => menu(),

    ayar: adminOnly((args) => {
      const [k, ...rest] = args.split(/\s+/).filter(Boolean);
      if (!k) return 'Kullanım: <code>/ayar anahtar değer</code> — anahtarlar /ayarlar listesinde (ör. rsiMin, minTFs, levelMaxPct).';
      if (['sifirla', 'sıfırla', 'reset'].includes(k.toLowerCase())) { settings.reset(); return '↩️ Tüm ayarlar varsayılana döndü.'; }
      const d = defs.find(x => x.key.toLowerCase() === k.toLowerCase());
      if (!d) return `Bilinmeyen ayar: <code>${esc(k)}</code>. Liste: ${defs.map(x => x.key).join(', ')}`;
      const r = settings.set(d.key, rest.join(' '));
      return r.ok ? `✅ ${esc(d.label)} = <b>${r.value}</b>` : `❌ ${esc(r.error)}`;
    }),

    coin: (args) => {
      const sym = normSym(args);
      if (!sym) return 'Kullanım: /coin ETH';
      const sr = getSeries(sym);
      if (!sr) return `${esc(sym)} izlenmiyor (hacim filtresi dışında ya da yok).`;
      if (!sr.ready()) return `${esc(sym)} için veri henüz hazır değil.`;
      const s = settings.get();
      const snap = evaluate(sr, s, ctx(), true);
      const card = {
        symbol: sym, seq: '–', t: snap.t, price: snap.price, snap,
        news: [`Anlık durum (kart değil) · şart: ${snap.ok ? 'sağlanıyor ✅' : `sağlanmıyor (${snap.fails.join(', ')})`}`],
        tags: [`#${sym}`], followed: settings.isFollowed(sym),
      };
      return formatCard(card, s, { now: Date.now() });
    },

    sustur: adminOnly((args) => {
      const [x, m] = args.split(/\s+/);
      const sym = normSym(x);
      if (!sym) return 'Kullanım: /sustur ETH [dakika]';
      const min = Math.max(1, Math.min(7 * 1440, Number(m) || 60));
      settings.mute(sym, min * 60_000);
      return `🔕 ${esc(sym)} ${min} dk susturuldu.`;
    }),

    ac: adminOnly((args) => {
      const sym = normSym(args);
      if (!sym) return 'Kullanım: /ac ETH';
      settings.unmute(sym);
      return `🔔 ${esc(sym)} susturması kaldırıldı.`;
    }),

    sessiz: () => {
      const l = settings.mutedList();
      if (!l.length) return 'Susturulan coin yok.';
      return '🔕 <b>Susturulanlar</b>\n' + l.map(([s, u]) => `${esc(s)} — ${Math.ceil((u - Date.now()) / 60000)} dk kaldı`).join('\n');
    },

    takip: async (args, msg) => {
      const sym = normSym(args);
      if (!sym) {
        const l = settings.followList();
        return l.length ? '⭐ <b>Takip</b>\n' + l.map(esc).join('\n') : 'Takip listesi boş. Eklemek için: /takip ETH';
      }
      if (!(await telegram.isAdmin(msg.from?.id))) return 'Bu komut için grup yöneticisi olmalısın.';
      return settings.toggleFollow(sym) ? `⭐ ${esc(sym)} takibe alındı.` : `☆ ${esc(sym)} takipten çıkarıldı.`;
    },

    durum: () => status(),

    benkimim: (args, msg) => `Kullanıcı ID: <code>${msg.from?.id ?? '—'}</code>`,
  };

  telegram.setCommands(commands);
  telegram.onCallback(onCallback);
  return { menu, onCallback, commands, normSym };
}

module.exports = { installInfoTelegram, normSym, px };
