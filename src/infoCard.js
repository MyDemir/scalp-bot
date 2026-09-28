'use strict';

/**
 * Bilgi kartı metni (Telegram HTML) + satır içi butonlar.
 * Görsel yok — yalnızca Telegram'ın kendi biçimleri: kalın/kod, açılır "Detaylar" bloğu
 * (<blockquote expandable>), hashtag'ler ve butonlar.
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

const ok = b => (b ? '✅' : '▫️');

function rsiPart(snap, s) {
  return ['3m', '5m', '15m'].map(tf => {
    const r = snap.rsi[tf];
    const v = `${r.live ? '~' : ''}${r1(r.v)}`;
    return `${tf} ${r.v >= s.rsiMin ? `<b>${v}</b>` : v}${r.v >= s.strongRsi ? '🔥' : ''}`;
  }).join(' · ');
}

function burstLine(b) {
  return `≥%${'{p}'} ▲${b.buy} ▼${b.sell}${b.neutral ? ` ◆${b.neutral}` : ''}`;
}

/**
 * @param {object} card  infoEngine.step() çıktısı (+ isteğe bağlı card.oi = {changePct})
 * @param {object} s     ayarlar
 * @param {object} [opt] { now, header }
 * @returns {{ text: string, keyboard: object[][] }}
 */
