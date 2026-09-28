'use strict';

/**
 * Direnç seviyeleri. Canlı bilgi botu ve backtest AYNI fonksiyonları kullanır. Yan etkisi yok.
 *   majör  : 4h MA200/EMA200, 1d MA200/EMA200, 30 günlük tepe (en yüksek 3 günün ortalaması)
 *   en yüksek: 7 / 30 günlük gerçek en yüksek (kapanmış günler)
 *   salınım: 1h / 4h tepe (solundaki ve sağındaki N mumdan yüksek tepe)
 *   Fib    : son 1h itki bacağının 0.236 / 0.382 / 0.618 düzeltmesi (grafikteki bacakla aynı)
 * Her seviye { name, value, kind: 'major'|'high'|'swing'|'fib' }.
 */

const { emaLast } = require('./ta');

/**
 * Çok küçük fiyatlı coinlerde toFixed(6) hassasiyet kaybettiriyordu
 * (0.0000123 → 0.000012). Anlamlı basamak bazlı yuvarlama kullanıyoruz.
 */
function roundPx(x) {
  return x == null || !Number.isFinite(x) ? null : +x.toPrecision(10);
}

/**
 * Son 30 günün en yüksek 3 high'ının ortalaması → majör yatay direnç
 * @param {{high:number}[]} dailyCandles
 */
function calcMajorResistance(dailyCandles) {
  if (!dailyCandles || dailyCandles.length < 5) return null;
  const highs = dailyCandles.map(c => c.high).sort((a, b) => b - a);
  const top3 = highs.slice(0, 3);
  return roundPx(top3.reduce((s, v) => s + v, 0) / top3.length);
}

const sma200 = arr => (arr.length >= 200 ? arr.slice(-200).reduce((s, v) => s + v, 0) / 200 : null);
const ema200 = arr => (arr.length >= 200 ? emaLast(arr, 200) : null);

/**
 * Direnç seviyeleri (bilgi botu + backtest varyantları ortak kullanır).
 * @param {number[]} h4Closes    - kapanmış 4h kapanışları (eski → yeni; EMA200'ün oturması için ~600)
 * @param {object[]} dayCandles  - günlük mumlar {high, close} (eski → yeni; devam eden gün dahil olabilir)
 * @returns {{ name: string, value: number }[]}  yalnızca hesaplanabilenler (yeni coinlerde eksik olabilir)
 */
function calcLevelSet(h4Closes, dayCandles) {
  const dCloses = dayCandles.map(d => d.close);
  const raw = [
    ['4h MA200',  sma200(h4Closes)],
    ['4h EMA200', ema200(h4Closes)],
    ['1d MA200',  sma200(dCloses)],
    ['1d EMA200', ema200(dCloses)],
    ['30 günlük tepe', calcMajorResistance(dayCandles.slice(-30))],   // son 30 günün en yüksek 3 tepesinin ortalaması
  ];
  return raw.filter(([, v]) => Number.isFinite(v) && v > 0).map(([name, v]) => ({ name, value: roundPx(v), kind: 'major' }));
}

/**
 * Son itki bacağı (grafikteki Fibonacci ile aynı): pencerenin en düşük dibi → ondan sonraki en yüksek tepe
 * (dir='down': en yüksek tepe → ondan sonraki en düşük dip). Bacak pencere aralığının %30'undan kısaysa
 * tüm pencerenin dip–tepesi alınır.
 * @returns {{hi:number, lo:number, hiI:number, loI:number, up:boolean}|null}  indeksler h/l dizisinde
 */
