'use strict';

const {
  RSI,
  EMA,
  ATR,
  SMA,
  MACD,
  StochasticRSI,
} = require('technicalindicators');

const cfg = require('./config');

/**
 * Kline verisi: { open, high, low, close, volume }[]  (eski → yeni sıralı)
 * Her fonksiyon son (en güncel) değeri döner.
 */

function calcRSI(closes) {
  const values = RSI.calculate({ values: closes, period: cfg.rsiPeriod });
  return values.length ? values[values.length - 1] : null;
}

function calcEMA(closes, period) {
  const values = EMA.calculate({ values: closes, period });
  return values.length ? values[values.length - 1] : null;
}

function calcATR(candles) {
  // candles: [{high, low, close}]
  const values = ATR.calculate({
    high:   candles.map(c => c.high),
    low:    candles.map(c => c.low),
    close:  candles.map(c => c.close),
    period: cfg.atrPeriod,
  });
  return values.length ? values[values.length - 1] : null;
}

function calcVolumeSMA(volumes) {
  const values = SMA.calculate({ values: volumes, period: cfg.smaPeriod });
  return values.length ? values[values.length - 1] : null;
}

/**
 * EMA21 uzaklığı ATR cinsinden.
 * (price - EMA21) / ATR — SHORT için pozitif = yukarıda = uzak
 */
function ema21DistanceATR(price, ema21, atr) {
  if (!atr || atr === 0) return 0;
  return (price - ema21) / atr;
}

/**
 * Son N mumda EMA21'e dokunuş var mı?
 * Dokunuş: low <= EMA21 <= high
 */
function ema21TouchedRecently(candles, ema21Values, lookback = cfg.ema21TouchLookback) {
  const recent = candles.slice(-lookback);
  const emaRecent = ema21Values.slice(-lookback);
  for (let i = 0; i < recent.length; i++) {
    const c = recent[i];
    const e = emaRecent[i];
    if (e && c.low <= e && e <= c.high) return true;
  }
  return false;
}

/**
 * CVD (Kümülatif Volume Delta) — son N mumun delta toplamı
 * delta = volume × (close > open ? +1 : -1)
 * Son değer pozitif → alıcı baskısı, negatif → satıcı baskısı
 */
function calcCVD(candles, lookback = 20) {
  const recent = candles.slice(-lookback);
  let cvd = 0;
  for (const c of recent) {
    const delta = c.close > c.open ? c.volume : -c.volume;
    cvd += delta;
  }
  return cvd;
}

/**
 * CVD yön: son 3 mum CVD arttı mı, azaldı mı?
 * 'NEGATIVE' → satıcı baskısı artıyor (SHORT teyidi)
 * 'POSITIVE' → alıcı baskısı artıyor
 * 'NEUTRAL'  → belirsiz
 */
function cvdDirection(candles) {
  if (candles.length < 4) return 'NEUTRAL';
  const recent = candles.slice(-4);
  let delta = 0;
  for (const c of recent) {
    delta += c.close > c.open ? c.volume : -c.volume;
  }
  if (delta < -0.1) return 'NEGATIVE';
  if (delta >  0.1) return 'POSITIVE';
  return 'NEUTRAL';
}

/**
 * Negatif tepe sayacı — bearish divergence tespiti
 * Fiyat yeni high yapıyor ama RSI yapmıyor → TP-B sinyali
 */
function countNegativePeaks(closes, rsiValues, lookback = 6) {
  if (closes.length < lookback || rsiValues.length < lookback) return 0;
  const recentCloses = closes.slice(-lookback);
  const recentRSI    = rsiValues.slice(-lookback);

  let peaks = 0;
  // Basit peak tespiti: i ortadaki değer komşulardan büyükse peak
  for (let i = 1; i < recentCloses.length - 1; i++) {
    const isPricePeak = recentCloses[i] > recentCloses[i-1] && recentCloses[i] > recentCloses[i+1];
    if (!isPricePeak) continue;

    // Önceki peak'e göre RSI düştü mü?
    if (peaks > 0 && recentRSI[i] < recentRSI[i-2]) {
      peaks++;
    } else if (peaks === 0) {
      peaks++;
    }
  }
  return Math.max(0, peaks - 1); // ilk peak referans, sonraki her negatif +1
}

/**
 * Candle body oranı: gövde / toplam mum boyu
 * Büyük body → güçlü momentum; küçük body → tereddüt
 */
function candleBodyRatio(candle) {
  const total = candle.high - candle.low;
  if (total === 0) return 0;
  return Math.abs(candle.close - candle.open) / total;
}

/**
 * Volume ivmesi — son 3 mum volume artış hızı
 */
function volumeAcceleration(candles) {
  if (candles.length < 4) return 0;
  const recent = candles.slice(-4);
  const avgOld = (recent[0].volume + recent[1].volume) / 2;
  const avgNew = (recent[2].volume + recent[3].volume) / 2;
  if (avgOld === 0) return 0;
  return (avgNew - avgOld) / avgOld; // pozitif → ivme artıyor
}

/**
 * Tüm göstergeleri tek seferde hesapla
 * @param {object[]} candles - [{open,high,low,close,volume}] eski→yeni
 * @returns {object} indicators sonuçları
 */
function computeAll(candles) {
  const closes  = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);

  // RSI serisini tut (negatif peak için)
  const rsiSeries = RSI.calculate({ values: closes, period: cfg.rsiPeriod });

  const ema21Values = EMA.calculate({ values: closes, period: cfg.emaPeriod });
  const ema21 = ema21Values.length ? ema21Values[ema21Values.length - 1] : null;
  const atr   = calcATR(candles);
  const price = closes[closes.length - 1];

  const volSMA   = calcVolumeSMA(volumes);
  const lastVol  = volumes[volumes.length - 1];
  const volRatio = volSMA && volSMA > 0 ? lastVol / volSMA : 0;

  const distance    = ema21 && atr ? ema21DistanceATR(price, ema21, atr) : 0;
  const touched     = ema21Values.length >= cfg.ema21TouchLookback
    ? ema21TouchedRecently(candles, ema21Values)
    : false;

  const rsi         = rsiSeries.length ? rsiSeries[rsiSeries.length - 1] : null;
  const cvdDir      = cvdDirection(candles);
  const negPeaks    = countNegativePeaks(closes, rsiSeries);
  const bodyRatio   = candleBodyRatio(candles[candles.length - 1]);
  const volAccel    = volumeAcceleration(candles);

  return {
    price,
    rsi,
    rsiSeries,
    ema21,
    ema21Values,
    atr,
    distance,       // ATR cinsinden EMA21 uzaklığı
    touched,        // son N mumda dokunuş var mı
    volRatio,
    volSMA,
    cvdDir,
    negPeaks,
    bodyRatio,
    volAccel,
  };
}

module.exports = {
  calcRSI,
  calcEMA,
  calcATR,
  calcVolumeSMA,
  ema21DistanceATR,
  ema21TouchedRecently,
  calcCVD,
  cvdDirection,
  countNegativePeaks,
  candleBodyRatio,
  volumeAcceleration,
  computeAll,
};
