'use strict';

/**
 * Sinyal Motoru — ana orkestrasyon
 *
 * Her kapanan 5m mumda çalışır:
 *   1. computeAll() → indikatörler
 *   2. detectRegime() → piyasa rejimi
 *   3. checkGates() → Mert 3A kapıları
 *   4. calcScore() → 0–100 skor
 *   5. Yeterli skor varsa → Telegram alert + DB kayıt + tracker
 */

const cfg          = require('./config');
const { computeAll }    = require('./indicators');
const { detectRegime, shouldBlockSignal } = require('./regime');
const { checkGates }    = require('./gates');
const { calcScore }     = require('./scorer');
const { sendSignalAlert } = require('./telegram');
const db           = require('./db');
const tracker      = require('./eventTracker');
const candleStore  = require('./candleStore');
const { nearLevelInfo } = require('./levels');
const { calcTradePlan } = require('./tradePlan');

// Cooldown: son sinyal zamanı { symbol → ts }
const lastSignalAt = new Map();

/**
 * Günlük EMA200 ve majör direnç verileri (REST'ten seed edilir)
 * { symbol → { ema200, resistance, proximity } }
 */
const dailyLevels = new Map();

function setDailyLevel(symbol, data) {
  dailyLevels.set(symbol, data);
}

// Günlük yakınlık hesabı levels.js'te (backtest ile ortak)

/**
 * @param {string} symbol
 * @param {number|null} oiDeltaPct   - OI delta % (opsiyonel)
 * @param {number|null} fundingRate  - funding rate (opsiyonel)
 */
async function evaluate(symbol, oiDeltaPct = null, fundingRate = null) {
  // Cooldown kontrolü
  const lastTs = lastSignalAt.get(symbol);
  if (lastTs && Date.now() - lastTs < cfg.cooldownMs) return;

  // ── Çoklu TF indikatörleri ────────────────────────────
  const candles5m  = candleStore.get(symbol, '5m');
  const candles15m = candleStore.get(symbol, '15m');
  const candles1h  = candleStore.get(symbol, '1h');
  const candles4h  = candleStore.get(symbol, '4h');

  // Yeterli veri kontrolü
  if (!candleStore.isReady(symbol, '5m') ||
      !candleStore.isReady(symbol, '15m') ||
      !candleStore.isReady(symbol, '1h')) {
    return;
  }

  const ind5m  = computeAll(candles5m);
  const ind15m = computeAll(candles15m);
  const ind1h  = computeAll(candles1h);
  const ind4h  = candles4h.length >= 50 ? computeAll(candles4h) : null;

  const price  = ind5m.price;
  const rsi5m  = ind5m.rsi;
  const rsi15m = ind15m.rsi;
  const rsi1h  = ind1h.rsi;
  const rsi4h  = ind4h?.rsi ?? null;

  // ── Günlük seviye kontrolü ────────────────────────────
  const daily = dailyLevels.get(symbol);
  const { nearDailyLevel, dailyProximity } = nearLevelInfo(price, daily);

  // ── Market Regime ─────────────────────────────────────
  const regime = detectRegime({
    indicators: ind5m,
    oiDeltaPct,
    fundingRate,
    candles:    candles5m,
  });

  // ── 3A Kapıları ───────────────────────────────────────
  const gateResult = checkGates({
    rsi5m,
    rsi15m,
    rsi1h,
    rsi4h,
    ema21Distance: ind5m.distance,
    ema21Touched:  ind5m.touched,
    nearDailyLevel,
    fundingRate,
    regime,
  });

  if (!gateResult.pass) {
    // DEBUG: çok gürültülü olabilir, ihtiyaca göre açabilirsin
    console.log(`[GATE] ${symbol} reddedildi: ${gateResult.reason}`);
    return;
  }

  // ── İşlem planı (TP/SL) — backtest ile ortak (tradePlan.js) ──
  const plan = calcTradePlan({
    entryPrice:     price,
    ema21:          ind5m.ema21,
    atr:            ind5m.atr,
    initialRiskPct: cfg.initialRiskPct,
  });

  if (!plan.valid) {
    console.log(`[GATE] ${symbol} reddedildi: ${plan.reason}`);
    return;
  }

  // ── Skor Hesabı ───────────────────────────────────────
  const primaryRSI = Math.max(rsi5m ?? 0, rsi15m ?? 0);

  const { score, grade, breakdown } = calcScore({
    rsi:           primaryRSI,
    ema21Distance: ind5m.distance,
    dailyProximity,
    volRatio:      ind5m.volRatio,
    cvdDir:        ind5m.cvdDir,
    oiDeltaPct,
    negPeaks:      ind5m.negPeaks,
    hasEMC:        gateResult.hasEMC,
  });

  // D derecesi → gönderme
  if (score < cfg.minScoreToSend) return;

  // ── Sinyal ID ─────────────────────────────────────────
  const now = Date.now();
  const id  = `SIG_${new Date(now).toISOString().replace(/[-:T.]/g, '').slice(0,15)}_${symbol}`;

  const signal = {
    id,
    symbol,
    direction: 'SHORT',
    grade,
    score,
    regime,
    hasEMC: gateResult.hasEMC ? 1 : 0,
    entryPrice:     price,
    initialRiskPct: cfg.initialRiskPct,
    rsi5m,
    rsi15m,
    rsi1h,
    rsi4h,
    ema21Distance:  +ind5m.distance.toFixed(3),
    volumeRatio:    +ind5m.volRatio.toFixed(2),
    cvdDirection:   ind5m.cvdDir,
    oiDeltaPct:     oiDeltaPct !== null ? +oiDeltaPct.toFixed(3) : null,
    fundingRate:    fundingRate !== null ? +fundingRate.toFixed(6) : null,
    dailyResistance: daily?.resistance ?? null,
    dailyEMA200:     daily?.ema200 ?? null,
    tpA: plan.tpA,
    tpB: plan.tpB,
    sentAt: now,
  };

  // ── DB Kaydet ─────────────────────────────────────────
  db.insertSignal(signal);

  // ── Cooldown güncelle ─────────────────────────────────
  lastSignalAt.set(symbol, now);

  // ── Telegram Alert ────────────────────────────────────
  try {
    await sendSignalAlert(signal, breakdown);
  } catch (err) {
    console.error('[TELEGRAM] Alert gönderme hatası:', err.message);
  }

  // ── Trade Event Tracker'a al ──────────────────────────
  tracker.track(signal);

  console.log(`[SIGNAL] ${grade} [${score}] ${symbol} @ ${price} | Rejim: ${regime}${gateResult.hasEMC ? ' ⚡EMC' : ''}`);
}

module.exports = { evaluate, setDailyLevel };
