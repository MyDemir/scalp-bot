'use strict';

/**
 * HTF REST Poller — 4 saatte bir
 *
 *   • 1D kline → günlük EMA200 + majör direnç (levels.js, backtest ile ortak) → signalEngine
 *   • Open Interest → 4 saatlik OI değişimi (%)
 *   • Funding → TÜM semboller tek istekte (premiumIndex)
 *
 * 4h mumlar artık WebSocket'ten canlı geliyor (eskiden burada 4 saatte bir çekiliyordu →
 * 4h RSI kapısı 4 saate kadar bayat veriyle çalışıyordu).
 *
 * İstekler binanceClient'taki weight bütçeli kuyruktan geçer; ayrıca sleep gerekmez.
 */

const cfg            = require('./config');
const { fetchKlines, fetchFundingRates, fetchOpenInterest } = require('./binanceClient');
const { calcDailyLevels } = require('./levels');
const candleStore    = require('./candleStore');
const signalEngine   = require('./signalEngine');

const prevOI        = new Map();   // symbol → önceki OI
const _oiDeltas     = new Map();   // symbol → OI değişimi % (son iki poll arası)
let   _fundingRates = new Map();   // symbol → lastFundingRate

function getOIDelta(symbol)     { return _oiDeltas.get(symbol) ?? null; }
function getFundingRate(symbol) { return _fundingRates.get(symbol) ?? null; }

async function pollSymbol(symbol) {
  // ── 1D kline → EMA200 + majör direnç ──
  const klines1d = await fetchKlines(symbol, '1d', 220);
  candleStore.seed(symbol, '1d', klines1d);
  const daily1d = klines1d.map(k => ({ high: parseFloat(k[2]), close: parseFloat(k[4]) }));
  signalEngine.setDailyLevel(symbol, calcDailyLevels(daily1d));

  // ── OI Delta ──
  const currentOI = await fetchOpenInterest(symbol);
  if (currentOI !== null) {
    const prev = prevOI.get(symbol);
    if (prev) _oiDeltas.set(symbol, +((currentOI - prev) / prev * 100).toFixed(3));
    prevOI.set(symbol, currentOI);
  }
}

let running = false;

async function pollAll(symbols) {
  if (running) {
    console.warn('[HTF] Önceki tarama hâlâ sürüyor — bu tur atlandı');
    return;
  }
  running = true;
  const t0 = Date.now();
  let errors = 0;
  console.log(`[HTF] ${symbols.length} sembol için günlük seviye / OI / funding güncelleniyor...`);

  try {
    try {
      _fundingRates = await fetchFundingRates();
    } catch (err) {
      errors++;
      console.error('[HTF] Funding çekilemedi:', err?.message || err);
    }

    for (const symbol of symbols) {
      try {
        await pollSymbol(symbol);
      } catch (err) {
        errors++;
        console.error(`[HTF] ${symbol} poll hatası:`, err?.message || err);
      }
    }
  } finally {
    running = false;
  }

  console.log(`[HTF] Tamamlandı — ${Math.round((Date.now() - t0) / 1000)} sn, ${errors} hata.`);
}

function startPolling(symbols) {
  pollAll(symbols);
  setInterval(() => pollAll(symbols), cfg.restPollInterval);
}

module.exports = { startPolling, getOIDelta, getFundingRate, pollAll };
