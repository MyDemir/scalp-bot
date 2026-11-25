'use strict';

/**
 * Fiyat yapısı ölçümleri — dip defteri (src/dipLog.js) ve destek teması (src/supportTouch.js) fotoğrafı için.
 * Saf fonksiyonlar; yalnız KAPANMIŞ mumlar (series.col(tf, x, false)); look-ahead yok; coin başına dizi/önbellek tutulmaz.
 * Kartı, dereceyi ve tepeler.csv'yi ETKİLEMEZ.
 *
 *   Market yapısı (5m, 15m, 1h): pivot = solundaki 3 kapanmış mumdan kesin, sağındaki 3 mumdan eşit ya da yüksek (tepe) / düşük (dip); pivot ancak
 *     3 mum sonra kesinleşir. ms_<tf>: son iki pivot tepe ve dip → 'HH-HL' (yükselen) · 'LH-LL' (düşen) · 'karışık' ·
 *     bos_<tf>: son yapı kırılımı ('up' = kapanış o an bilinen son pivot tepenin üstünde, 'down' = son pivot dibin altında; her pivot
 *     bir kez kırılır) · bosMin_<tf>: kırılım mumunun kapanışından bu yana dk · choch_<tf>: 1 = son kırılım bir öncekinin tersi
 *   Formasyon (15m, 5m): dblBot_<tf> (son 40 mumdaki son iki pivot dip arası fark ≤ %0.5 ve aralarında ≥ %1 tepki) · hl_<tf> (son
 *     pivot dip bir öncekinden yüksek) · dblTop_<tf> (aynası: iki pivot tepe ≤ %0.5, arada ≥ %1 geri çekilme)
 *   FVG (5m, 15m, 1h; son 100 kapanmış mum): boğa = mum i'nin low'u > mum i−2'nin high'ı (boşluk [h(i−2), l(i)]); ayı tersi.
 *     Doldurulmamış = sonraki mumlardan hiçbiri boşluğu tamamen kapatmadı. fvgBullDist_<tf> (fiyatın altındaki en yakın boğa
 *     FVG'nin üst kenarına %), fvgBullSize_<tf> (boşluk boyu %), fvgBullAge_<tf> (mum), inFvgBull_<tf> (fiyat bir boğa FVG içinde
 *     1/0), fvgBearDist_<tf> (üstteki en yakın ayı FVG'nin alt kenarına %)
 *   EMA21/EMA50 (1m, 3m): e2150_<tf> (1: EMA21 > EMA50), e2150X_<tf> (son kesişimden bu yana mum; + yukarı, − aşağı kesişim),
 *     e2150Gap_<tf> (%(EMA21−EMA50)/EMA50). Seri yetersizse null.
 *   Ichimoku Tenkan(9)/Kijun(26) (5m, 15m, 1h): Tenkan = (9 mumun en yüksek + en düşük)/2, Kijun aynı 26 mum. tk_<tf> (1: Tenkan >
 *     Kijun), tkX_<tf> (son kesişimden bu yana mum; + yukarı, − aşağı), tkGap_<tf> (%(Tenkan−Kijun)/Kijun), tkCloud_<tf> (son kapanış
 *     buluta göre 'üst' / 'içinde' / 'alt'; bulut = 26 mum önce hesaplanan Senkou A = (Tenkan+Kijun)/2 ve Senkou B = 52 mum orta
 *     noktası). Mevcut ichiPos/ichiDist (peakFeatures, 1h 10/30/60 ayarlı) DEĞİŞMEDİ.
 */

const ta = require('./ta');

const MIN = 60_000;
const TF_MIN = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
const PIV = 3, LOOK = 200, FORM_N = 40, FVG_N = 100;
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));

/** Kesinleşmiş pivotlar (i ≤ n−1−PIV) */
function pivots(h, l, from) {
  const n = h.length, hi = [], lo = [];
  for (let i = Math.max(from, PIV); i <= n - 1 - PIV; i++) {
    let isH = true, isL = true;
    for (let j = i - PIV; j <= i + PIV && (isH || isL); j++) {
      if (j === i) continue;
      // eşit tepede ilki pivot: solda kesin büyük, sağda büyük-eşit
      if (j < i ? h[j] >= h[i] : h[j] > h[i]) isH = false;
      if (j < i ? l[j] <= l[i] : l[j] < l[i]) isL = false;
    }
    if (isH) hi.push(i);
    if (isL) lo.push(i);
  }
  return { hi, lo };
}

