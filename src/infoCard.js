'use strict';

/**
 * Bilgi kartı metni (Telegram HTML) + satır içi butonlar.
 * Düzen (hızlı okuma — kutu yok, her şey açıkta, kısa):
 *   başlık (daireler + #COIN — TÜR) · 🔔 neden geldi · RSI alt alta · boşluk · direnç · fiyat · saat
 * Diğer her şey "📋 Detay" butonunda: basınca kartın altına ayrı (sessiz) mesaj olarak gelir.
 * formatCard → { text, keyboard, details }  (details: Detay mesajının HTML'i)
 *
 * Bu modülün yan etkisi yok.
 */

const TZ = process.env.DISPLAY_TZ || 'Europe/Istanbul';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let hhmmFmt = null;
function hhmm(t) {
  try {
    hhmmFmt = hhmmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    return hhmmFmt.format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(11, 16) + ' UTC';
  }
}

const px = v => (v == null || !Number.isFinite(v) ? '—' : String(+v.toPrecision(6)));
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const r1 = v => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

function usd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), sg = v > 0 ? '+' : v < 0 ? '−' : '';
  if (a >= 1e9) return `${sg}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sg}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sg}${(a / 1e3).toFixed(0)}K`;
  return `${sg}${a.toFixed(0)}`;
}

