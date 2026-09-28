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

/** RSI satırı işareti: 🔴 ≥ rsiMin (85) · 🔴🔴 ≥ rsiMin2 (90) · 🔴🔴🔴 ≥ strongRsi (95) */
const mark = (v, s) => (v >= s.strongRsi ? ' 🔴🔴🔴' : v >= s.rsiMin2 ? ' 🔴🔴' : v >= s.rsiMin ? ' 🔴' : '');
const { circles, dirColor } = require('./infoEngine');

/** Kontrol listesinde eksik maddelerin kısa adları (değerleri RSI satırlarında zaten var) */
const checkShort = s => ({
  daily: 'günlük direnç', confluence: 'çakışan direnç', band: `3m/5m RSI ${s.strongRsi}–${s.rsiEntryMax}`, rsi15: `15m ≥ ${s.strongRsi}`,
  rsi5_15: `5m + 15m ≥ ${s.strongRsi}`, htf: `1h/4h ≥ ${s.confRsi}`, sep: 'EMA21 ayrışma', neg: 'negatif tepe ≥ 2',
});

/** Direnç tek satır: "Direnç: 4h MA200 0.33664 (%0.26 kala) ⭐" */
function levelLine(snap, s) {
  const lv = snap.level;
  if (!lv) return `<b>Direnç:</b> %${s.levelMaxPct} içinde yok${snap.discovery ? ' · 🚀 fiyat keşfi' : ''}`;
  return `<b>Direnç:</b> ${esc(lv.name)} ${px(lv.value)} (${lv.dist <= 0 ? `${pa(lv.dist)} kala` : `${pa(lv.dist)} üstünde`})${lv.zone === 'dip' ? ' ⭐' : ''}`;
}

