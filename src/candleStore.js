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

  if (last && candle.ts < last.ts) {
    // Geç gelen eski mum (ör. REST birleştirmesinden sonra) — sırayı bozma, varsa yerinde güncelle
    const idx = candles.findIndex(c => c.ts === candle.ts);
    if (idx >= 0) candles[idx] = candle;
    return;
  }

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
 * REST API'dan gelen mumları mevcut tamponla BİRLEŞTİR (seed / boşluk doldurma)
 *
 * Eski sürüm tamponu tamamen değiştiriyordu. Artık WebSocket seed'den ÖNCE başlıyor
 * (seed sırasında kapanan mumlar kaçmasın diye) ve kopma sonrası sadece birkaç mum
 * çekiliyor — ikisi de mevcut veriyi silmemeli. Aynı ts'de REST verisi esas alınır,
 * REST'ten sonra WebSocket'ten gelmiş daha yeni mumlar korunur.
 *
 * @param {string} symbol
 * @param {string} tf
 * @param {Array}  klines  - Binance REST /klines formatı: [openTime, o, h, l, c, v, closeTime, ...]
 */
function seed(symbol, tf, klines) {
  if (!store[symbol]) store[symbol] = {};
  const now = Date.now();
  const byTs = new Map((store[symbol][tf] || []).map(c => [c.ts, c]));
  for (const k of klines) {
    const ts = Number(k[0]);
    byTs.set(ts, {
      ts,
      open:    parseFloat(k[1]),
      high:    parseFloat(k[2]),
      low:     parseFloat(k[3]),
      close:   parseFloat(k[4]),
      volume:  parseFloat(k[5]),
      isFinal: k[6] != null ? Number(k[6]) < now : true,
    });
  }
  store[symbol][tf] = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-BUFFER_SIZE);
}

/**
 * Yeterli mum var mı? (indikatör hesabı için en az 50 mum gerekli)
 */
function isReady(symbol, tf, minCandles = 50) {
  return (store[symbol]?.[tf]?.length ?? 0) >= minCandles;
}

module.exports = { init, update, get, seed, isReady };
