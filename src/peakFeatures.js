'use strict';

/**
 * Tepe anı için ek (maliyetsiz) özellikler — yalnız bellekteki mumlardan, istatistik kaydı için. Kartı ETKİLEMEZ.
 *
 *   CVD        : taker alış − satış farkı (1m). cvdNet15/60 = pencerenin net akışı / hacmi (%) · cvdDiv = fiyat son 60 dk'nın
 *                önceki tepesini geçti ama kümülatif CVD o tepedekinin altında (alıcı yorgunluğu) · buyChg = son 5 dk alış %'i
 *                − önceki 10 dk (puan)
 *   Mum yapısı : 1m / 5m / 15m son mum (devam eden dahil): üst fitil / boy (wick), kapanışın mum içindeki yeri (clv: 0 dip,
 *                1 tepe), gövde % · art arda yeşil 1m / 5m mum sayısı
 *   Hacim      : volTrend15 = son 15 dk hacmi / önceki 15 dk · volPeakX = tepe 1m mumunun hacmi / pompa boyunca 1m ortalaması
 *   Uyumsuzluk : negatif tepe (fiyat ≥ önceki tepe, RSI <) sayısı 5m / 15m / 1h
 *   Bollinger  : (20, 2σ) 5m / 15m / 1h — %B (1 üstü = üst bandın dışında) ve bant genişliği (% orta banda)
 *   Hız        : spd15 / spdPrev15 = son 15 dk ve ondan önceki 15 dk'nın dakikalık % artışı · accel = farkı ·
 *                pumpAtr = pompa % / 1h ATR %
 *   Piyasa     : ctx.market() → breadth80 (evrende 15m RSI ≥ 80 coin %), pumping (60 dk'da ≥ %3 yükselen coin sayısı),
 *                BTC 5/15 dk değişim, BTC 15m RSI (backtest'te yok)
 *   Zaman      : TSİ saat, haftanın günü (1 Pzt … 7 Paz), seans (UTC: Asya 00–07 · Avrupa 07–13 · ABD 13–21 · Gece 21–24),
 *                funding'e kalan dk
 *   Coin       : ageDays (bellekteki günlük mum, en fazla 400), athDist (400 günün tepesine %), fromLow30 (30 gün dibinden %)
 *   Büyük resim: dayChg (UTC gün açılışından %), dayPos (gün aralığında yer 0–1), 1h/4h EMA50–EMA200 yönü ve fiyatın EMA200'e
 *                uzaklığı, 1h Ichimoku bulutuna göre yer (üst/içi/alt) ve uzaklık
 */

const ta = require('./ta');
const { negPeaks } = require('./infoEngine');

const MIN = 60_000, DAY = 86_400_000;
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const TZ = process.env.DISPLAY_TZ || 'Europe/Istanbul';

let hourFmt = null, dowFmt = null;
function localHourDow(t) {
  try {
    hourFmt = hourFmt || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
    dowFmt = dowFmt || new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short' });
    const h = Number(hourFmt.format(new Date(t)));
    const dow = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[dowFmt.format(new Date(t))];
    return { hour: h, dow };
  } catch { const d = new Date(t + 3 * 3_600_000); return { hour: d.getUTCHours(), dow: d.getUTCDay() || 7 }; }
}
function session(t) {
  const h = new Date(t).getUTCHours();
  return h < 7 ? 'Asya' : h < 13 ? 'Avrupa' : h < 21 ? 'ABD' : 'Gece';
}

function sum(a, from, to) { let s = 0; for (let i = Math.max(0, from); i < to; i++) s += a[i]; return s; }

