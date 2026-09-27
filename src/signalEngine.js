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

/**
 * Yakınlık skoru: fiyat ne kadar direnç/ema200'e yakın?
 * 0 = uzak, 1 = tam üstünde
 * Eşik: %1.5 içindeyse "yakın" sayılır
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
  const nearDailyLevel = daily
    ? (calcDailyProximity(price, daily.ema200) >= 0.3 ||
       calcDailyProximity(price, daily.resistance) >= 0.3)
    : false;

  const dailyProximity = daily
    ? Math.max(
        calcDailyProximity(price, daily.ema200),
        calcDailyProximity(price, daily.resistance)
      )
    : 0;

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
    // console.log(`[GATE] ${symbol} reddedildi: ${gateResult.reason}`);
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

  // ── TP Hesabı (basit — EMA21 bazlı) ──────────────────
  const ema21_5m = ind5m.ema21;
  const atr5m    = ind5m.atr;

  // SHORT için TP = fiyat EMA21'e doğru düşer
  // TP-A: EMA21'in %0.15 üstü (yakın hedef — ema21'e yaklaşınca kapat)
  // TP-B: EMA21 - 0.3×ATR (derin hedef — oyalama/çakma senaryosu)
  // Güvence: tpB mutlaka tpA'dan küçük olmalı (SHORT mantığı)
  const tpA = ema21_5m != null
    ? +(ema21_5m * 1.0015).toFixed(6)   // EMA21'in %0.15 üstü = yaklaşma hedefi
    : null;
  const tpB = ema21_5m != null && atr5m != null
    ? +(ema21_5m - atr5m * 0.3).toFixed(6)  // EMA21'in altı = derin hedef
    : null;

  // tpA > tpB olmalı (SHORT: entry > tpA > tpB şeklinde düşer)
  // Eğer bir şekilde tersine dönmüşse tpB'yi iptal et
  const safeTpA = tpA;
  const safeTpB = tpB != null && tpA != null && tpB < tpA ? tpB : null;

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
    tpA: safeTpA,
    tpB: safeTpB,
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
