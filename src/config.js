'use strict';

module.exports = {

  // ── MOD ───────────────────────────────────────────────
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
    maxCoins:         30,
    excludeKeywords:  ['UP', 'DOWN', 'BULL', 'BEAR', 'USDC', 'BUSD'],
  },

  wsTimeframes:     ['5m', '15m', '1h'],
  restTimeframes:   ['4h', '1d'],
  restPollInterval: 4 * 60 * 60 * 1000,

  ema21DistanceThreshold: 0.5,
  ema21TouchLookback:     3,

  rsiEntryMin:      90,
  rsiEntryMax:      98,
  rsiEMCThreshold:  95,
  rsi1hMin:         70,
  rsi4hMin:         70,

  volumeRatioMin:   1.5,
  initialRiskPct:   0.5,

  minScoreToSend:   40,

  cooldownMs:        5 * 60 * 1000,
  // NOT: reconnectDelayMs ve pingIntervalMs kasıtlı olarak kaldırıldı —
  // 'binance' kütüphanesi hem ping/pong keepalive'ı hem de reconnect'i
  // her bağlantı (wsKey) için kendi içinde otomatik yönetiyor. Manuel
  // restart/ping kütüphanenin kendi mekanizmasıyla çakışıp production'da
  // "No wsKey provided" crash'ine yol açmıştı (bkz. binanceClient.js).

  rsiPeriod:    14,
  emaPeriod:    21,
  atrPeriod:    14,
  smaPeriod:    20,

  snapshotWindows: [
    5  * 60 * 1000,
    15 * 60 * 1000,
    60 * 60 * 1000,
    4  * 60 * 60 * 1000,
  ],
};