// "Son N dakika" pencereleri ZAMANA göre (dizi indeksine göre değil): 1m akışında kayıp mum varsa pencere N dk'dan uzamaz.
// Pencere = açılış zamanı [tLast − from·MIN, tLast − to·MIN] aralığındaki mumlar (from ≥ to; dakika sayısı from − to + 1).
// Dönen: a..b = dizi aralığı (dahil), found = bulunan mum, ok = found ≥ ceil(len/2) (K16 kuralı; len = serinin başına kırpılmış
// dakika sayısı, yani boşluksuz akışta eski indeks tanımıyla birebir aynı küme). Yetersizse ok=false → alan null.
function minWin(d, from, to = 0) {
  const n = d.t.length;
  if (!n) return { a: 0, b: -1, found: 0, ok: false };
  const tL = d.t[n - 1], lo = tL - from * MIN, hi = tL - to * MIN;
  let b = n - 1;
  while (b >= 0 && d.t[b] > hi) b--;
  let a = b;
  while (a >= 0 && d.t[a] >= lo) a--;
  a++;
  const found = Math.max(0, b - a + 1);
  const len = Math.floor((hi - Math.max(lo, d.t[0])) / MIN) + 1;
  return { a, b, found, ok: found > 0 && found >= Math.ceil(len / 2) };
}
const sumW = (arr, w) => { let s = 0; for (let i = w.a; i <= w.b; i++) s += arr[i]; return s; };
// tLast − back·MIN açılışlı mumun dizin sayısı (yoksa −1)
function idxAt(d, back) {
  const n = d.t.length, tt = d.t[n - 1] - back * MIN;
  for (let i = n - 1; i >= 0 && d.t[i] >= tt; i--) if (d.t[i] === tt) return i;
  return -1;
}

function cvdFeatures(d) {
  const n = d.c.length;
  if (n < 30) return {};
  const net = i => 2 * d.tq[i] - d.q[i];
  const netSum = w => { let x = 0; for (let i = w.a; i <= w.b; i++) x += net(i); return x; };
  const ratio = N => { const w = minWin(d, N - 1); if (!w.ok) return null; const q = sumW(d.q, w); return q > 0 ? netSum(w) / q * 100 : null; };
  // önceki tepe: son 60 dk, son 5 dk hariç → açılış [tLast−59dk, tLast−5dk]; kümülatif CVD farkı = tepeden sonraki net akış
  const pw = minWin(d, 59, 5);
  let j = -1;
  if (pw.ok) for (let i = pw.a; i <= pw.b; i++) if (j < 0 || d.h[i] > d.h[j]) j = i;
  const div = pw.ok ? j >= 0 && d.h[n - 1] >= d.h[j] && (() => { let x = 0; for (let i = j + 1; i < n; i++) x += net(i); return x < 0; })() : null;
  const w60 = minWin(d, 59), q60 = w60.ok ? sumW(d.q, w60) : 0;
  const buy = w => { if (!w.ok) return null; const q = sumW(d.q, w); return q > 0 ? sumW(d.tq, w) / q * 100 : null; };
  const b5 = buy(minWin(d, 4)), b10 = buy(minWin(d, 14, 5));
  let dp = null;
  if (j >= 0 && q60 > 0) { let x = 0; for (let i = j + 1; i < n; i++) x += net(i); dp = num(x / q60 * 100, 1); }
  return {
    cvdNet15: num(ratio(15), 1), cvdNet60: num(ratio(60), 1), cvdDiv: div === null ? null : Boolean(div),
    cvdDivPct: dp,
    buyChg: b5 != null && b10 != null ? num(b5 - b10, 1) : null,
  };
}