function structureTf(series, tf, nowT) {
  const h = series.col(tf, 'h', false), l = series.col(tf, 'l', false), c = series.col(tf, 'c', false), t = series.col(tf, 't', false);
  const n = c.length, from = Math.max(0, n - LOOK);
  const out = { [`ms_${tf}`]: null, [`bos_${tf}`]: null, [`bosMin_${tf}`]: null, [`choch_${tf}`]: null };
  if (n < 2 * PIV + 2) return { out, pv: { hi: [], lo: [] }, h, l };
  const pv = pivots(h, l, from);
  if (pv.hi.length >= 2 && pv.lo.length >= 2) {
    const hh = h[pv.hi[pv.hi.length - 1]] > h[pv.hi[pv.hi.length - 2]], hl = l[pv.lo[pv.lo.length - 1]] > l[pv.lo[pv.lo.length - 2]];
    out[`ms_${tf}`] = hh && hl ? 'HH-HL' : !hh && !hl ? 'LH-LL' : 'karışık';
  }
  // Kırılımlar: k. mumda o an KESİNLEŞMİŞ (i + PIV ≤ k − 1... yani i + PIV < k) son pivot tepe / dip; her pivot bir kez kırılır
  const breaks = [];
  let ph = -1, pl = -1, ah = 0, al = 0, brokeH = -1, brokeL = -1;
  for (let k = from; k < n; k++) {
    while (ah < pv.hi.length && pv.hi[ah] + PIV < k) ph = pv.hi[ah++];
    while (al < pv.lo.length && pv.lo[al] + PIV < k) pl = pv.lo[al++];
    if (ph >= 0 && ph !== brokeH && c[k] > h[ph]) { breaks.push({ dir: 'up', k }); brokeH = ph; }
    if (pl >= 0 && pl !== brokeL && c[k] < l[pl]) { breaks.push({ dir: 'down', k }); brokeL = pl; }
  }
  if (breaks.length) {
    const b = breaks[breaks.length - 1];
    out[`bos_${tf}`] = b.dir;
    out[`bosMin_${tf}`] = Math.round((nowT - (t[b.k] + TF_MIN[tf] * MIN)) / MIN);
    out[`choch_${tf}`] = breaks.length >= 2 ? (breaks[breaks.length - 2].dir !== b.dir ? 1 : 0) : null;
  }
  return { out, pv, h, l };
}

function formation(tf, st) {
  const { pv, h, l } = st, n = h.length, lim = n - FORM_N;
  const out = { [`dblBot_${tf}`]: null, [`hl_${tf}`]: null, [`dblTop_${tf}`]: null };
  if (!n) return out;
  const lo = pv.lo, hi = pv.hi;
  if (lo.length >= 2) {
    const a = lo[lo.length - 2], b = lo[lo.length - 1];
    out[`hl_${tf}`] = l[b] > l[a] ? 1 : 0;
    let top = -Infinity; for (let i = a + 1; i < b; i++) if (h[i] > top) top = h[i];
    out[`dblBot_${tf}`] = a >= lim && Math.abs(l[b] - l[a]) / l[a] <= 0.005 && top >= Math.max(l[a], l[b]) * 1.01 ? 1 : 0;
  }
  if (hi.length >= 2) {
    const a = hi[hi.length - 2], b = hi[hi.length - 1];
    let bot = Infinity; for (let i = a + 1; i < b; i++) if (l[i] < bot) bot = l[i];
    out[`dblTop_${tf}`] = a >= lim && Math.abs(h[b] - h[a]) / h[a] <= 0.005 && bot <= Math.min(h[a], h[b]) * 0.99 ? 1 : 0;
  }
  return out;
}

function fvgTf(series, tf, price) {
  const h = series.col(tf, 'h', false), l = series.col(tf, 'l', false), n = h.length;
  const out = { [`fvgBullDist_${tf}`]: null, [`fvgBullSize_${tf}`]: null, [`fvgBullAge_${tf}`]: null, [`inFvgBull_${tf}`]: null, [`fvgBearDist_${tf}`]: null };
  if (n < 3 || !(price > 0)) return out;
  // sondan geriye: i'den sonraki mumların en düşük low / en yüksek high'ı (doldurulma kontrolü)
  let minAfter = Infinity, maxAfter = -Infinity, bull = null, bear = null, inBull = 0;
  for (let i = n - 1; i >= Math.max(2, n - FVG_N); i--) {
    if (l[i] > h[i - 2] && !(minAfter <= h[i - 2])) {                 // boğa, doldurulmamış
      const bot = h[i - 2], top = l[i];
      if (price >= bot && price <= top) inBull = 1;
      if (top < price && (!bull || top > bull.top)) bull = { top, bot, age: n - 1 - i };
    }
    if (h[i] < l[i - 2] && !(maxAfter >= l[i - 2])) {                 // ayı, doldurulmamış
      const bot = h[i];
      if (bot > price && (!bear || bot < bear.bot)) bear = { bot };
    }
    if (l[i] < minAfter) minAfter = l[i];
    if (h[i] > maxAfter) maxAfter = h[i];
  }
  out[`inFvgBull_${tf}`] = inBull;
  if (bull) { out[`fvgBullDist_${tf}`] = num((price - bull.top) / price * 100, 3); out[`fvgBullSize_${tf}`] = num((bull.top - bull.bot) / bull.bot * 100, 3); out[`fvgBullAge_${tf}`] = bull.age; }
  if (bear) out[`fvgBearDist_${tf}`] = num((bear.bot - price) / price * 100, 3);
  return out;
}