function formatCard(card, s, opt = {}) {
  const { snap } = card;
  const L = [];
  if (opt.header) L.push(opt.header);
  L.push(`🔴 <b>${esc(card.symbol)}</b> #${card.seq} · <code>${px(card.price)}</code> · RSI <b>${snap.hits}/3</b> · ${hhmm(card.t)}`);
  L.push(`🆕 ${card.news.map(esc).join(' · ')}`);
  L.push('');
  L.push(`📊 RSI ${rsiPart(snap, s)}`);

  if (snap.level) {
    const lv = snap.level;
    L.push(`🧱 ${esc(lv.name)} <code>${px(lv.value)}</code> · ${pct(lv.dist)} ${lv.zone === 'dip' ? '⭐ <b>DİPTE</b>' : '↗ yaklaşıyor'}`);
  } else {
    L.push(`🧱 %${s.levelMaxPct} içinde seviye yok`);
  }

  // EMA21: fiyatı ve fiyata göre uzaklığı (% ve ATR) — 3m/5m EMA21 geri çekilme hedefleri
  const sp = snap.sep;
  const emaTxt = ['3m', '5m'].map(tf => {
    const e = sp[tf];
    if (!e) return `${tf} —`;
    const d = (e.ema - card.price) / card.price * 100;
    return `${tf} <code>${px(e.ema)}</code> ${pct(d, 1)} (${e.dist.toFixed(1)} ATR${e.touched ? ', dokundu' : ''})`;
  }).join(' · ');
  L.push(`📐 EMA21 ${emaTxt} ${ok(snap.sepOk)}`);
  const ng = snap.neg || {};
  const n1 = ng['1m']?.count ?? 0, n3 = ng['3m']?.count ?? 0;
  L.push(`〽️ Negatif tepe ${n1 || n3 ? `1m <b>${n1}</b> · 3m <b>${n3}</b>` : 'yok'}`);
  L.push(`🧭 Destek 1h ${r1(snap.conf.h1)} ${ok(snap.conf.h1 >= s.confRsi)} · 4h ${r1(snap.conf.h4)} ${ok(snap.conf.h4 >= s.confRsi)}`);

  const [wl, ws] = snap.windows;
  for (const w of [wl, ws]) {
    const b = snap.bursts[w];
    if (!b) continue;
    const p1 = burstLine(b.p1).replace('{p}', s.burstPct1), p2 = burstLine(b.p2).replace('{p}', s.burstPct2);
    L.push(`${w === wl ? '📦' : '   '} ${w}dk ${p1} · ${p2}`);
  }
  L.push(`💱 Taker net ${wl}dk ${usd(snap.taker[wl])} · ${ws}dk ${usd(snap.taker[ws])}`);

  // Detaylar — dokununca açılır
  const D = [];
  const m5 = snap.macd['5m'], m15 = snap.macd['15m'];
  D.push(`MACD 5m: ${m5 ? esc(m5.text) : '—'} · 15m: ${m15 ? esc(m15.text) : '—'}`);
  if (snap.stoch) D.push(`Stoch RSI 5m: ${snap.stoch.k.toFixed(0)}/${snap.stoch.d.toFixed(0)}${snap.stoch.cross ? ` ${snap.stoch.cross === 'down' ? '↓' : '↑'} kesişim` : ''}`);
  if (snap.vwap) D.push(`VWAP (gün): <code>${px(snap.vwap.vwap)}</code> · fiyat ${snap.vwap.pos >= 0 ? '+' : '−'}${Math.abs(snap.vwap.pos).toFixed(1)}σ`);
  const lvList = (snap.levels || []).filter(l => Math.abs(l.dist) <= 10).map(l => `${esc(l.name)} ${px(l.value)} (${pct(l.dist, 1)})`);
  if (lvList.length) D.push(`Seviyeler: ${lvList.join(' · ')}`);
  const f = snap.funding;
  const now = opt.now ?? card.t;
  if (f) D.push(`Funding: ${pct(f.rate * 100, 4)}${f.next ? ` · sonraki ${dur(f.next - now)} sonra` : ''}`);
  const ctxBits = [];
  if (card.oi && Number.isFinite(card.oi.changePct)) ctxBits.push(`OI 1h: ${pct(card.oi.changePct, 1)}`);
  if (Number.isFinite(snap.btc1h)) ctxBits.push(`BTC 1h: ${pct(snap.btc1h, 2)}`);
  if (ctxBits.length) D.push(ctxBits.join(' · '));
  L.push(`<blockquote expandable>${D.join('\n')}</blockquote>`);
  L.push(card.tags.map(esc).join(' '));

  const sym = card.symbol;
  const keyboard = [
    [
      { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(sym)}.P` },
      { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(sym)}` },
    ],
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
  L.push(`⚡ <b>${esc(m.symbol)}</b> 1 dakikada <b>${pct(m.pct)}</b> ${up ? '▲' : '▼'} · <code>${px(m.from)} → ${px(m.to)}</code> · ${hhmm(m.t)}`);
  const tk = m.taker == null ? null : m.taker > s.takerBuyPct ? `taker %${Math.round(m.taker)} alım` : m.taker < s.takerSellPct ? `taker %${Math.round(m.taker)} satış` : `taker %${Math.round(m.taker)} nötr`;
  const bits = [m.volX != null ? `hacim ${m.volX.toFixed(1)}× (önceki 20 dk ort.)` : null, tk, m.vol24 != null ? `24s hacim ${usd(m.vol24).replace('+', '')} $` : null].filter(Boolean);
  if (bits.length) L.push(`📦 ${bits.join(' · ')}`);
  const sn = m.snap;
  if (sn) {
    L.push(`📊 RSI ${rsiPart(sn, s)} · ${sn.hits}/3 ≥ ${s.rsiMin}`);
    if (sn.level) L.push(`🧱 ${esc(sn.level.name)} <code>${px(sn.level.value)}</code> · ${pct(sn.level.dist)} ${sn.level.zone === 'dip' ? '⭐ DİPTE' : '↗ yaklaşıyor'}`);
  } else {
    L.push('<i>İzlenen evren dışında (24s hacim eşiğin altında) — RSI/seviye yok</i>');
  }
  L.push([`#${esc(m.symbol)}`, '#HAREKET', up ? '#YUKSELIS' : '#DUSUS', m.followed ? '#TAKIP' : null].filter(Boolean).join(' '));
  const sym = m.symbol;
  const keyboard = [
    [
      { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(sym)}.P` },
      { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(sym)}` },
    ],
    [
      { text: '🔕 1s sustur', callback_data: `m:${sym}` },
      { text: m.followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${sym}` },
    ],
  ];
  return { text: L.join('\n'), keyboard };
}

let dmFmt = null;
function dayTime(t) {
  try {
    dmFmt = dmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return dmFmt.format(new Date(t)).replace(',', '');
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
  return html.replace(/<blockquote expandable>/g, '▸ Detaylar\n').replace(/<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { formatCard, formatMove, summaryText, toPlain, esc, hhmm, dayTime, px, pct, usd };