function candleOf(series, tf) {
  const o = series.col(tf, 'o', true), h = series.col(tf, 'h', true), l = series.col(tf, 'l', true), c = series.col(tf, 'c', true);
  const n = c.length;
  if (!n) return {};
  const R = h[n - 1] - l[n - 1];
  return {
    [`wick_${tf}`]: R > 0 ? num((h[n - 1] - Math.max(o[n - 1], c[n - 1])) / R, 2) : null,
    [`clv_${tf}`]: R > 0 ? num((c[n - 1] - l[n - 1]) / R, 2) : null,
    [`body_${tf}`]: o[n - 1] > 0 ? num((c[n - 1] - o[n - 1]) / o[n - 1] * 100, 2) : null,
  };
}
// Son KAPANMIŞ mumdan fitil / kapanış yeri (candleOf kısmi mumludur; bunlar K21 için)
function candleClosed(series, tf) {
  const h = series.col(tf, 'h', false), l = series.col(tf, 'l', false), o = series.col(tf, 'o', false), c = series.col(tf, 'c', false);
  const n = c.length;
  if (!n) return {};
  const R = h[n - 1] - l[n - 1];
  return {
    [`wick_${tf}c`]: R > 0 ? num((h[n - 1] - Math.max(o[n - 1], c[n - 1])) / R, 2) : null,
    [`clv_${tf}c`]: R > 0 ? num((c[n - 1] - l[n - 1]) / R, 2) : null,
  };
}
// Devam eden mumun ilerlemesi (0–100): t tepe anı (son 1m kapanışı). t mum sınırındaysa son mum az önce kapandı → 100
function barPct(t, ms) { return t % ms === 0 ? 100 : num((t % ms) / ms * 100, 1); }

function greens(series, tf) {
  const o = series.col(tf, 'o', false), c = series.col(tf, 'c', false);
  let k = 0;
  for (let i = c.length - 1; i >= 0 && c[i] > o[i]; i--) k++;
  return k;
}

function bollinger(series, tf, n = 20, m = 2) {
  const c = series.col(tf, 'c', true);
  if (c.length < n) return {};
  const w = c.slice(-n), mid = w.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / n);
  const up = mid + m * sd, lo = mid - m * sd, p = c[c.length - 1];
  return { [`bbB_${tf}`]: up > lo ? num((p - lo) / (up - lo), 2) : null, [`bbW_${tf}`]: mid > 0 ? num((up - lo) / mid * 100, 2) : null };
}

function emaTrend(series, tf, price) {
  const c = series.col(tf, 'c', true);
  if (c.length < 200) return { [`trend_${tf}`]: null, [`ema200_${tf}`]: null };
  const e50 = ta.emaLast(c, 50), e200 = ta.emaLast(c, 200);
  return { [`trend_${tf}`]: e50 > e200 ? 'yukarı' : 'aşağı', [`ema200_${tf}`]: num((price - e200) / e200 * 100) };
}

function midline(h, l, n, end) {
  if (end - n + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let i = end - n + 1; i <= end; i++) { if (h[i] > hi) hi = h[i]; if (l[i] < lo) lo = l[i]; }
  return (hi + lo) / 2;
}
function ichiCloud(series, s, price) {
  const h = series.col('1h', 'h', true), l = series.col('1h', 'l', true);
  const tk = s.ichiTenkan || 10, kj = s.ichiKijun || 30, sb = s.ichiSenkouB || 60, sh = s.ichiShift || 30;
  const k = h.length - 1 - sh;                       // bulutun bugünkü değeri, sh mum önce hesaplanır
  if (k < sb) return { ichiPos: null, ichiDist: null };
  const t = midline(h, l, tk, k), kjv = midline(h, l, kj, k), A = (t + kjv) / 2, B = midline(h, l, sb, k);
  const top = Math.max(A, B), bot = Math.min(A, B);
  if (price > top) return { ichiPos: 'üst', ichiDist: num((price - top) / top * 100) };
  if (price < bot) return { ichiPos: 'alt', ichiDist: num((price - bot) / bot * 100) };
  return { ichiPos: 'içi', ichiDist: 0 };
}

/**
 * @param {object} o  { s, ctx, price, t, pumpPct, pumpMin, atr1h, funding, history }
 *   history: { samples24h, drops24h, cards24h, lastOutcome, minsSinceDrop } (eventLog'dan)
 */
