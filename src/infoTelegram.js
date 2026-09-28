'use strict';

/**
 * Bilgi botunun Telegram komutları ve buton işleyicileri.
 *
 *   Herkes      : /yardim /ayarlar (görüntüleme) /coin /durum /sessiz /takip (liste) /benkimim, ℹ️ Özet
 *   Yöneticiler : ayar butonları, /ayar, /sustur, /ac, /takip SEMBOL, 🔕 ve ⭐ butonları
 *                 (TELEGRAM_ADMIN_IDS tanımlıysa o liste, değilse grubun yöneticileri)
 */

const { formatCard, summaryText, esc, px, pct, dayTime } = require('./infoCard');
const { evaluate, circles } = require('./infoEngine');
const { classTable, median } = require('./infoStats');
const { rowToStat } = require('./cardStore');

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
 * @param {object}   [p.store]   kart geçmişi (cardStore)
 */
function installInfoTelegram({ telegram, settings, tracker, store = null, getSeries, ctx, status }) {
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
/gecmis ETH [adet] — coinin son kartları ve sonrasında fiyat
/istatistik [gün] — kart sınıfları ve sonrasında fiyat (varsayılan 7 gün)
/durum — bot durumu
/benkimim — Telegram kullanıcı ID'n

<b>Derece daireleri</b>
RSI kartı: 🔴 RSI ≥ ${settings.get().rsiMin} · 🔴🔴 RSI ≥ ${settings.get().rsiMin2} + seviye · 🔴🔴🔴 üç dilimde ≥ ${settings.get().rsiMin2} + dipte + EMA21 ayrışması (sesli)
Hacimli mum / ⚡: 🔴 temel · 🔴🔴 hacim ≥ ${settings.get().volGrade2X}× · 🔴🔴🔴 + yön uyumu ≥ %${settings.get().dirGrade3Pct}
RSI periyodu: ${settings.get().rsiPeriod}

Kart ne zaman gelir: 3m/5m/15m'den en az <b>${settings.get().minTFs}</b> tanesinde RSI ≥ <b>${settings.get().rsiMin}</b>${settings.get().levelRequired ? ` ve fiyatın üstünde en fazla <b>%${settings.get().levelMaxPct}</b> uzakta bir seviye (4h/1d MA200 · EMA200 · 30 günlük tepe)` : ''}. Kontrol: 3m/5m/15m kapanışları + hacimli her 1m mum. Önceki karttan bu yana yeni veri yoksa kart gitmez.${settings.get().seriesBursts ? ' Seri sürerken (5m RSI ' + settings.get().resetRsi + ' altına inmeden) gelen hacimli mumlar şart aranmadan kart olur (#SERI).' : ''}${settings.get().moveAlertPct > 0 ? `\n\n⚡ ${settings.get().moveAlertAll ? 'Herhangi bir' : 'İzlenen'} paritede 1 dakikada ≥ %${settings.get().moveAlertPct} fiyat değişimi → ayrı uyarı.` : ''}`.trim();

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

    gecmis: (args) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const [x, nArg] = args.split(/\s+/);
      const sym = normSym(x);
      if (!sym) return 'Kullanım: /gecmis ETH [adet]';
      const n = Math.max(1, Math.min(30, Number(nArg) || 10));
      const rows = store.recent(sym, n).map(rowToStat);
      if (!rows.length) return `${esc(sym)} için kayıtlı kart yok.`;
      const lines = rows.map(r => {
        const w = r.fwd[60] ? `60dk: ${pct(r.fwd[60].low, 1)} / ${pct(r.fwd[60].high, 1)} · sonra ${pct(r.fwd[60].close, 1)}` : r.partial ? '60dk: eksik (yeniden başlatma)' : '60dk: bekleniyor';
        if (r.kind === 'move') return `${dayTime(r.t)} ⚡${circles(r.grade || 1)} ${pct(r.movePct)} → ${w}`;
        const cls = [`RSI ${r.hits}/3`, r.level?.zone === 'dip' ? 'DİPTE' : r.level ? 'yaklaşıyor' : null, r.burst ? `${r.burst.dir === 'sell' ? '▼' : r.burst.dir === 'buy' ? '▲' : '◆'}patlama` : null, r.inSeries ? 'seri içi' : null].filter(Boolean).join(' · ');
        return `${dayTime(r.t)} ${r.grade != null ? circles(r.grade) + ' ' : ''}#${r.seq} ${cls} → ${w}`;
      });
      return `🗂 <b>${esc(sym)}</b> — son ${rows.length} kayıt (fiyat değişimi karttaki fiyata göre: en düşük / en yüksek · 60 dk sonra)\n${lines.join('\n')}`;
    },

    istatistik: (args) => {
      if (!store || !store.enabled()) return 'Kart geçmişi kapalı (veritabanı açılamadı).';
      const days = Math.max(1, Math.min(90, Number(args) || 7));
      const rows = store.since(Date.now() - days * 86_400_000).map(rowToStat);
      const cards = rows.filter(r => r.kind === 'card'), moves = rows.filter(r => r.kind === 'move');
      if (!rows.length) return `Son ${days} günde kayıt yok.`;
      const cls = classTable(cards).filter(r => r.n > 0).map(r =>
        `${esc(r.name.trim())}: <b>${r.n}</b> · 60dk en düşük ${pct(r.low60)} · en yüksek ${pct(r.high60)} · sonra ${pct(r.close60)}`);
      const mv = [['▲ yükseliş', moves.filter(m => m.movePct > 0)], ['▼ düşüş', moves.filter(m => m.movePct < 0)]].map(([k, a]) => {
        const f = a.filter(m => m.fwd[60]);
        return `${k}: <b>${a.length}</b> · 60dk sonra medyan ${pct(median(f.map(m => m.fwd[60].close)))} (en düşük ${pct(median(f.map(m => m.fwd[60].low)))} / en yüksek ${pct(median(f.map(m => m.fwd[60].high)))})`;
      });
      const pending = cards.filter(c => !c.fwd[60]).length;
      return `📊 <b>Son ${days} gün</b> · ${cards.length} kart · ${moves.length} hareket uyarısı
<i>Karttan sonraki 60 dk'da fiyat, kart anındaki fiyata göre (medyan). Kazanç/kayıp değildir.${pending ? ` 60 dk'sı dolmamış ${pending} kart hariç.` : ''}</i>

<b>Kart sınıfları</b>
${cls.join('\n') || '—'}

<b>⚡ 1 dk hareket uyarıları</b>
${mv.join('\n')}`.slice(0, 4000);
    },

    durum: () => status(),

    benkimim: (args, msg) => `Kullanıcı ID: <code>${msg.from?.id ?? '—'}</code>`,
  };

  telegram.setCommands(commands);
  telegram.onCallback(onCallback);
  return { menu, onCallback, commands, normSym };
}

module.exports = { installInfoTelegram, normSym, px };
