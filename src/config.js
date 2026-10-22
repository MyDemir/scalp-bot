'use strict';

module.exports = {

  info: {
    rsiMin:        85,
    rsiMin2:       90,
    rsiEntryMax:   100,
    confluencePct: 0.5,

    // Derece (daire sayısı). gradeBy 'sart3': 1 + sağlanan şart (EMA21 ayrışma · 1s RSI ≥ gradeRsi1h · 15m RSI ≥ gradeRsi15m)
    //   18–20.10 verisi (769 kart, 60 dk sonra aşağıda): 0 şart %14 · 1 → %28 · 2 → %61 · 3 → %72 (kontrol listesi skoru 3 → %47)
    // gradeBy 'liste': kontrol listesi skoru — 1–2 → 1 · 3–4 → 2 · 5–6 → 3 · 7+ → 4
    gradeBy:       'sart3',
    gradeRsi1h:    80,
    gradeRsi15m:   85,
    gradeAtr5Pct:  1.2,      // derece şartı: 5dk ATR (fiyatın %'si) en az; 0 = kapalı
    gradeRsi1hMax: 88,      // sart3: 1s RSI bu ve üstü ya da 4s RSI ≥ gradeRsi4hMax → kaçak pompa (0 = kapalı)
    gradeRsi4hMax: 80,
    gradeRunawayMax: 2,     // kaçak pompada en fazla bu kadar daire
    gradeNoLevelMax: 3,     // sart3: %2.5 içinde direnç yoksa (fiyat keşfi) en fazla bu kadar daire
    grade2Min:     3,
    grade3Min:     5,
    grade4Min:     7,

    minTFs:        2,
    strongRsi:     95,
    rsiPeriod:     14,
    levelMaxPct:   2.5,
    dipBelowPct:   0.5,
    dipAbovePct:   0.5,    // SFP + Dirençte üst payı %0.5
    levelRequired: true,

    levelsSwing:   true,
    swingBars:     3,
    zoneTouches:   3,
    levelsFib:     true,
    levelsWeeklyZone: true,  // YENİ: haftalık bölge

    sfpCards:      true,
    sfpBars:       6,
    sfpAbovePct:   0.5,      // YENİ: SFP kırılım eşiği %0.5

    discoveryCards: true,
    burstPct1:     1.0,
    burstPct2:     1.5,
    volMult:       2.0,
    volAvgN:       20,
    takerBuyPct:   55,
    takerSellPct:  45,
    volGrade2X:    3,
    dirGrade3Pct:  65,
    windowMin:     60,
    shortWindowMin: 15,
    resetRsi:      75,      // kart no. sıfırlama: kapanmış 15m RSI bunun altına inince

    seriesBursts:  true,
    seriesMinRsi15m: 85,     // seri içi için o an 15m RSI ≥ 85

    // EMA21 yüzde ayrışma (güven skoru kademeli)
    sepPct2:       2,
    sepPct5:       5,
    sepPct10:      10,
    sepATR:        0.5,      // eski ATR (isteğe bağlı bilgi)
    sepRequired:   false,

    confRsi:       80,
    confRequired:  false,
    macdRequired:  false,

    // 🔻 Tepe reddi bildirimi (src/peakAlert.js) — kart biçimine dokunmaz, ayrı mesaj
    peakAlert:        true,
    peakAlertMin:     4,     // skor (mum reddi · kırmızı · hacim · Asya/Avrupa seansı) en az; 4 → yalnız 03–15 TSİ
    peakAlertAtrPct:  1.2,   // 5dk ATR (fiyatın %'si) en az; 0 = kapalı. 18–20.10 verisi: skor 4 + ATR ≥ 1.2 → 60 dk sonra %78 aşağıda (ATR'siz %68)
    peakAlertPumpPct: 5,     // pompa (4 saatlik dipten) en az %
    peakAlertGapMin:  30,    // coin başına en fazla … dk'da bir
    peakAlertRsiOnly: false, // true: yalnız RSI kart şartı (rsiMin, minTFs) o an sağlanan coinlerde

    // 🌊 Spot/futures akış takibi (src/spotFlow.js) — yalnız /akis komutu ve panel, kartı etkilemez
    flowK:         6,       // etiket için son … pencere (fiyat eğimi + CVD)
    flowCvdPct:    3,       // CVD (net akış / hacim) ±% eşiği
    flowPricePct:  2,       // fiyat ±% altı = yatay
    flowStrongX:   1.5,     // hacim katı ≥ → "güçlü"
    flowWeakX:     0.7,     // hacim katı < → "zayıf hacim"
    flowBuyPct:    55,      // son pencere alış ≥ % → 🟢
    flowSellPct:   45,      // son pencere alış ≤ % → 🔴
    // 🐋 büyük alım/satım (src/bigTrades.js): coin başına eşik = max(flowBigMinUsd, son günlük spot hacmi × flowBigPct / 100)
    flowBigPct:    0.05,    // ör. 10M $ günlük hacim → 5K $, 100M $ → 50K $, 1B $ → 500K $
    flowBigMinUsd: 5000,

    minVolumeM:    3,
    tradfi:        false, // kripto dışı kontratlar (hisse · ETF · emtia · döviz — Binance TRADIFI_PERPETUAL) izlensin mi
    moveAlertPct:  2,
    cardSound:     true,
    chart:         true,   // RSI kartları ve /coin
    chartPeak:     true,   // 🔻 tepe reddi bildirimi (RSI kartından bağımsız)
    chartTf:       '1h',
    chartFib:      true,
    chartIchi:     true,
    chartMinTouches: 4,      // grafik içi çizgiler yalnız en az bu kadar test edilmiş dirençler (4h mumlar ~100 gün); sağ üst liste hepsi (★ = güçlü); kartın direnci hep görünür
    ichiTenkan:    10,
    ichiKijun:     30,
    ichiChikou:    30,
    ichiSenkouB:   60,
    ichiShift:     30,
  },

  // Düşüş defteri (src/eventLog.js) — yalnız kayıt/istatistik, kartı etkilemez
  events: {
    pumpPct:        3,     // tepe, son 4 saatin dibinden en az bu kadar % yukarıda (pompa)
    pumpLookbackMin: 240,
    localHighMin:   60,    // tepe = son 60 dk'nın en yükseği
    peakWindowMin:  15,    // düşüş tepeden sonra en geç bu kadar dk içinde
    dropPct:        1.5,   // tepeden en az bu kadar % düşüş
    sampleGapMin:   5,     // "devam" eden adaylar (pompa sürerken) en fazla bu kadar dk'da bir kaydedilir; düştü/yatay hep
    cardBeforeMin:  15,    // "kartlı": tepeden 15 dk önce …
    cardAfterMin:   5,     // … ile düşüşten 5 dk sonrası arasında kart
    windows:        [5, 15, 30, 60, 240],   // sonrası pencereleri (dk) — cards.db sütunları (cardStore EVENT_WINDOWS) ile aynı olmalı
  },

  autoFilter: {
    excludeBaseAssets: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USD1', 'USDS', 'PYUSD', 'RLUSD'],
  },

  ws: {
    streamsPerConnection: 800,
    staleMs:              60_000,
  },

  heartbeatMs: 5 * 60 * 1000,
  telegramMinIntervalMs: 3_100,
};
