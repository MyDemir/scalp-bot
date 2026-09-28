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

  rsiEntryMin:      90,
  rsiEntryMax:      98,
  rsiEMCThreshold:  95,

  // Planın giriş tetikleyicisi — ŞİMDİLİK YALNIZCA BACKTEST'TE (--compare) kullanılır.
  // Canlı bot yukarıdaki "5m/15m RSI rsiEntryMin–rsiEntryMax" tetikleyicisiyle çalışmaya devam eder.
  //   rsiTFs  : RSI'ı bu TF'lerin en yükseği tetikler
  //   entryTF : EMA21 uzaklığı/dokunuşu, ATR, TP-A/TP-B, hacim/CVD ve rejim bu TF'den
  planTrigger: { rsiTFs: ['3m', '5m'], entryTF: '3m', rsiMin: 95, rsiMax: 98 },

  rsi1hMin:         70,
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
