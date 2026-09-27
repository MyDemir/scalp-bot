'use strict';

require('dotenv').config();
const { MainClient, USDMClient, WebsocketClient } = require('binance');

// REST istemcisi (HTF polling + başlangıç seed verisi)
const restClient = new USDMClient({
  api_key:    process.env.BINANCE_API_KEY,
  api_secret: process.env.BINANCE_API_SECRET,
});

// ── REST Yardımcıları ──────────────────────────────────────────────────────

/**
 * Tarihsel kline çek
 * @param {string} symbol
 * @param {string} interval  '5m' | '15m' | '1h' | '4h' | '1d'
 * @param {number} limit     max 1000 (weight artar, 100-200 yeterli)
 */
async function fetchKlines(symbol, interval, limit = 200) {
  const data = await restClient.getKlines({ symbol, interval, limit });
  return data; // [[openTime, o, h, l, c, v, ...], ...]
}

/**
 * 24h ticker — production modunda likit coin listesi için
 */
async function fetch24hTickers() {
  return restClient.get24hrChangeStatistics();
}

/**
 * Funding rate (aşırı pozitif filtresi için)
 */
async function fetchFundingRate(symbol) {
  const rows = await restClient.getFundingRateHistory({ symbol, limit: 1 });
  return rows.length ? parseFloat(rows[0].fundingRate) : null;
}

/**
 * Open Interest
 */
async function fetchOpenInterest(symbol) {
  const data = await restClient.getOpenInterest({ symbol });
  return data ? parseFloat(data.openInterest) : null;
}

/**
 * REST weight header'ını izle
 * Yanıt header'larına erişim binance lib versiyonuna göre değişir;
 * burada manuel polling yapıyoruz — lib zaten rate limit'e uyuyor.
 */

// ── Likit Coin Filtresi ────────────────────────────────────────────────────

/**
 * Production modunda hacme göre en likit coinleri filtrele
 * @param {object} filterCfg  - config.autoFilter
 * @returns {string[]} symbol listesi
 */
async function getLiquidSymbols(filterCfg) {
  const { minVolume24hUSDT, maxCoins, excludeKeywords } = filterCfg;

  const tickers = await fetch24hTickers();

  return tickers
    .filter(t => {
      // Sadece USDT perpetual futures
      if (!t.symbol.endsWith('USDT')) return false;
      // Hariç kelimeler
      if (excludeKeywords.some(k => t.symbol.includes(k))) return false;
      // Minimum hacim
      const vol = parseFloat(t.quoteVolume);
      return vol >= minVolume24hUSDT;
    })
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, maxCoins)
    .map(t => t.symbol);
}

// ── WebSocket Yönetimi ─────────────────────────────────────────────────────

let wsClient = null;
let pingTimer = null;

/**
 * WebSocket combined stream başlat
 * 2026 Nisan sonrası: kline stream'leri /market endpoint'inden geliyor
 *
 * @param {string[]} symbols
 * @param {string[]} timeframes  ['5m', '15m', '1h']
 * @param {function} onKline     (symbol, tf, kline, isFinal) => void
 * @param {object}   cfg
 */
function startWebSocket(symbols, timeframes, onKline, cfg) {
  if (wsClient) stopWebSocket();

  /**
   * 2026 Nisan sonrası Binance USDM Futures WebSocket endpoint:
   *   kline stream'leri → wss://fstream.binance.com/market
   *
   * binance npm kütüphanesi (v2.x) WebsocketClient'a
   * `wsUrlMap` ile custom endpoint verilebilir.
   * Kütüphane versiyonuna göre iki yöntemden biri çalışır:
   *   A) wsUrlMap ile (v2.9+)
   *   B) Raw ws bağlantısı (aşağıda fallback olarak RawWS.js'te)
   */
  wsClient = new WebsocketClient({
    api_key:    process.env.BINANCE_API_KEY,
    api_secret: process.env.BINANCE_API_SECRET,
    beautify:   true,
    wsUrlMap: {
      usdmfutures: 'wss://fstream.binance.com/market',
    },
  });

  // Kline stream'lerini subscribe et
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      wsClient.subscribeKlines(symbol, tf, 'usdm');
    }
  }

  wsClient.on('formattedMessage', (data) => {
    // beautify:true ile gelen formattedMessage event'ini kullan
    if (data.eventType !== 'kline' && data.e !== 'kline') return;

    // beautified format
    const symbol  = data.symbol  || data.s;
    const kline   = data.kline   || data.k;
    if (!symbol || !kline) return;

    const tf       = kline.interval    || kline.i;
    const isFinal  = kline.isFinalBar  ?? kline.x ?? false;

    if (tf) onKline(symbol, tf, kline, isFinal);
  });

  // Fallback: bazı lib versiyonlarında 'kline' event'i gelir
  wsClient.on('kline', (data) => {
    const symbol   = data.symbol || data.s;
    const kline    = data.kline  || data.k;
    if (!symbol || !kline) return;
    const tf       = kline.interval || kline.i;
    const isFinal  = kline.isFinalBar ?? kline.x ?? false;
    if (tf) onKline(symbol, tf, kline, isFinal);
  });

  wsClient.on('error', (err) => {
    console.error('[WS] Hata:', err.message || err);
  });

  wsClient.on('close', () => {
    console.warn('[WS] Bağlantı kapandı. Yeniden bağlanılıyor...');
    setTimeout(() => startWebSocket(symbols, timeframes, onKline, cfg), cfg.reconnectDelayMs);
  });

  // Ping — 2.5 dakikada bir (3dk timeout'tan önce)
  pingTimer = setInterval(() => {
    try { wsClient.sendPing?.(); } catch (_) {}
  }, cfg.pingIntervalMs);

  console.log(`[WS] ${symbols.length} sembol × ${timeframes.length} TF = ${symbols.length * timeframes.length} stream başlatıldı`);
}

function stopWebSocket() {
  if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
  wsClient?.closeAll?.();
  wsClient = null;
}

module.exports = {
  restClient,
  fetchKlines,
  fetch24hTickers,
  fetchFundingRate,
  fetchOpenInterest,
  getLiquidSymbols,
  startWebSocket,
  stopWebSocket,
};
