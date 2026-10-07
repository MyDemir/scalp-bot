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

function cvdFeatures(d) {
  const n = d.c.length;
  if (n < 30) return {};
  const net = i => 2 * d.tq[i] - d.q[i];
  const ratio = w => { const q = sum(d.q, n - w, n); let x = 0; for (let i = Math.max(0, n - w); i < n; i++) x += net(i); return q > 0 ? x / q * 100 : null; };
  // kümülatif CVD (son 120 dk) ve önceki tepe (son 60 dk, son 5 dk hariç)
  const from = Math.max(0, n - 120);
  const cvd = []; let acc = 0;
  for (let i = from; i < n; i++) { acc += net(i); cvd.push(acc); }
  let j = -1;
  for (let i = Math.max(from, n - 60); i < n - 5; i++) if (j < 0 || d.h[i] > d.h[j]) j = i;
  const div = j >= 0 && d.h[n - 1] >= d.h[j] && cvd[n - 1 - from] < cvd[j - from];
  const q60 = sum(d.q, n - 60, n);
  const buy = (a, b) => { const q = sum(d.q, a, b); return q > 0 ? sum(d.tq, a, b) / q * 100 : null; };
  const b5 = buy(n - 5, n), b10 = buy(n - 15, n - 5);
  return {
    cvdNet15: num(ratio(15), 1), cvdNet60: num(ratio(60), 1), cvdDiv: Boolean(div),
    cvdDivPct: j >= 0 && q60 > 0 ? num((cvd[n - 1 - from] - cvd[j - from]) / q60 * 100, 1) : null,
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
  const q15 = sum(d.q, n - 15, n), qp = sum(d.q, n - 30, n - 15);
  out.volTrend15 = qp > 0 ? num(q15 / qp) : null;
  const pm = Math.max(5, Math.min(240, pumpMin || 60));
  const avgPump = sum(d.q, n - pm, n) / pm;
  out.volPeakX = avgPump > 0 ? num(d.q[n - 1] / avgPump) : null;
  for (const [tf, k] of [['5m', 'neg5'], ['15m', 'neg15'], ['1h', 'neg1h']]) out[k] = negPeaks(series, tf, 40, s.rsiPeriod || 14)?.count ?? null;
  for (const tf of ['5m', '15m', '1h']) Object.assign(out, { [`bbB_${tf}`]: null, [`bbW_${tf}`]: null }, bollinger(series, tf));
  const c = d.c;
  out.spd15 = n > 16 ? num((c[n - 1] / c[n - 16] - 1) * 100 / 15, 3) : null;
  out.spdPrev15 = n > 31 ? num((c[n - 16] / c[n - 31] - 1) * 100 / 15, 3) : null;
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

const EXTRA_COLS = ['cvdNet15', 'cvdNet60', 'cvdDiv', 'cvdDivPct', 'buyChg', 'wick_1m', 'clv_1m', 'body_1m', 'wick_5m', 'clv_5m', 'body_5m',
  'wick_15m', 'clv_15m', 'body_15m', 'greens_1m', 'greens_5m', 'volTrend15', 'volPeakX', 'neg5', 'neg15', 'neg1h', 'bbB_5m', 'bbW_5m',
  'bbB_15m', 'bbW_15m', 'bbB_1h', 'bbW_1h', 'spd15', 'spdPrev15', 'accel', 'pumpAtr', 'breadth80', 'pumping', 'btc5', 'btc15', 'btcRsi15',
  'hourTR', 'dow', 'session', 'minToFunding', 'ageDays', 'athDist', 'fromLow30', 'dayChg', 'dayPos', 'trend_1h', 'ema200_1h', 'trend_4h',
  'ema200_4h', 'ichiPos', 'ichiDist', 'samples24h', 'drops24h', 'cards24h', 'lastOutcome', 'minsSinceDrop'];

module.exports = { extraFeatures, EXTRA_COLS, cvdFeatures, bollinger, ichiCloud, session, localHourDow };
