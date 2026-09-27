'use strict';

/**
 * Günlük seviyeler (EMA200 + majör direnç) ve fiyat yakınlığı.
 *
 * Canlı bot (htfPoller + signalEngine) ve backtest AYNI fonksiyonları kullanır.
 * Böylece ikisi arasında hesaplama farkı oluşamaz.
 *
 * Bu modülün yan etkisi yok (Telegram/DB/ağ açmaz) — backtest güvenle require edebilir.
 */

const { calcEMA } = require('./indicators');

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

/**
 * @param {{high:number, close:number}[]} dailyCandles  eski → yeni; son eleman devam eden gün olabilir
 * @returns {{ ema200: number|null, resistance: number|null }}
 */
function calcDailyLevels(dailyCandles) {
  if (!dailyCandles || !dailyCandles.length) return { ema200: null, resistance: null };
  const closes = dailyCandles.map(c => c.close);
  const ema200 = closes.length >= 200 ? calcEMA(closes, 200) : null;
  const resistance = calcMajorResistance(dailyCandles.slice(-30));
  return { ema200, resistance };
}

/**
 * Yakınlık skoru: 1 = seviyenin tam üstünde, 0 = uzak (%2.5'ten fazla)
 */
function calcDailyProximity(price, level) {
  if (!level || level === 0) return 0;
  const pct = Math.abs(price - level) / level * 100;
  if (pct <= 0.2) return 1.0;
  if (pct <= 0.5) return 0.9;
  if (pct <= 1.0) return 0.7;
  if (pct <= 1.5) return 0.5;
  if (pct <= 2.5) return 0.2;
  return 0;
}

/**
 * @param {number} price
 * @param {{ema200:number|null, resistance:number|null}|undefined} daily
 * @returns {{ nearDailyLevel: boolean, dailyProximity: number }}
 */
function nearLevelInfo(price, daily) {
  if (!daily) return { nearDailyLevel: false, dailyProximity: 0 };
  const pEma = calcDailyProximity(price, daily.ema200);
  const pRes = calcDailyProximity(price, daily.resistance);
  return {
    nearDailyLevel: pEma >= 0.3 || pRes >= 0.3,
    dailyProximity: Math.max(pEma, pRes),
  };
}

module.exports = { roundPx, calcMajorResistance, calcDailyLevels, calcDailyProximity, nearLevelInfo };