function extraFeatures(series, o = {}) {
  const { s = {}, ctx = {}, price = series.price(), t = (series.lastT('1m') ?? 0) + MIN, pumpPct = null, pumpMin = null } = o;
  const d = series.d['1m'];
  const n = d.c.length;
  const out = {};
  Object.assign(out, { cvdNet15: null, cvdNet60: null, cvdDiv: null, cvdDivPct: null, buyChg: null }, cvdFeatures(d));
  for (const tf of ['1m', '5m', '15m']) Object.assign(out, { [`wick_${tf}`]: null, [`clv_${tf}`]: null, [`body_${tf}`]: null }, candleOf(series, tf));
  out.greens_1m = greens(series, '1m'); out.greens_5m = greens(series, '5m');
  { const w1 = minWin(d, 14), w2 = minWin(d, 29, 15);
    const q15 = w1.ok ? sumW(d.q, w1) : null, qp = w2.ok ? sumW(d.q, w2) : null;
    out.volTrend15 = q15 != null && qp > 0 ? num(q15 / qp) : null; }
  const pm = Math.max(5, Math.min(240, pumpMin || 60));
  { const w = minWin(d, pm - 1);   // payda: pencerede eksik dakika varsa onlar paydan düşer (boşluksuz akışta pm)
    const len = Math.floor((d.t[n - 1] - Math.max(d.t[n - 1] - (pm - 1) * MIN, d.t[0])) / MIN) + 1;
    const avgPump = w.ok ? sumW(d.q, w) / (pm - (len - w.found)) : 0;
    out.volPeakX = avgPump > 0 ? num(d.q[n - 1] / avgPump) : null; }
  // H46 K19: payda gerçekte toplanan mum sayısı; tepe (son) mum paydan hariç
  { const w = pm > 1 ? minWin(d, pm - 1, 1) : { ok: false }, cnt = w.ok ? w.found : 0;
    out.volPeakXc = cnt > 0 && sumW(d.q, w) > 0 ? num(d.q[n - 1] / (sumW(d.q, w) / cnt)) : null; }
  // H46 K20/K22: pencere [t−60dk, t) — spot (marketData endTime=t−1, 60 mum) ile AYNI aralık: açılış zamanı t−60dk … t−1dk
  // (tepe mumu dahil, t'de açılan mum yok). miss60 = 60 − aralıktaki 1m mum sayısı; futQ60t = aralıktaki 1m quote toplamı
  { let cnt = 0, fq = 0;
    for (let i = n - 1; i >= 0 && d.t[i] >= t - 60 * MIN; i--) if (d.t[i] < t) { cnt++; fq += d.q[i]; }
    out.miss60 = 60 - cnt; out.futQ60t = num(fq, 2); }
  for (const tf of ['5m', '15m']) Object.assign(out, { [`wick_${tf}c`]: null, [`clv_${tf}c`]: null }, candleClosed(series, tf));
  out.bar5Pct = barPct(t, 5 * MIN); out.bar15Pct = barPct(t, 15 * MIN);
  for (const [tf, k] of [['5m', 'neg5'], ['15m', 'neg15'], ['1h', 'neg1h']]) out[k] = negPeaks(series, tf, 40, s.rsiPeriod || 14)?.count ?? null;
  for (const tf of ['5m', '15m', '1h']) Object.assign(out, { [`bbB_${tf}`]: null, [`bbW_${tf}`]: null }, bollinger(series, tf));
  const c = d.c;
  // t−15 / t−30 dk açılışlı mum yoksa (boşluk) null; indeks 0 (serinin ilk mumu) eski tanımda da dışarıda
  const i15 = n ? idxAt(d, 15) : -1, i30 = n ? idxAt(d, 30) : -1;
  out.spd15 = i15 >= 1 ? num((c[n - 1] / c[i15] - 1) * 100 / 15, 3) : null;
  out.spdPrev15 = i15 >= 1 && i30 >= 1 ? num((c[i15] / c[i30] - 1) * 100 / 15, 3) : null;
  out.accel = out.spd15 != null && out.spdPrev15 != null ? num(out.spd15 - out.spdPrev15, 3) : null;
  out.pumpAtr = pumpPct != null && o.atr1h > 0 ? num(pumpPct / o.atr1h, 1) : null;
  const mk = ctx.market ? ctx.market(t) : null;
  out.breadth80 = mk?.breadth80 ?? null; out.pumping = mk?.pumping ?? null;
  out.btc5 = mk?.btc5 ?? null; out.btc15 = mk?.btc15 ?? null; out.btcRsi15 = mk?.btcRsi15 ?? null;
  const ld = localHourDow(t);
  out.hourTR = ld.hour; out.dow = ld.dow; out.session = session(t);
  out.minToFunding = o.funding?.next ? Math.round((o.funding.next - t) / MIN) : null;
  const D = series.d['1d'];
  out.ageDays = D.t.length;
  const hi400 = D.h.length ? Math.max(...D.h, series.part?.['1d']?.h ?? -Infinity) : null;
  out.athDist = hi400 > 0 ? num((price / hi400 - 1) * 100) : null;
  const lo30 = D.l.length ? Math.min(...D.l.slice(-30)) : null;
  out.fromLow30 = lo30 > 0 ? num((price / lo30 - 1) * 100) : null;
  // Gün (UTC): devam eden günlük mum; yoksa 15m mumlardan
  let pd = series.part?.['1d'];
  if (!pd) {
    const dayStart = Math.floor(t / DAY) * DAY - (t % DAY === 0 ? DAY : 0);
    const t15 = series.col('15m', 't', true), o15 = series.col('15m', 'o', true), h15 = series.col('15m', 'h', true), l15 = series.col('15m', 'l', true);
    let i0 = t15.findIndex(x => x >= dayStart);
    if (i0 >= 0) pd = { o: o15[i0], h: Math.max(...h15.slice(i0)), l: Math.min(...l15.slice(i0)) };
  }
  const dayOpen = pd ? pd.o : null, dayH = pd ? Math.max(pd.h, price) : null, dayL = pd ? Math.min(pd.l, price) : null;
  out.dayChg = dayOpen > 0 ? num((price / dayOpen - 1) * 100) : null;
  out.dayPos = dayH > dayL ? num((price - dayL) / (dayH - dayL), 2) : null;
  Object.assign(out, emaTrend(series, '1h', price), emaTrend(series, '4h', price), ichiCloud(series, s, price));
  const h = o.history || {};
  out.samples24h = h.samples24h ?? null; out.drops24h = h.drops24h ?? null; out.cards24h = h.cards24h ?? null;
  out.lastOutcome = h.lastOutcome ?? null; out.minsSinceDrop = h.minsSinceDrop ?? null;
  return out;
}

