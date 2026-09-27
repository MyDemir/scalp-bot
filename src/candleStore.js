'use strict';

/**
 * CandleStore — her sembol + timeframe için OHLCV tamponu tutar
 *
 * WebSocket'ten gelen kline mesajları burada birikir.
 * computeAll() çağrılabilmesi için yeterli mum (>= 50) olması beklenir.
 */

const BUFFER_SIZE = 200; // Her TF için tutulacak maksimum mum sayısı

// store[symbol][tf] = [{open,high,low,close,volume,ts,isFinal}]
const store = {};

function _key(symbol, tf) {
  return `${symbol}:${tf}`;
}

function init(symbols, timeframes) {
  for (const s of symbols) {
    store[s] = store[s] || {};
    for (const tf of timeframes) {
      store[s][tf] = store[s][tf] || [];
    }
  }
}

/**
 * WebSocket kline mesajından gelen mumu ekle veya güncelle
 * Binance: kapanmamış mum → isFinal=false; kapanmış mum → isFinal=true
 */
function update(symbol, tf, kline) {
  const candles = store[symbol]?.[tf];
  if (!candles) return;

  const candle = {
    ts:       kline.startTime || kline.t,
    open:     parseFloat(kline.open  || kline.o),
    high:     parseFloat(kline.high  || kline.h),
    low:      parseFloat(kline.low   || kline.l),
    close:    parseFloat(kline.close || kline.c),
    volume:   parseFloat(kline.volume || kline.v),
    isFinal:  kline.final ?? kline.x ?? false,
  };

  const last = candles[candles.length - 1];

  if (last && last.ts === candle.ts) {
    // Aynı mumu güncelle (henüz kapanmamış)
    candles[candles.length - 1] = candle;
  } else {
    // Yeni mum ekle
    candles.push(candle);
    if (candles.length > BUFFER_SIZE) candles.shift();
  }
}

/**
 * Bir sembol + TF için mum listesini getir
 * REST ile seed edilen veriler de buraya eklenir
 */
function get(symbol, tf) {
  return store[symbol]?.[tf] ?? [];
}

/**
 * REST API'dan gelen tarihsel mumları başlangıçta yükle (seed)
 * @param {string} symbol
 * @param {string} tf
 * @param {Array}  klines  - Binance REST /klines formatı: [openTime, o, h, l, c, v, ...]
 */
function seed(symbol, tf, klines) {
  if (!store[symbol]) store[symbol] = {};
  store[symbol][tf] = klines.map(k => ({
    ts:      k[0],
    open:    parseFloat(k[1]),
    high:    parseFloat(k[2]),
    low:     parseFloat(k[3]),
    close:   parseFloat(k[4]),
    volume:  parseFloat(k[5]),
    isFinal: true,
  })).slice(-BUFFER_SIZE);
}

/**
 * Yeterli mum var mı? (indikatör hesabı için en az 50 mum gerekli)
 */
function isReady(symbol, tf, minCandles = 50) {
  return (store[symbol]?.[tf]?.length ?? 0) >= minCandles;
}

module.exports = { init, update, get, seed, isReady };