/** RSI alt alta: 3m / 5m / 15m (eşik işaretli) + 1h / 4h */
function rsiLines(sn, s) {
  return [
    ...['3m', '5m', '15m'].map(tf => `<b>RSI ${tf}:</b> ${r1(sn.rsi[tf].v)}${mark(sn.rsi[tf].v, s)}`),
    `<b>RSI 1h:</b> ${r1(sn.conf?.h1)}`,
    `<b>RSI 4h:</b> ${r1(sn.conf?.h4)}`,
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
  const L = [];
  if (opt.header) L.push(opt.header);
  // Görünen tek satır (tür başlıkta: "— RSI"): daire RENGİ = son 15 dk fiyat yönü (🟢 yükseliş · 🔴 düşüş),
  // daire SAYISI = derece (kontrol listesi skoru). Altında iki kutu, ikisi de dokununca açılır:
  //   1) özet — her kartta aynı düzen, "yok" olan satır yazılmaz, tekrar yok
  //   2) Ayrıntılar — eksik maddeler ve ikincil göstergeler
  L.push(card.seq === '–'
    ? `📋 <b>#${esc(sym)}</b> · Anlık durum`
    : `${circles(snap.grade ?? 0, dirColor(snap.chg))} <b>#${esc(sym)} — RSI</b>`);

  // ── 1) Özet kutusu ──
  const B = [];
  const head = [card.seq === '–' ? null : `Kart ${card.seq}`, dip ? '⭐ Dipte' : null, hhmm(card.t)].filter(Boolean);
  B.push(`<b>${head.join(' · ')}</b>`);
  for (const n of card.news) B.push(`🔔 ${esc(n)}`);

  B.push('');
  B.push(`<b>Fiyat:</b> ${px(card.price)}`);
  B.push(levelLine(snap, s));
  const dc = snap.discovery;
  if (dc) {
    B.push(`<b>Kırılan seviye:</b> ${esc(dc.broken.name)} ${px(dc.broken.value)} (${pa((card.price - dc.broken.value) / dc.broken.value * 100)} aşağıda)`);
    B.push(dc.above ? `<b>Sonraki direnç:</b> ${esc(dc.above.name)} ${px(dc.above.value)} (${pa((dc.above.value - card.price) / card.price * 100)} yukarıda)` : '<b>Sonraki direnç:</b> yok (üstünde hiç seviye yok)');
    if (dc.ext.length) B.push(`<b>Fib uzantı:</b> ${dc.ext.map(x => `${x.r} → ${px(x.value)} (+${pa((x.value - card.price) / card.price * 100, 1)})`).join(' · ')}`);
  }

  B.push('');
  B.push(...rsiLines(snap, s));

  B.push('');
  const ck = snap.check;
  const short = checkShort(s);
  if (ck) {
    const okNames = ck.items.filter(it => it.ok).map(it => `✅ ${short[it.key] || it.key}${it.key === 'confluence' && ck.confluence ? ` (${ck.confluence.name})` : ''}`);
    B.push(`<b>Kontrol ${ck.score}/${ck.total}:</b>${okNames.length ? ' ' + esc(okNames.join(' · ')) : ' sağlanan madde yok'}`);
    if (ck.warn) B.push(esc(ck.warn));
  }
  const tgt = targetLine(snap, card.price);
  if (tgt) B.push(tgt);
  const [wl, ws] = snap.windows;
  const cnt = b => `${b.buy} alış · ${b.sell} satış${b.neutral ? ` · ${b.neutral} nötr` : ''}`;
  const has = b => b && b.buy + b.sell + b.neutral > 0;
  if (has(snap.bursts[wl]?.p1)) B.push(`<b>Hacimli mum (${wl} dk):</b> ${cnt(snap.bursts[wl].p1)}`);
  B.push(`<b>Alış − satış (${wl} dk):</b> ${usd(snap.taker[wl])} $`);
  // Etiketler özet kutusunun sonunda (coin etiketi başlıkta — tekrar edilmez)
  const rest = card.tags.filter(t => t !== `#${sym}`);
  if (rest.length) B.push(rest.map(esc).join(' '));
  L.push(`<blockquote expandable>${B.join('\n')}</blockquote>`);

  // ── 2) Ayrıntılar kutusu (önem sırasıyla; fotoğraf açıklaması sığmazsa önce bu kutu sondan kırpılır) ──
  const D = ['<b>Ayrıntılar</b>'];
  if (ck) for (const it of ck.items) if (!it.ok) D.push(`▫️ ${esc(it.text)}`);
  const m5 = snap.macd['5m'], m15 = snap.macd['15m'];
  if (m5 || m15) D.push(`<b>MACD:</b> 5m ${m5 ? esc(m5.text) : '—'} · 15m ${m15 ? esc(m15.text) : '—'}`);
  if (snap.stoch) D.push(`<b>Stoch RSI 5m:</b> ${snap.stoch.k.toFixed(0)}${snap.stoch.cross ? ` (${snap.stoch.cross === 'down' ? 'aşağı' : 'yukarı'} kesti)` : ''}`);
  if (snap.vwap) D.push(`<b>Günlük VWAP:</b> ${px(snap.vwap.vwap)} (fiyat ${updown((card.price - snap.vwap.vwap) / snap.vwap.vwap * 100)})`);
  // Üstteki diğer dirençler: en yakın 3 (kartın seviyesi ve çakışan seviye zaten yazıldı; Fib/1h tepe hariç)
  const shown = new Set([snap.level ? `${snap.level.name}@${snap.level.value}` : null,
    ck?.confluence ? `${ck.confluence.name}@${ck.confluence.value}` : null]);
  const others = (snap.levels || [])
    .filter(l => l.value > card.price && l.kind !== 'fib' && l.name !== '1h tepe' && !shown.has(`${l.name}@${l.value}`) && Math.abs(l.dist) <= 10)
    .sort((a, b) => a.value - b.value).slice(0, 3);
  if (others.length) D.push(`<b>Üstteki diğer dirençler:</b> ${others.map(l => `${esc(l.name)} ${px(l.value)} (${pa(l.dist, 1)})`).join(' · ')}`);
  if (has(snap.bursts[ws]?.p1)) D.push(`<b>Hacimli mum (${ws} dk):</b> ${cnt(snap.bursts[ws].p1)}`);
  if (has(snap.bursts[wl]?.p2)) D.push(`<b>Hacimli mum ≥%${s.burstPct2} (${wl} dk):</b> ${cnt(snap.bursts[wl].p2)}`);
  const f = snap.funding;
  const now = opt.now ?? card.t;
  if (f) D.push(`<b>Funding:</b> ${ps(f.rate * 100, 4)}${f.next ? ` · ${dur(f.next - now)} sonra` : ''}`);
  if (card.oi && Number.isFinite(card.oi.changePct)) D.push(`<b>Açık pozisyon (1 saat):</b> ${ps(card.oi.changePct, 2)}`);
  if (Number.isFinite(snap.btc1h)) D.push(`<b>BTC (1 saat):</b> ${ps(snap.btc1h, 2)}`);
  if (D.length > 1) L.push(`<blockquote expandable>${D.join('\n')}</blockquote>`);

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
  // Görünen tek satır: ⚡ + daireler (renk = yön, sayı = hacim derecesi) + coin. Gerisi bilgi kutusunda;
  // kapalı kutuda görünen ilk iki satır: hareket · hacim katı · alış/satış oranı, sonra fiyat.
  const head = `⚡${circles(m.grade || 1, up ? 'green' : 'red')} <b>#${esc(m.symbol)} — HACİM</b>`;
  const L = [];
  L.push([`${up ? '▲' : '▼'} <b>${ps(m.pct)}</b> (1 dk)`,
    m.volX != null ? `hacim ${m.volX.toFixed(1)} kat` : null,
    m.taker != null ? (m.taker >= 50 ? `alış ${pa(m.taker, 0)}` : `satış ${pa(100 - m.taker, 0)}`) : null,
  ].filter(Boolean).join(' · '));
  L.push(`<b>Fiyat:</b> ${px(m.from)} → ${px(m.to)}`);
  if (m.vol24 != null) L.push(`<b>24 saatlik hacim:</b> ${usd(m.vol24).replace('+', '')} $`);
  const sn = m.snap;
  L.push('');
  if (sn) {
    L.push(...rsiLines(sn, s));
    if (sn.level) { L.push(''); L.push(levelLine(sn, s)); }
  } else {
    L.push(m.loading ? '<i>RSI verisi yükleniyor (bot yeni başladı)</i>' : '<i>İzlenen listede değil (24 saatlik hacim eşiğin altında)</i>');
  }
  L.push(['#HAREKET', `#DERECE${m.grade || 1}`, up ? '#YUKSELIS' : '#DUSUS', m.followed ? '#TAKIP' : null].filter(Boolean).join(' '));
  const keyboard = [
    tgLinks(m.symbol),
    [
      { text: '🔕 1s sustur', callback_data: `m:${m.symbol}` },
      { text: m.followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${m.symbol}` },
    ],
  ];
  return { text: `${head}\n<blockquote expandable>${L.join('\n')}</blockquote>`, keyboard };
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

module.exports = { formatCard, formatMove, summaryText, toPlain, esc, hhmm, dayTime, px, pct, usd };