/**
 * Boğa CVD ayrışması (dip defteri; cvdDiv'in aynası, cvdDiv'in anlamı değişmez): fiyat son 60 dk'nın önceki dibine
 * (açılış [tLast−59dk, tLast−5dk]) indi ya da altına geçti ama o dipten bu yana net taker akışı pozitif (kümülatif CVD
 * o dipteki seviyenin üstünde). Pencere yetersizse null.
 */
function cvdDivBull(d) {
  const n = d.c.length;
  if (n < 30) return null;
  const pw = minWin(d, 59, 5);
  if (!pw.ok) return null;
  let j = -1;
  for (let i = pw.a; i <= pw.b; i++) if (j < 0 || d.l[i] < d.l[j]) j = i;
  if (j < 0 || !(d.l[n - 1] <= d.l[j])) return false;
  let x = 0; for (let i = j + 1; i < n; i++) x += 2 * d.tq[i] - d.q[i];
  return x > 0;
}

/** Coin büyüklüğü: son 24 KAPANMIŞ 1h mumun quote hacmi toplamı (USDT); 24 mum yoksa null */
function quoteVol24h(series) {
  const q = series.col('1h', 'q', false), n = q.length;
  if (n < 24) return null;
  let s = 0; for (let i = n - 24; i < n; i++) s += q[i];
  return num(s, 0);
}

