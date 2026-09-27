'use strict';

/**
 * Katman 3B — Skor Motoru (0–100)
 *
 * Bileşenler:
 *   RSI şiddeti         25p
 *   EMA21 uzaklığı      20p
 *   Günlük direnç       20p
 *   Volume ratio + CVD  15p
 *   OI delta            10p
 *   Bearish divergence  10p
 *   EMC bonus           +10p (max 100'ü geçemez)
 */

/**
 * @param {object} p
 * @param {number}  p.rsi            - baskın RSI (5m veya 15m, hangisi yüksekse)
 * @param {number}  p.ema21Distance  - ATR cinsinden EMA21 uzaklığı
 * @param {boolean} p.nearDailyLevel - günlük direnç yakınlığı (boolean yerine skor olabilir)
 * @param {number}  p.dailyProximity - 0–1 arası yakınlık skoru (1=tam üstünde)
 * @param {number}  p.volRatio       - currentVol / SMA20(vol)
 * @param {string}  p.cvdDir         - 'NEGATIVE' | 'POSITIVE' | 'NEUTRAL'
 * @param {number|null} p.oiDeltaPct - OI değişim %
 * @param {number}  p.negPeaks       - negatif tepe sayısı (bearish divergence)
 * @param {boolean} p.hasEMC         - Extreme Momentum Condition (15m RSI 95+)
 *
 * @returns {{ score: number, grade: string, breakdown: object }}
 */
function calcScore(p) {
  const {
    rsi, ema21Distance, dailyProximity,
    volRatio, cvdDir, oiDeltaPct, negPeaks, hasEMC,
  } = p;

  // ── RSI Şiddeti (0–25) ────────────────────────────────
  let rsiScore = 0;
  if      (rsi >= 98) rsiScore = 25;
  else if (rsi >= 95) rsiScore = 20;
  else if (rsi >= 90) rsiScore = 14;
  else if (rsi >= 85) rsiScore =  8;
  else if (rsi >= 80) rsiScore =  4;

  // ── EMA21 Uzaklık (0–20) ─────────────────────────────
  let emaScore = 0;
  if      (ema21Distance >= 2.0) emaScore = 20;
  else if (ema21Distance >= 1.5) emaScore = 16;
  else if (ema21Distance >= 1.0) emaScore = 12;
  else if (ema21Distance >= 0.5) emaScore =  6;

  // ── Günlük Direnç Yakınlığı (0–20) ──────────────────
  // dailyProximity: 0–1 (1 = tam üstünde, 0 = uzak)
  let resistScore = 0;
  if      (dailyProximity >= 0.9) resistScore = 20;
  else if (dailyProximity >= 0.7) resistScore = 16;
  else if (dailyProximity >= 0.5) resistScore = 12;
  else if (dailyProximity >= 0.3) resistScore =  6;
  else if (dailyProximity >= 0.1) resistScore =  2;

  // ── Volume Ratio + CVD (0–15) ────────────────────────
  let volScore = 0;
  if      (volRatio >= 5.0) volScore = 12;
  else if (volRatio >= 3.0) volScore =  9;
  else if (volRatio >= 2.0) volScore =  6;
  else if (volRatio >= 1.5) volScore =  3;

  // CVD teyidi → +3p
  if (cvdDir === 'NEGATIVE') volScore = Math.min(15, volScore + 3);

  // ── OI Delta (0–10) ───────────────────────────────────
  let oiScore = 0;
  if (oiDeltaPct !== null && oiDeltaPct !== undefined) {
    if      (oiDeltaPct > 2.0)  oiScore = 10;
    else if (oiDeltaPct > 1.0)  oiScore =  7;
    else if (oiDeltaPct > 0.5)  oiScore =  4;
    else if (oiDeltaPct > 0)    oiScore =  2;
    // Negatif OI (short kapanıyor) → skor düşürme değil, 0 bırak
  }

  // ── Bearish Divergence / Negatif Tepeler (0–10) ──────
  let divScore = 0;
  if      (negPeaks >= 3) divScore = 10;
  else if (negPeaks >= 2) divScore =  7;
  else if (negPeaks >= 1) divScore =  4;

  // ── Toplam ────────────────────────────────────────────
  let total = rsiScore + emaScore + resistScore + volScore + oiScore + divScore;

  // EMC Bonus (+10, ama max 100)
  const emcBonus = hasEMC ? 10 : 0;
  total = Math.min(100, total + emcBonus);

  // ── Derece ────────────────────────────────────────────
  let grade;
  if      (total >= 85) grade = 'A+';
  else if (total >= 70) grade = 'A';
  else if (total >= 55) grade = 'B';
  else if (total >= 40) grade = 'C';
  else                  grade = 'D';

  return {
    score: total,
    grade,
    breakdown: {
      rsi:       rsiScore,
      ema21:     emaScore,
      resist:    resistScore,
      volume:    volScore,
      oi:        oiScore,
      diverge:   divScore,
      emcBonus,
    },
  };
}

/**
 * Derece sembolü
 */
function gradeEmoji(grade) {
  const map = { 'A+': '🏆', 'A': '✅', 'B': '⚠️', 'C': 'ℹ️', 'D': '❌' };
  return map[grade] || '';
}

module.exports = { calcScore, gradeEmoji };
