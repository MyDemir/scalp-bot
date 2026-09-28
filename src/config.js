'use strict';

module.exports = {

  // ── MOD ───────────────────────────────────────────────
  // 'test'       → testSymbols izlenir (Binance'te olmayanlar başlangıçta uyarıyla çıkarılır)
  // 'production' → autoFilter ile hacme göre perpetual'lar; tüm market için maxCoins: 0
  mode: 'test',

  testSymbols: [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'BNBUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'DOTUSDT',
    'LTCUSDT',
    'ADAUSDT',
    'ARBUSDT',
    'OPUSDT',
    'POLUSDT',
    'INJUSDT',
    'SUIUSDT',
    'APTUSDT',
  ],

  autoFilter: {
    minVolume24hUSDT: 50_000_000,
    maxCoins:         30,          // 0 = sınırsız (tüm market)
    // Baz varlıkta TAM eşleşme (eski 'UP' alt dize araması JUPUSDT/SUPERUSDT'yi eliyordu)
    excludeBaseAssets: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE'],
  },

  // 4h de WebSocket'ten — canlı güncellenir (eskiden 4 saatte bir REST ile bayat geliyordu)
  wsTimeframes:     ['5m', '15m', '1h', '4h'],
  restTimeframes:   ['1d'],
  restPollInterval: 4 * 60 * 60 * 1000,   // 1D seviyeler + OI + funding

  ema21DistanceThreshold: 0.5,
  ema21TouchLookback:     3,

  // Giriş RSI eşikleri — HEPSİ birden sağlanmalı: 5m ≥ rsi5mMin VE 15m ≥ rsi15mMin
  // (+ 1h ≥ rsi1hMin, 4h ≥ rsi4hMin). Üst sınır: max(5m, 15m) ≤ rsiEntryMax.
  // Backtest'te kodu değiştirmeden başka değer denemek için: --rsi5m 90 --rsi15m 85 --rsi1h 80 --rsi4h 70
  rsi5mMin:         90,
  rsi15mMin:        85,
  rsiEntryMax:      98,
  rsiEMCThreshold:  95,

  // Mert varyantı — ŞİMDİLİK YALNIZCA BACKTEST'TE (--compare). Kurallar src/mert.js başında.
  mert: {
    rsiTFs:        ['3m', '5m', '15m'],   // karar: bunlardan en az minTFs tanesi ≥ rsiMin
    capTFs:        ['3m', '5m'],          // üst sınır (Mert: "3–5 dk 95–98 aralığı")
    rsiCap:        98,
    rsi1hMin:      70,                    // "1s ve 4s RSI de şişmişse"
    rsi4hMin:      70,
    levelBelowPct: 0.5,                   // fiyat seviyenin altında en fazla %0.5
    levelAbovePct: 0.3,                   // üstünde en fazla %0.3 (fitil payı); daha yukarıdaysa sinyal yok
    separationATR: 0.5,                   // 3m ve 5m EMA21'den en az 0.5 ATR uzak
    h4History:     600,                   // 4h EMA200'ün oturması için geçmiş (mum)
    grid: { rsiMin: [90, 95], minTFs: [2, 3], slPct: [1.0, 1.5] },
    selectionFraction: 2 / 3,             // walk-forward: dönemin ilk 2/3'ü seçim, son 1/3'ü doğrulama
  },

  rsi1hMin:         80,
  rsi4hMin:         70,

  volumeRatioMin:   1.5,
  initialRiskPct:   0.5,

  minScoreToSend:   40,

  cooldownMs:        5 * 60 * 1000,

  // ── SİSTEM ────────────────────────────────────────────
  // WebSocket: ping/pong ve yeniden bağlanma streamClient.js'te (combined stream)
  ws: {
    streamsPerConnection: 800,   // Binance limiti 1024
    staleMs:              60_000, // bu süre veri gelmezse bağlantı yenilenir
  },

  // Her 5 dk'da bir tek satırlık sağlık özeti (mesaj/kapanış/değerlendirme/red nedenleri/bellek)
  heartbeatMs: 5 * 60 * 1000,

  // Sembol başına "[GATE] X reddedildi" satırı. null = otomatik (test: açık, production: kapalı —
  // tüm markette 5 dk'da yüzlerce satır olur; red nedenleri heartbeat'te özetlenir)
  logGateRejects: null,

  // Telegram grup limiti dakikada 20 mesaj → mesajlar arası en az ~3 sn
  telegramMinIntervalMs: 3_100,

  rsiPeriod:    14,
  emaPeriod:    21,
  atrPeriod:    14,
  smaPeriod:    20,
};