const EXTRA_COLS = ['cvdNet15', 'cvdNet60', 'cvdDiv', 'cvdDivPct', 'buyChg', 'wick_1m', 'clv_1m', 'body_1m', 'wick_5m', 'clv_5m', 'body_5m',
  'wick_15m', 'clv_15m', 'body_15m', 'greens_1m', 'greens_5m', 'volTrend15', 'volPeakX', 'neg5', 'neg15', 'neg1h', 'bbB_5m', 'bbW_5m',
  'bbB_15m', 'bbW_15m', 'bbB_1h', 'bbW_1h', 'spd15', 'spdPrev15', 'accel', 'pumpAtr', 'breadth80', 'pumping', 'btc5', 'btc15', 'btcRsi15',
  'hourTR', 'dow', 'session', 'minToFunding', 'ageDays', 'athDist', 'fromLow30', 'dayChg', 'dayPos', 'trend_1h', 'ema200_1h', 'trend_4h',
  'ema200_4h', 'ichiPos', 'ichiDist', 'samples24h', 'drops24h', 'cards24h', 'lastOutcome', 'minsSinceDrop'];

// Sona eklenen kolonlar (eventLog AUDIT_COLS'ta; EXTRA_COLS sırası değişmez)
const EXTRA_AUDIT_COLS = ['wick_5mc', 'clv_5mc', 'wick_15mc', 'clv_15mc', 'bar5Pct', 'bar15Pct', 'volPeakXc', 'miss60', 'futQ60t'];

/**
 * v3 kurulum puanının 5 girdisi (rsi_1m, bbB_15m, stochCross, volx_3m, liqShortPct15) — yalnız gerekli alanlar, tüm TF'leri hesaplamaz.
 * Kart anı (infoEngine.v3Of) ve tepe kaydı aynı tanımı kullanır: rsi_1m = marketSnap.tfIndicators, bbB_15m = extraFeatures (bollinger),
 * volx_3m = marketSnap.lastClosedVol, stochCross = evaluate().stoch.cross, liq = ctx.liq(sym, t, son 15 dk 1m quote). Yalnız kapanmış/eldeki mumlar (look-ahead yok).
 * @param {object} [o] { snap, t }  snap.stoch varsa yeniden hesaplanmaz; t = serinin son 1m açılışı + 1 dk
 */
function v3Features(series, s = {}, ctx = {}, o = {}) {
  const { lastClosedVol } = require('./marketSnap');   // tembel: marketSnap ↔ infoEngine ↔ peakFeatures döngüsü
  const { stochState } = require('./infoEngine');
  const t = o.t ?? (series.lastT('1m') ?? 0) + MIN;
  const d = series.d['1m'], n = d.q.length;
  const st = o.snap && o.snap.stoch !== undefined ? o.snap.stoch : stochState(series, '5m');
  let liqShortPct15 = null;
  if (ctx.liq) { let q15 = 0; for (let i = Math.max(0, n - 15); i < n; i++) q15 += d.q[i]; liqShortPct15 = ctx.liq(series.symbol, t, q15).liqShortPct15 ?? null; }
  return {
    rsi_1m: num(ta.rsiLast(series.col('1m', 'c', true), s.rsiPeriod || 14), 1),
    bbB_15m: bollinger(series, '15m').bbB_15m ?? null,
    stochCross: st?.cross ?? null,
    volx_3m: num(lastClosedVol(series, '3m').x),
    liqShortPct15,
  };
}

module.exports = { v3Features, cvdDivBull, quoteVol24h, extraFeatures, EXTRA_COLS, EXTRA_AUDIT_COLS, emaTrend, cvdFeatures, minWin, bollinger, ichiCloud, session, localHourDow };
