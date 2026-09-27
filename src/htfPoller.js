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
const { calcDailyLevels } = require('./levels');
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

    // EMA200 + majör direnç — backtest ile ortak hesap (levels.js)
    const daily1d = klines1d.map(k => ({ high: parseFloat(k[2]), close: parseFloat(k[4]) }));
    signalEngine.setDailyLevel(symbol, calcDailyLevels(daily1d));

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
