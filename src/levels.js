'use strict';

/**
 * Direnç seviyeleri: 4h MA200/EMA200, 1d MA200/EMA200, 30 günlük tepe (majör yatay direnç).
 * Canlı bilgi botu ve backtest AYNI fonksiyonları kullanır. Yan etkisi yok.
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
  return raw.filter(([, v]) => Number.isFinite(v) && v > 0).map(([name, v]) => ({ name, value: roundPx(v) }));
}

module.exports = { roundPx, calcMajorResistance, calcLevelSet };