function emaCross(series, tf) {
  const c = series.col(tf, 'c', false), n = c.length;
  const out = { [`e2150_${tf}`]: null, [`e2150X_${tf}`]: null, [`e2150Gap_${tf}`]: null };
  if (n < 51) return out;
  const e21 = ta.emaSeries(c, 21), e50 = ta.emaSeries(c, 50);
  const d = i => e21[i - 20] - e50[i - 49];          // c indeksi i (i ≥ 49)
  const last = d(n - 1), e50l = e50[n - 50];
  out[`e2150_${tf}`] = last > 0 ? 1 : 0;
  out[`e2150Gap_${tf}`] = e50l > 0 ? num(last / e50l * 100, 3) : null;
  for (let i = n - 1; i > 49; i--) {
    if ((d(i) > 0) !== (d(i - 1) > 0)) { out[`e2150X_${tf}`] = (d(i) > 0 ? 1 : -1) * (n - 1 - i); break; }
  }
  return out;
}

function mid(h, l, len, end) {
  if (end - len + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = end - len + 1; i <= end; i++) { if (h[i] > hi) hi = h[i]; if (l[i] < lo) lo = l[i]; }
  return (hi + lo) / 2;
}
function tkCross(series, tf) {
  const h = series.col(tf, 'h', false), l = series.col(tf, 'l', false), c = series.col(tf, 'c', false), n = c.length;
  const out = { [`tk_${tf}`]: null, [`tkX_${tf}`]: null, [`tkGap_${tf}`]: null, [`tkCloud_${tf}`]: null };
  if (n < 26) return out;
  const d = i => mid(h, l, 9, i) - mid(h, l, 26, i);
  const kj = mid(h, l, 26, n - 1), last = d(n - 1);
  out[`tk_${tf}`] = last > 0 ? 1 : 0;
  out[`tkGap_${tf}`] = kj > 0 ? num(last / kj * 100, 3) : null;
  for (let i = n - 1; i > 25 && i > n - 1 - LOOK; i--) {
    if ((d(i) > 0) !== (d(i - 1) > 0)) { out[`tkX_${tf}`] = (d(i) > 0 ? 1 : -1) * (n - 1 - i); break; }
  }
  const k = n - 1 - 26;                                // bulut: 26 mum önce hesaplanan Senkou A / B
  if (k >= 51) {
    const A = (mid(h, l, 9, k) + mid(h, l, 26, k)) / 2, B = mid(h, l, 52, k), p = c[n - 1];
    out[`tkCloud_${tf}`] = p > Math.max(A, B) ? 'üst' : p < Math.min(A, B) ? 'alt' : 'içinde';
  }
  return out;
}

/** Tüm yapı alanları (STRUCT_COLS sırasıyla) */
function structureFeatures(series, price = series.price(), nowT = (series.lastT('1m') ?? 0) + MIN) {
  const out = {};
  const st = {};
  for (const tf of ['5m', '15m', '1h']) { st[tf] = structureTf(series, tf, nowT); Object.assign(out, st[tf].out); }
  for (const tf of ['15m', '5m']) Object.assign(out, formation(tf, st[tf]));
  for (const tf of ['5m', '15m', '1h']) Object.assign(out, fvgTf(series, tf, price));
  for (const tf of ['1m', '3m']) Object.assign(out, emaCross(series, tf));
  for (const tf of ['5m', '15m', '1h']) Object.assign(out, tkCross(series, tf));
  return out;
}
const STRUCT_COLS = [
  ...['5m', '15m', '1h'].flatMap(tf => [`ms_${tf}`, `bos_${tf}`, `bosMin_${tf}`, `choch_${tf}`]),
  ...['15m', '5m'].flatMap(tf => [`dblBot_${tf}`, `hl_${tf}`, `dblTop_${tf}`]),
  ...['5m', '15m', '1h'].flatMap(tf => [`fvgBullDist_${tf}`, `fvgBullSize_${tf}`, `fvgBullAge_${tf}`, `inFvgBull_${tf}`, `fvgBearDist_${tf}`]),
  ...['1m', '3m'].flatMap(tf => [`e2150_${tf}`, `e2150X_${tf}`, `e2150Gap_${tf}`]),
  ...['5m', '15m', '1h'].flatMap(tf => [`tk_${tf}`, `tkX_${tf}`, `tkGap_${tf}`, `tkCloud_${tf}`]),
];

module.exports = { structureFeatures, STRUCT_COLS, pivots, structureTf, formation, fvgTf, emaCross, tkCross };
