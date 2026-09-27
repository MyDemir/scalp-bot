'use strict';

/**
 * HTF (High Timeframe) REST Poller
 *
 * 4h ve 1D verilerini WebSocket yerine REST ile çeker.
 * Maliyet: ~2-4 weight/sorgu × sembol sayısı × günde 6 sorgu = minimal.
 *
 * Ayrıca günlük EMA200 ve majör yatay direnç hesabı yaparak
 * signalEngine.setDailyLevel()'a iletir.
 */

const cfg            = require('./config');
const { fetchKlines, fetchFundingRate, fetchOpenInterest } = require('./binanceClient');
const { calcEMA }    = require('./indicators');
const candleStore    = require('./candleStore');
const signalEngine   = require('./signalEngine');

// OI takibi (delta hesabı için)
const prevOI = new Map(); // symbol → prevOI

/**
 * Tek bir sembol için HTF verilerini güncelle
 */
async function pollSymbol(symbol) {
  try {
    // ── 4h kline ───────────────────────────────────────
    const klines4h = await fetchKlines(symbol, '4h', 200);
    candleStore.seed(symbol, '4h', klines4h);

    // ── 1D kline → EMA200 + majör direnç ───────────────
    const klines1d = await fetchKlines(symbol, '1d', 220);
    candleStore.seed(symbol, '1d', klines1d);

    const closes1d = klines1d.map(k => parseFloat(k[4]));
    const ema200   = closes1d.length >= 200 ? calcEMA(closes1d, 200) : null;

    // Majör yatay direnç: son 30 günlük pivot high
    const resistance = calcMajorResistance(klines1d.slice(-30));

    // signalEngine'e ilet
    signalEngine.setDailyLevel(symbol, { ema200, resistance });

    // ── Funding rate ────────────────────────────────────
    // (signalEngine.evaluate() çağrılırken kullanılacak)
    // Burada sadece önbelleğe alıyoruz

    // ── OI Delta ────────────────────────────────────────
    const currentOI = await fetchOpenInterest(symbol);
    if (currentOI !== null) {
      const prev = prevOI.get(symbol);
      if (prev) {
        const deltaPct = (currentOI - prev) / prev * 100;
        _oiDeltas.set(symbol, +deltaPct.toFixed(3));
      }
      prevOI.set(symbol, currentOI);
    }

  } catch (err) {
    console.error(`[HTF] ${symbol} poll hatası:`, err.message);
  }
}

// Son OI delta değerlerini tut (signalEngine.evaluate'e geçirilecek)
const _oiDeltas    = new Map();
const _fundingRates = new Map();

function getOIDelta(symbol)    { return _oiDeltas.get(symbol) ?? null; }
function getFundingRate(symbol) { return _fundingRates.get(symbol) ?? null; }

/**
 * Tüm sembolleri poll et — başlangıçta ve her cfg.restPollInterval'da
 */
async function pollAll(symbols) {
  console.log(`[HTF] ${symbols.length} sembol için HTF verisi çekiliyor...`);

  // Rate limit riski → sıralı çek (paralel değil)
  for (const symbol of symbols) {
    await pollSymbol(symbol);
    await _sleep(300); // 300ms ara — weight koruması
  }

  // Funding rate'leri ayrı çek (weight yüksek, sadece ihtiyaç anında)
  for (const symbol of symbols) {
    try {
      const fr = await fetchFundingRate(symbol);
      if (fr !== null) _fundingRates.set(symbol, fr);
      await _sleep(200);
    } catch (_) {}
  }

  console.log('[HTF] Tamamlandı.');
}

/**
 * Son 30 günlük pivot high → majör yatay direnç
 * Basit yöntem: en yüksek 3 mum arasındaki ortalama
 */
function calcMajorResistance(klines1d) {
  if (!klines1d || klines1d.length < 5) return null;

  const highs = klines1d.map(k => parseFloat(k[2])); // index 2 = high
  highs.sort((a, b) => b - a);
  // En yüksek 3 değerin ortalaması
  const top3 = highs.slice(0, 3);
  return +(top3.reduce((s, v) => s + v, 0) / top3.length).toFixed(6);
}

function _sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Döngüsel polling başlat
 */
function startPolling(symbols) {
  // İlk çalışma
  pollAll(symbols);

  // Periyodik
  setInterval(() => pollAll(symbols), cfg.restPollInterval);
}

module.exports = { startPolling, getOIDelta, getFundingRate, pollAll };
