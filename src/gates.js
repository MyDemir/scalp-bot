'use strict';

/**
 * Katman 3A — Mert Zorunlu Koşullar (Hard Gates)
 *
 * Tüm koşullar sağlanmazsa { pass: false, reason } döner.
 * Sağlanırsa { pass: true, hasEMC } döner.
 *
 * EMC = Extreme Momentum Condition (15m RSI 95+)
 *   Deterministic bir "kesin giriş" değil, ek bir momentum sinyalidir.
 */

const cfg = require('./config');

/**
 * @param {object} p
 * @param {number}      p.rsi5m
 * @param {number}      p.rsi15m
 * @param {number}      p.rsi1h
 * @param {number}      p.rsi4h
 * @param {number}      p.ema21Distance   - ATR cinsinden uzaklık
 * @param {boolean}     p.ema21Touched    - son N mumda dokunuş var mı
 * @param {boolean}     p.nearDailyLevel  - günlük EMA200 veya majör direnç yakını
 * @param {number}      p.fundingRate     - mevcut funding rate
 * @param {string}      p.regime          - 'REVERSAL' | 'CONTINUATION' | 'NEUTRAL'
 *
 * @returns {{ pass: boolean, reason?: string, hasEMC?: boolean }}
 */
function checkGates(p) {
  const {
    rsi5m, rsi15m, rsi1h, rsi4h,
    ema21Distance, ema21Touched,
    nearDailyLevel,
    fundingRate,
    regime,
  } = p;

  // ── 1. Market Regime ──────────────────────────────────
  if (regime === 'CONTINUATION') {
    return { pass: false, reason: 'Momentum Continuation rejiminde SHORT sinyali iptal' };
  }

  // ── 2. Günlük seviye kontrolü ─────────────────────────
  if (!nearDailyLevel) {
    return { pass: false, reason: 'Günlük EMA200 veya majör direnç yakınında değil' };
  }

  // ── 3. 1h RSI ─────────────────────────────────────────
  if (!rsi1h || rsi1h < cfg.rsi1hMin) {
    return { pass: false, reason: `1h RSI yetersiz (${rsi1h?.toFixed(1)} < ${cfg.rsi1hMin})` };
  }

  // ── 4. 4h RSI ─────────────────────────────────────────
  if (!rsi4h || rsi4h < cfg.rsi4hMin) {
    return { pass: false, reason: `4h RSI yetersiz (${rsi4h?.toFixed(1)} < ${cfg.rsi4hMin})` };
  }

  // ── 5. 5m veya 15m RSI giriş aralığı ─────────────────
  const primaryRSI = Math.max(rsi5m || 0, rsi15m || 0);
  if (primaryRSI < cfg.rsiEntryMin) {
    return {
      pass:   false,
      reason: `5m/15m RSI yetersiz (max: ${primaryRSI.toFixed(1)} < ${cfg.rsiEntryMin})`,
    };
  }
  if (primaryRSI > cfg.rsiEntryMax) {
    return {
      pass:   false,
      reason: `5m/15m RSI sınır aşıldı (${primaryRSI.toFixed(1)} > ${cfg.rsiEntryMax})`,
    };
  }

  // ── 6. EMA21 uzaklık ──────────────────────────────────
  if (ema21Distance < cfg.ema21DistanceThreshold) {
    return {
      pass:   false,
      reason: `EMA21 çok yakın (${ema21Distance.toFixed(2)} ATR < ${cfg.ema21DistanceThreshold})`,
    };
  }

  // ── 7. EMA21 son dokunuş ──────────────────────────────
  if (ema21Touched) {
    return { pass: false, reason: `Son ${cfg.ema21TouchLookback} mumda EMA21 dokunuşu var` };
  }

  // ── 8. Funding rate (aşırı pozitif + SHORT → crowded) ─
  if (fundingRate !== null && fundingRate !== undefined && fundingRate > 0.05) {
    return {
      pass:   false,
      reason: `Aşırı pozitif funding rate (${(fundingRate * 100).toFixed(3)}%) — crowded short riski`,
    };
  }

  // ── Tüm kapılar geçildi ───────────────────────────────
  const hasEMC = !!(rsi15m && rsi15m >= cfg.rsiEMCThreshold);

  return { pass: true, hasEMC };
}

module.exports = { checkGates };