function dur(ms) {
  if (!(ms > 0)) return '—';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}s ${m % 60}dk` : `${m}dk`;
}

const pa = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `%${Math.abs(v).toFixed(d)}`);
const ps = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d)}`);
const updown = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${pa(v, d)} ${v >= 0 ? 'yukarıda' : 'aşağıda'}`);

const { circles, dirColor } = require('./infoEngine');


/** Direnç tek satır: "Direnç: 4h MA200 0.33664 (%0.26 kala) ⭐" */
function levelLine(snap, s) {
  const lv = snap.level;
  if (!lv) return `Direnç: %${s.levelMaxPct} içinde yok`;
  return `Direnç: ${esc(lv.name)} ${px(lv.value)} (${lv.dist <= 0 ? `${pa(lv.dist)} kala` : `${pa(lv.dist)} üstünde`})${lv.zone === 'dip' ? ' ⭐' : ''}`;
}

/** RSI alt alta: 3dk / 5dk / 15dk / 1s / 4s */
const TF_TR = { '3m': '3dk', '5m': '5dk', '15m': '15dk' };
function rsiLines(sn) {
  return [
    ...['3m', '5m', '15m'].map(tf => `RSI ${TF_TR[tf]}: ${r1(sn.rsi[tf].v)}`),
    `RSI 1s: ${r1(sn.conf?.h1)}`,
    `RSI 4s: ${r1(sn.conf?.h4)}`,
  ];
}

/** Hedef (3m / 5m EMA21): "Hedef: 3m EMA21 %0.2 · 5m EMA21 %0.3 aşağıda" */
function targetLine(snap, price) {
  const items = ['3m', '5m'].map(tf => snap.sep?.[tf] ? { tf, d: (snap.sep[tf].ema - price) / price * 100 } : null).filter(Boolean);
  if (!items.length) return null;
  const side = d => (d <= 0 ? 'aşağıda' : 'yukarıda');
  const same = items.every(x => side(x.d) === side(items[0].d));
  return `<b>Hedef:</b> ${items.map(x => `${x.tf} EMA21 ${pa(x.d, 1)}${same ? '' : ` ${side(x.d)}`}`).join(' · ')}${same ? ` ${side(items[0].d)}` : ''}`;
}

function tgLinks(sym) {
  return [
    { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(sym)}.P` },
    { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(sym)}` },
  ];
}

/**
 * Bilgi kartı. Düzen: başlık → neden geldi (🔔) → fiyat/direnç → RSI (her dilim ayrı satır)
 * → hacim → EMA21 / negatif tepe → açılır Detaylar → saat → etiketler.
 * @param {object} card  infoEngine.step() çıktısı (+ isteğe bağlı card.oi = {changePct})
 * @param {object} s     ayarlar
 * @param {object} [opt] { now, header }
 * @returns {{ text: string, keyboard: object[][] }}
 */
function formatCard(card, s, opt = {}) {
  const { snap } = card;
  const sym = card.symbol;
  const dip = snap.level?.zone === 'dip';
  const now = opt.now ?? card.t;
  const T = card.trig || {};

  // ── Kart (kısa) ──
  const L = [];
  if (opt.header) L.push(opt.header);
  L.push(card.seq === '–'
    ? `📋 <b>#${esc(sym)} — Anlık durum</b>`
    : `${circles(snap.grade ?? 0, dirColor(snap.chg))} <b>#${esc(sym)} — RSI</b>`);
  // 🔔 neden geldi (tek satır) + özel olaylar (sahte kırılım / fiyat keşfi / hacimli mum)
  const why = card.seq === '–'
    ? `şart ${snap.ok ? 'sağlanıyor ✅' : `sağlanmıyor (${(snap.fails || []).join(', ') || '—'})`}`
    : T.sfp ? '⚠️ Sahte kırılım'
      : snap.rsiOk ? `RSI ${s.rsiMin}+`
        : card.inSeries ? 'Seri sürüyor (şart dışı)' : `RSI ${s.rsiMin}+`;
  L.push(`🔔: ${[why, card.seq === '–' ? null : `Kart ${card.seq}`, dip ? '⭐ Dipte' : null].filter(Boolean).join(' · ')}`);
  const special = card.news.filter(n => /^(⚡|⚠️ Sahte kırılım|🚀 Fiyat keşfi|🟢|🔴|⚪)/.test(n));
  for (const n of special.slice(0, 2)) L.push(esc(n));
  L.push(...rsiLines(snap));
  L.push('');
  L.push(levelLine(snap, s));
  L.push(`Fiyat: ${px(card.price)}`);
  L.push(`⏱: ${dayTime(card.t)}`);

  // ── Detay mesajı (📋 Detay butonu) ──
  const D = [`📋 <b>#${esc(sym)} — ${card.seq === '–' ? 'anlık durum' : `Kart ${card.seq}`} ayrıntıları</b> · ${dayTime(card.t)}`];
  if (card.news.length) { D.push(''); for (const n of card.news) D.push(`🔔 ${esc(n)}`); }
  const ck = snap.check;
  if (ck) {
    D.push('');
    D.push(`<b>Kontrol ${ck.score}/${ck.total}</b>`);
    for (const it of ck.items) D.push(`${it.ok ? '✅' : '▫️'} ${esc(it.text)}`);
    if (ck.warn) D.push(esc(ck.warn));
  }
  const tgt = targetLine(snap, card.price);
  const dc = snap.discovery;
  if (tgt || dc) D.push('');
  if (tgt) D.push(tgt);
  if (dc) {
    D.push(`<b>Kırılan seviye:</b> ${esc(dc.broken.name)} ${px(dc.broken.value)} (${pa((card.price - dc.broken.value) / dc.broken.value * 100)} aşağıda)`);
    D.push(dc.above ? `<b>Sonraki direnç:</b> ${esc(dc.above.name)} ${px(dc.above.value)} (${pa((dc.above.value - card.price) / card.price * 100)} yukarıda)` : '<b>Sonraki direnç:</b> yok (üstünde hiç seviye yok)');
    if (dc.ext.length) D.push(`<b>Fib uzantı:</b> ${dc.ext.map(x => `${x.r} → ${px(x.value)} (+${pa((x.value - card.price) / card.price * 100, 1)})`).join(' · ')}`);
  }
  // 1 dk hareket (bu kartı doğurduysa) + bugünkü hareket sayacı + 3dk EMA21 takip/kopuş
  const mv = T.move, ms = card.moveStats;
  if (mv || ms || snap.ride) D.push('');
  if (mv) D.push(`<b>Hareket:</b> 1 dk ${ps(mv.pct)} (${px(mv.from)} → ${px(mv.to)})${mv.volX != null ? ` · hacim ${mv.volX.toFixed(1)} kat` : ''}${mv.taker != null ? ` · alış ${pa(mv.taker, 0)} / satış ${pa(100 - mv.taker, 0)}` : ''}`);
  if (ms) {
    const net = ms.up - ms.down;
    D.push(`<b>Bugün 1 dk ≥ %${s.moveAlertPct} hareket:</b> ▲ ${ms.up} · ▼ ${ms.down} · fark ${net > 0 ? '+' : net < 0 ? '−' : ''}${Math.abs(net)}`);
  }
  const rd = snap.ride;
  if (rd) {
    const at = `${rd.dist >= 0 ? '+' : '−'}${Math.abs(rd.dist).toFixed(1)} ATR`;
    D.push(`<b>3dk EMA21:</b> ${rd.state === 'break' ? `koptu · ${at}, son 3 mumda değmedi (önceki ${rd.win} mumun ${rd.before}'${suffix(rd.before)} değmişti)`
      : rd.state === 'ride' ? `izliyor (trend) · son ${rd.win} mumun ${rd.recent}'${suffix(rd.recent)} değdi · ${at}`
        : `serbest · ${at} · son ${rd.win} mumda ${rd.recent} değme`}`);
  }

  D.push('');
  const [wl, ws] = snap.windows || [];
  const cnt = b => `${b.buy} alış · ${b.sell} satış${b.neutral ? ` · ${b.neutral} nötr` : ''}`;
  const has = b => b && b.buy + b.sell + b.neutral > 0;
  if (snap.bursts) {
    D.push(`<b>Hacimli mum (${wl} dk):</b> ${has(snap.bursts[wl]?.p1) ? cnt(snap.bursts[wl].p1) : 'yok'}`);
    if (has(snap.bursts[ws]?.p1)) D.push(`<b>Hacimli mum (${ws} dk):</b> ${cnt(snap.bursts[ws].p1)}`);
    if (has(snap.bursts[wl]?.p2)) D.push(`<b>Hacimli mum ≥%${s.burstPct2} (${wl} dk):</b> ${cnt(snap.bursts[wl].p2)}`);
  }
  if (snap.taker) D.push(`<b>Alış − satış (${wl} dk):</b> ${usd(snap.taker[wl])} $`);
  const m5 = snap.macd?.['5m'], m15 = snap.macd?.['15m'];
  if (m5 || m15) D.push(`<b>MACD:</b> 5m ${m5 ? esc(m5.text) : '—'} · 15m ${m15 ? esc(m15.text) : '—'}`);
  if (snap.stoch) D.push(`<b>Stoch RSI 5m:</b> ${snap.stoch.k.toFixed(0)}${snap.stoch.cross ? ` (${snap.stoch.cross === 'down' ? 'aşağı' : 'yukarı'} kesti)` : ''}`);
  if (snap.vwap) D.push(`<b>Günlük VWAP:</b> ${px(snap.vwap.vwap)} (fiyat ${updown((card.price - snap.vwap.vwap) / snap.vwap.vwap * 100)})`);
  const shown = snap.level ? `${snap.level.name}@${snap.level.value}` : null;
  const others = (snap.levels || [])
    .filter(l => l.value > card.price && l.kind !== 'fib' && l.name !== '1h tepe' && `${l.name}@${l.value}` !== shown && Math.abs(l.dist) <= 10)
    .sort((a, b) => a.value - b.value).slice(0, 3);
  if (others.length) D.push(`<b>Üstteki diğer dirençler:</b> ${others.map(l => `${esc(l.name)} ${px(l.value)} (${pa(l.dist, 1)})`).join(' · ')}`);
  const f = snap.funding;
  if (f) D.push(`<b>Funding:</b> ${ps(f.rate * 100, 4)}${f.next ? ` · ${dur(f.next - now)} sonra` : ''}`);
  if (card.oi && Number.isFinite(card.oi.changePct)) D.push(`<b>Açık pozisyon (1 saat):</b> ${ps(card.oi.changePct, 2)}`);
  if (Number.isFinite(snap.btc1h)) D.push(`<b>BTC (1 saat):</b> ${ps(snap.btc1h, 2)}`);
  const tags = (card.tags || []).filter(t => t !== `#${sym}`);
  if (tags.length) { D.push(''); D.push(tags.map(esc).join(' ')); }

  return { text: L.join('\n'), keyboard: cardKeyboard(card.id, sym, card.followed), details: D.join('\n') };
}

/** Sayıdan sonra "-(s)ında/-(s)inde" eki: 6'sında · 7'sinde · 10'unda … (yaklaşık, 0–10 için) */
function suffix(n) {
  return { 0: 'ında', 1: 'inde', 2: 'sinde', 3: 'ünde', 4: 'ünde', 5: 'inde', 6: 'sında', 7: 'sinde', 8: 'inde', 9: 'unda', 10: 'unda' }[n] ?? 'inde';
}

/** Butonlar: 📈 TradingView · 🟡 Binance / 📋 Detay · 🔕 1s sustur · ☆ Takip */
function cardKeyboard(id, sym, followed) {
  return [
    tgLinks(sym),
    [
      { text: '📋 Detay', callback_data: `d:${id}`.slice(0, 64) },
      { text: '🔕 1s sustur', callback_data: `m:${sym}` },
      { text: followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${sym}` },
    ],
  ];
}

let dmFmt = null;
function dayTime(t) {
  try {
    dmFmt = dmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return dmFmt.format(new Date(t)).replace(',', '').replace(/\//g, '.');
  } catch {
    return new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  }
}

/** "Özet" açılır penceresi (Telegram sınırı 200 karakter) */
function summaryText(sym, log, price, now = Date.now()) {
  const day = log.filter(x => x.t >= now - 86_400_000);
  if (!day.length) return `${sym}: son 24 saatte kart yok.`;
  let serie = [];
  for (const x of day) { if (x.seq === 1) serie = []; serie.push(x); }
  const first = serie[0] || day[day.length - 1];
  const chg = price && first.price ? (price - first.price) / first.price * 100 : null;
  const s = `${sym} · bu seride ${serie.length} kart (ilk ${hhmm(first.t)}, ${px(first.price)}) · şimdi ${px(price)} (${pct(chg)}) · 24 saatte ${day.length} kart`;
  return s.slice(0, 200);
}

/** HTML → düz metin (konsol / backtest örnekleri için) */
function toPlain(html) {
  return html.replace(/<blockquote expandable>/g, '▸ (dokununca açılır)\n').replace(/<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { formatCard, summaryText, toPlain, esc, hhmm, dayTime, px, pct, usd };