function impulseLeg(h, l, show = 100, dir = 'up') {
  const n = Math.min(h.length, l.length);
  if (n < 10) return null;
  const start = Math.max(0, n - show);
  const argmax = (a, b) => { let k = a; for (let i = a; i <= b; i++) if (h[i] > h[k]) k = i; return k; };
  const argmin = (a, b) => { let k = a; for (let i = a; i <= b; i++) if (l[i] < l[k]) k = i; return k; };
  let hiI, loI, up;
  if (dir === 'down') { hiI = argmax(start, n - 1); loI = argmin(hiI, n - 1); up = false; }
  else { loI = argmin(start, n - 1); hiI = argmax(loI, n - 1); up = true; }
  const fullHi = h[argmax(start, n - 1)], fullLo = l[argmin(start, n - 1)];
  if ((h[hiI] - l[loI]) < (fullHi - fullLo) * 0.3) { hiI = argmax(start, n - 1); loI = argmin(start, n - 1); up = loI < hiI; }
  if (!(h[hiI] > l[loI])) return null;
  return { hi: h[hiI], lo: l[loI], hiI, loI, up };
}

/** Salınım tepeleri: h[i] solundaki `bars` mumdan büyük ve sağındaki `bars` mumdan büyük-eşit (son `lookback` mum) */
function swingHighs(h, bars = 3, lookback = 200) {
  const out = [];
  const n = h.length;
  for (let i = Math.max(bars, n - lookback); i < n - bars; i++) {
    let ok = true;
    for (let k = 1; k <= bars && ok; k++) if (!(h[i] > h[i - k]) || !(h[i] >= h[i + k])) ok = false;
    if (ok) out.push({ i, value: h[i] });
  }
  return out;
}

const FIB_RET = [0.236, 0.382, 0.618];
const FIB_EXT = [1.272, 1.618, 2, 2.618];

/**
 * Ek seviyeler (kapanmış mumlardan).
 * @param {object} p
 * @param {{h:number[], l:number[]}} p.h1  1h mumlar
 * @param {{h:number[]}} p.h4              4h mumlar
 * @param {{h:number[]}} p.d1              1d mumlar
 * @param {object} o  { swing:boolean, fib:boolean, bars:number }
 * @param {{name,value}[]} base  mevcut (majör) seviyeler — bunlara %0.3'ten yakın ek seviye eklenmez
 * @returns {{levels:object[], leg:object|null}}
 */
function calcExtraLevels({ h1, h4, d1 }, o, base = []) {
  const out = [];
  const near = (v, list) => list.some(L => Math.abs(L.value - v) / L.value <= 0.003);
  const add = (name, v, kind) => {
    if (!(Number.isFinite(v) && v > 0)) return;
    if (near(v, base) || near(v, out)) return;               // yakın kopya yok (öncelik: majör → en yüksek → salınım → Fib)
    out.push({ name, value: roundPx(v), kind });
  };
  const dh = d1?.h || [];
  if (dh.length >= 20) add('30 günlük en yüksek', Math.max(...dh.slice(-30)), 'high');
  if (dh.length >= 7) add('7 günlük en yüksek', Math.max(...dh.slice(-7)), 'high');   // 30 günlükle aynıysa tek seviye
  if (o.swing) {
    for (const p of swingHighs(h4?.h || [], o.bars, 180).reverse()) add('4h tepe', p.value, 'swing');
    for (const p of swingHighs(h1?.h || [], o.bars, 200).reverse()) add('1h tepe', p.value, 'swing');
  }
  const leg = h1 && h1.h.length >= 30 ? impulseLeg(h1.h, h1.l, 100, 'up') : null;
  if (o.fib && leg) {
    const R = leg.hi - leg.lo;
    for (const r of FIB_RET) add(`Fib ${r}`, leg.up ? leg.hi - r * R : leg.lo + r * R, 'fib');
  }
  return { levels: out, leg };
}

/** Fib uzantı hedefleri (yükseliş bacağı: dip + oran × bacak) — fiyatın üstündekiler, en fazla `max` tane */
function fibExtensions(leg, price, max = 2) {
  if (!leg || !leg.up) return [];
  const R = leg.hi - leg.lo;
  return FIB_EXT.map(r => ({ r, value: roundPx(leg.lo + r * R) })).filter(x => x.value > price).slice(0, max);
}

module.exports = { roundPx, calcMajorResistance, calcLevelSet, impulseLeg, swingHighs, calcExtraLevels, fibExtensions, FIB_RET, FIB_EXT };
