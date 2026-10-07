'use strict';

module.exports = {

  info: {
    rsiMin:        85,
    rsiMin2:       90,
    rsiEntryMax:   100,
    confluencePct: 0.5,

    // Güven skoru (max 4 daire)
    // 1–2 → 1 · 3–4 → 2 · 5–6 → 3 · 7+ → 4
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
    resetRsi:      75,

    seriesBursts:  true,
    seriesMinRsi5m: 85,      // YENİ: seri içi için 5m RSI ≥ 85

    // EMA21 yüzde ayrışma (güven skoru kademeli)
    sepPct2:       2,
    sepPct5:       5,
    sepPct10:      10,
    sepATR:        0.5,      // eski ATR (isteğe bağlı bilgi)
    sepRequired:   false,

    confRsi:       80,
    confRequired:  false,
    macdRequired:  false,

    minVolumeM:    3,
    moveAlertPct:  2,
    cardSound:     true,
    chart:         true,
    chartTf:       '1h',
    chartFib:      true,
    chartIchi:     true,
    chartMinTouches: 4,      // grafikte yalnız en az bu kadar test edilmiş dirençler (4h mumlar ~100 gün); kartın direnci hep görünür
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
    windows:        [5, 15, 60, 240],   // sonrası pencereleri (dk) — cards.db sütunları bunlara göre, DEĞİŞTİRME
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
