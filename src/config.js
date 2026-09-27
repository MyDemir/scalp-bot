'use strict';

module.exports = {

  // ── MOD ───────────────────────────────────────────────
  // 'test'       → testSymbols listesi izlenir, az stream, sıfır ban riski
  // 'production' → volume filtresiyle otomatik coin çekme
  mode: 'test',

  testSymbols: [
    // Referans
    'BTCUSDT',
    'ETHUSDT',
    // Yüksek hacim / volatil
    'SOLUSDT',
    'BNBUSDT',
    'AVAXUSDT',
    // Orta likidite
    'LINKUSDT',
    'DOTUSDT',
    'LTCUSDT',
    'ADAUSDT',
    // L2 / Yeni nesil
    'ARBUSDT',
    'OPUSDT',
    'POLUSDT',   // eski MATICUSDT → kontrol et, Binance'te POLUSDT olabilir
    // Yüksek volatilite / Altcoin
    'INJUSDT',
    'SUIUSDT',
    'APTUSDT',
  ],

  autoFilter: {
    minVolume24hUSDT: 50_000_000,   // min 50M USDT günlük hacim
    maxCoins:         30,            // en likit 30 coin
    excludeKeywords:  ['UP', 'DOWN', 'BULL', 'BEAR', 'USDC', 'BUSD'],
  },

  // ── STREAM ────────────────────────────────────────────
  wsTimeframes:     ['5m', '15m', '1h'],   // WebSocket combined stream
  restTimeframes:   ['4h', '1d'],           // REST polling (HTF)
  restPollInterval: 4 * 60 * 60 * 1000,    // 4 saatte bir

  // ── STRATEJİ EŞİKLERİ ────────────────────────────────
  ema21DistanceThreshold: 0.5,  // ATR katsayısı — EMA21 uzaklık minimum
  ema21TouchLookback:     3,    // son kaç mumda EMA21 dokunuş kontrolü

  rsiEntryMin:      90,   // 5m/15m giriş eşiği (backtest ile doğrulanacak)
  rsiEntryMax:      98,   // 5m/15m üst sınır
  rsiEMCThreshold:  95,   // Extreme Momentum Condition (15m)
  rsi1hMin:         70,   // 1h min overbought
  rsi4hMin:         70,   // 4h min overbought

  volumeRatioMin:   1.5,  // minimum hacim spike çarpanı
  initialRiskPct:   0.5,  // varsayılan risk % (R-multiple hesabı için)

  // Sinyal göndermek için minimum skor eşiği (D < 40 gönderilmez)
  minScoreToSend:   40,

  // ── SİSTEM ────────────────────────────────────────────
  cooldownMs:        5 * 60 * 1000,  // aynı coin için 5 dakika cooldown
  reconnectDelayMs:  3_000,           // WS kopunca yeniden bağlanma
  pingIntervalMs:    150_000,         // 2.5 dakikada bir ping

  // RSI hesabı için gereken minimum mum sayısı
  rsiPeriod:    14,
  emaPeriod:    21,
  atrPeriod:    14,
  smaPeriod:    20,   // volume SMA

  // Trade event takip pencereleri (ms)
  snapshotWindows: [
    5  * 60 * 1000,   // +5dk
    15 * 60 * 1000,   // +15dk
    60 * 60 * 1000,   // +1h
    4  * 60 * 60 * 1000, // +4h
  ],
};
