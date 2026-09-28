'use strict';

/**
 * Hızlı teknik göstergeler — düz sayı dizileri üzerinde (eski → yeni).
 *
 * Neden technicalindicators değil: bilgi botu yüzlerce coinde her mum kapanışında hesap yapar;
 * burada ara nesne üretmeden tek döngüyle hesaplanır. Formüller technicalindicators ile AYNI
 * (Wilder yumuşatma, SMA ile tohumlama) — test-ta.js ikisini karşılaştırır.
 *
 * Bu modülün yan etkisi yok.
 */

/** RSI serisi (Wilder). Dönen dizi closes ile hizalı DEĞİL: ilk eleman closes[period] anına aittir. */
function rsiSeries(closes, period = 14) {
  const n = closes.length;
  if (n <= period) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  const out = [al === 0 ? 100 : 100 - 100 / (1 + ag / al)];
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
    out.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  return out;
}

/** Son RSI değeri (dizi üretmeden) */
function rsiLast(closes, period = 14) {
  const n = closes.length;
  if (n <= period) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < n; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** EMA serisi (ilk değer ilk `period` elemanın SMA'sı). İlk eleman values[period-1] anına aittir. */
function emaSeries(values, period) {
  const n = values.length;
  if (n < period) return [];
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i];
  let e = s / period;
  const k = 2 / (period + 1);
  const out = [e];
  for (let i = period; i < n; i++) { e = (values[i] - e) * k + e; out.push(e); }
  return out;
}

function emaLast(values, period) {
  const n = values.length;
  if (n < period) return null;
  let s = 0;
  for (let i = 0; i < period; i++) s += values[i];
  let e = s / period;
  const k = 2 / (period + 1);
  for (let i = period; i < n; i++) e = (values[i] - e) * k + e;
  return e;
}

function smaLast(values, period) {
  const n = values.length;
  if (n < period) return null;
  let s = 0;
  for (let i = n - period; i < n; i++) s += values[i];
  return s / period;
}

/** ATR serisi (Wilder; ilk TR = high−low). İlk eleman index period-1 anına aittir. */
function atrSeries(high, low, close, period = 14) {
  const n = close.length;
  if (n < period) return [];
  const tr = i => (i === 0
    ? high[0] - low[0]
    : Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
  let s = 0;
  for (let i = 0; i < period; i++) s += tr(i);
  let a = s / period;
  const out = [a];
  for (let i = period; i < n; i++) { a = (a * (period - 1) + tr(i)) / period; out.push(a); }
  return out;
}

/**
 * MACD (EMA fast/slow, sinyal EMA) — son `keep` nokta.
 * @returns {{macd:number, signal:number, hist:number}[]}  eski → yeni
 */
function macdTail(closes, fast = 12, slow = 26, signal = 9, keep = 6) {
  const ef = emaSeries(closes, fast), es = emaSeries(closes, slow);
  if (!es.length) return [];
  const off = slow - fast;                 // ef[i+off] ile es[i] aynı ana ait
  const line = es.map((v, i) => ef[i + off] - v);
  const sig = emaSeries(line, signal);
  if (!sig.length) return [];
  const off2 = signal - 1;
  const out = [];
  for (let j = Math.max(0, sig.length - keep); j < sig.length; j++) {
    const m = line[j + off2];
    out.push({ macd: m, signal: sig[j], hist: m - sig[j] });
  }
  return out;
}

/**
 * Stochastic RSI (%K = SMA_k(stoch), %D = SMA_d(%K)) — son `keep` nokta.
 * @returns {{k:number, d:number}[]}  eski → yeni
 */
function stochRsiTail(closes, rsiP = 14, stochP = 14, kP = 3, dP = 3, keep = 3) {
  const r = rsiSeries(closes, rsiP);
  if (r.length < stochP) return [];
  const st = [];
  for (let i = stochP - 1; i < r.length; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - stochP + 1; j <= i; j++) { if (r[j] < lo) lo = r[j]; if (r[j] > hi) hi = r[j]; }
    st.push(hi === lo ? 0 : (r[i] - lo) / (hi - lo) * 100);
  }
  const sma = (a, p) => { const o = []; let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= p) s -= a[i - p]; if (i >= p - 1) o.push(s / p); } return o; };
  const K = sma(st, kP), D = sma(K, dP);
  if (!D.length) return [];
  const off = dP - 1;
  const out = [];
  for (let j = Math.max(0, D.length - keep); j < D.length; j++) out.push({ k: K[j + off], d: D[j] });
  return out;
}

/**
 * Hacim ağırlıklı ortalama fiyat + hacim ağırlıklı standart sapma.
 * Tipik fiyat (h+l+c)/3. fromIdx'ten sona kadar olan mumlar kullanılır.
 */
function vwapBands(high, low, close, volume, fromIdx = 0) {
  let pv = 0, v = 0, p2v = 0;
  for (let i = Math.max(0, fromIdx); i < close.length; i++) {
    const tp = (high[i] + low[i] + close[i]) / 3;
    pv += tp * volume[i]; p2v += tp * tp * volume[i]; v += volume[i];
  }
  if (!(v > 0)) return null;
  const vwap = pv / v;
  const sigma = Math.sqrt(Math.max(0, p2v / v - vwap * vwap));
  return { vwap, sigma };
}

module.exports = { rsiSeries, rsiLast, emaSeries, emaLast, smaLast, atrSeries, macdTail, stochRsiTail, vwapBands };
