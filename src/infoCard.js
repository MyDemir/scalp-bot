'use strict';

/**
 * Bilgi kartı metni (Telegram HTML) + satır içi butonlar.
 * Görsel yok — yalnızca Telegram'ın kendi biçimleri: kalın/kod, açılır "Detaylar" bloğu
 * (<blockquote expandable>), cashtag/hashtag'ler ve butonlar.
 * Okunurluk: her bilgi kendi satırında "Etiket: değer", jargon yerine düz Türkçe, telefonda satır kırılmasın diye kısa satırlar.
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

/** Eşik işareti: 🔴 eşik üstü, 🔴🔴 güçlü (≥ strongRsi) */
const mark = (v, s) => (v >= s.strongRsi ? ' 🔴🔴' : v >= s.rsiMin ? ' 🔴' : '');

function levelLines(snap, s) {
  const lv = snap.level;
  if (!lv) return [`Direnç: %${s.levelMaxPct} içinde yok`];
  const where = lv.dist <= 0 ? `Dirence kalan: ${pa(lv.dist)}` : `Direncin üstünde: ${pa(lv.dist)}`;
  return [`Direnç: ${esc(lv.name)} · <code>${px(lv.value)}</code>`, `${where}${lv.zone === 'dip' ? ' · ⭐ dipte' : ''}`];
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
  const L = [];
  if (opt.header) L.push(opt.header);
  L.push(card.seq === '–'
    ? `📋 <b>$${esc(sym)}</b> · Anlık durum`
    : `🔴 <b>$${esc(sym)}</b> · Kart ${card.seq}${dip ? ' · ⭐ Dipte' : ''}`);
  for (const n of card.news) L.push(`🔔 ${esc(n)}`);

  L.push('');
  L.push(`Fiyat: <code>${px(card.price)}</code>`);
  L.push(...levelLines(snap, s));

  L.push('');
  for (const tf of ['3m', '5m', '15m']) L.push(`RSI ${tf}: ${r1(snap.rsi[tf].v)}${mark(snap.rsi[tf].v, s)}`);
  L.push(`RSI 1h: ${r1(snap.conf.h1)}${mark(snap.conf.h1, s)}`);
  L.push(`RSI 4h: ${r1(snap.conf.h4)}${mark(snap.conf.h4, s)}`);

  const [wl, ws] = snap.windows;
  const cnt = b => (b.buy + b.sell + b.neutral === 0 ? 'yok' : `${b.buy} alış · ${b.sell} satış${b.neutral ? ` · ${b.neutral} nötr` : ''}`);
  L.push('');
  if (snap.bursts[wl]) L.push(`Hacimli mum (${wl} dk): ${cnt(snap.bursts[wl].p1)}`);
  if (snap.bursts[ws]) L.push(`Hacimli mum (${ws} dk): ${cnt(snap.bursts[ws].p1)}`);
  L.push(`Alış − satış (${wl} dk): ${usd(snap.taker[wl])} $`);

  L.push('');
  for (const tf of ['3m', '5m']) {
    const e = snap.sep[tf];
    L.push(e ? `EMA21 ${tf}: <code>${px(e.ema)}</code> (${updown((e.ema - card.price) / card.price * 100)})` : `EMA21 ${tf}: —`);
  }
  const n1 = snap.neg?.['1m']?.count ?? 0, n3 = snap.neg?.['3m']?.count ?? 0;
  L.push(`Negatif tepe: ${n1 || n3 ? [n3 ? `3m'de ${n3}` : null, n1 ? `1m'de ${n1}` : null].filter(Boolean).join(', ') : 'yok'}`);

  // Detaylar — dokununca açılır
  const D = [];
  const m5 = snap.macd['5m'], m15 = snap.macd['15m'];
  D.push(`MACD 5m: ${m5 ? esc(m5.text) : '—'}`);
  D.push(`MACD 15m: ${m15 ? esc(m15.text) : '—'}`);
  if (snap.stoch) D.push(`Stoch RSI 5m: ${snap.stoch.k.toFixed(0)}${snap.stoch.cross ? ` (${snap.stoch.cross === 'down' ? 'aşağı' : 'yukarı'} kesti)` : ''}`);
  if (snap.vwap) D.push(`Günlük VWAP: ${px(snap.vwap.vwap)} (fiyat ${updown((card.price - snap.vwap.vwap) / snap.vwap.vwap * 100)})`);
  const others = (snap.levels || []).filter(l => l.value > card.price && l.name !== snap.level?.name && Math.abs(l.dist) <= 10);
  if (others.length) D.push(`Üstteki diğer dirençler: ${others.map(l => `${esc(l.name)} ${px(l.value)} (${pa(l.dist, 1)})`).join(' · ')}`);
  if (snap.bursts[wl]) D.push(`Hacimli mum ≥%${s.burstPct2} (${wl} dk): ${cnt(snap.bursts[wl].p2)}`);
  const at = ['3m', '5m'].map(tf => (snap.sep[tf] ? `${tf} ${snap.sep[tf].dist.toFixed(1)}${snap.sep[tf].touched ? ' (son 3 mumda dokundu)' : ''}` : null)).filter(Boolean);
  if (at.length) D.push(`EMA21'den uzaklık (ATR): ${at.join(' · ')}`);
  const f = snap.funding;
  const now = opt.now ?? card.t;
  if (f) D.push(`Funding: ${ps(f.rate * 100, 4)}${f.next ? ` · ${dur(f.next - now)} sonra` : ''}`);
  if (card.oi && Number.isFinite(card.oi.changePct)) D.push(`Açık pozisyon (1 saat): ${ps(card.oi.changePct, 1)}`);
  if (Number.isFinite(snap.btc1h)) D.push(`BTC (1 saat): ${ps(snap.btc1h, 2)}`);
  L.push(`<blockquote expandable>${D.join('\n')}</blockquote>`);
  L.push(`🕒 ${dayTime(card.t)}`);
  L.push(card.tags.map(esc).join(' '));

  const keyboard = [
    tgLinks(sym),
    [
      { text: 'ℹ️ Özet', callback_data: `o:${sym}` },
      { text: '🔕 1s sustur', callback_data: `m:${sym}` },
      { text: card.followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${sym}` },
    ],
  ];
  return { text: L.join('\n'), keyboard };
}

/**
 * 1 dakikalık fiyat hareketi uyarısı.
 * @param {object} m  { symbol, t, from, to, pct, volX, taker, vol24, followed, snap? }  snap: evaluate(force) çıktısı (izlenen coinlerde)
 */
function formatMove(m, s) {
  const up = m.pct > 0;
  const L = [];
  L.push(`⚡ <b>$${esc(m.symbol)}</b> · 1 dakikada <b>${ps(m.pct)}</b> ${up ? '▲' : '▼'}`);
  L.push('');
  L.push(`Fiyat: <code>${px(m.from)}</code> → <code>${px(m.to)}</code>`);
  if (m.volX != null) L.push(`Hacim: son 20 dk ortalamasının ${m.volX.toFixed(1)} katı`);
  if (m.taker != null) L.push(m.taker >= 50 ? `Alış oranı: ${pa(m.taker, 0)}` : `Satış oranı: ${pa(100 - m.taker, 0)}`);
  if (m.vol24 != null) L.push(`24 saatlik hacim: ${usd(m.vol24).replace('+', '')} $`);
  const sn = m.snap;
  if (sn) {
    L.push('');
    L.push(`RSI 3m / 5m / 15m: ${['3m', '5m', '15m'].map(tf => r1(sn.rsi[tf].v)).join(' / ')}`);
    if (sn.level) L.push(...levelLines(sn, s));
  } else {
    L.push('<i>İzlenen listede değil (24 saatlik hacim eşiğin altında)</i>');
  }
  L.push(`🕒 ${dayTime(m.t)}`);
  L.push([`#${esc(m.symbol)}`, '#HAREKET', up ? '#YUKSELIS' : '#DUSUS', m.followed ? '#TAKIP' : null].filter(Boolean).join(' '));
  const keyboard = [
    tgLinks(m.symbol),
    [
      { text: '🔕 1s sustur', callback_data: `m:${m.symbol}` },
      { text: m.followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${m.symbol}` },
    ],
  ];
  return { text: L.join('\n'), keyboard };
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
  return html.replace(/<blockquote expandable>/g, '▸ Detaylar (dokununca açılır)\n').replace(/<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { formatCard, formatMove, summaryText, toPlain, esc, hhmm, dayTime, px, pct, usd };
