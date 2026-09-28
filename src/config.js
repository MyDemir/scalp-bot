'use strict';

module.exports = {

  // ── BİLGİ BOTU ────────────────────────────────────────
  // Buradakiler VARSAYILAN değerler. Telegram'dan /ayarlar ile değiştirilenler /data/info-settings.json'a
  // yazılır ve bunların önüne geçer (deploy sonrası korunur). Anlamları: src/infoSettings.js
  info: {
    rsiMin:        90,     // 3m/5m/15m RSI eşiği
    minTFs:        2,      // eşiği geçmesi gereken dilim sayısı (3 üzerinden)
    strongRsi:     95,     // "RSI 95↑" yeniliği ve kartta vurgu
    levelMaxPct:   2.5,    // ZORUNLU: fiyatın üstünde en fazla bu kadar uzakta bir seviye
    dipBelowPct:   0.5,    // DİPTE sınıfı: seviyenin en fazla %0.5 altında …
    dipAbovePct:   0.3,    // … ya da en fazla %0.3 üstünde (fitil payı). Daha yukarısı = seviye kırıldı
    levelRequired: true,
    burstPct1:     1.0,    // hacim patlaması: 1m mum gövdesi ≥ %1 …
    burstPct2:     1.5,    // … ikinci kademe ≥ %1.5
    volMult:       2.0,    // hacim ≥ önceki volAvgN mumun ortalaması × volMult
    volAvgN:       20,
    takerBuyPct:   55,     // taker alış oranı > %55 → alım
    takerSellPct:  45,     // < %45 → satış (arası nötr)
    windowMin:     60,     // sayaç penceresi (dk)
    shortWindowMin: 15,    // kısa sayaç penceresi (dk)
    resetRsi:      75,     // 5m RSI bunun altında kapanınca kart numarası sıfırlanır (#1'den başlar)
    seriesBursts:  true,   // seri sürerken (numara sıfırlanmadan) gelen hacimli mum şart aranmadan kart olur
    sepATR:        0.5,    // EMA21 ayrışması (3m & 5m, ATR cinsinden)
    sepRequired:   false,
    confRsi:       70,     // destek: 1h / 4h RSI ≥ bu
    confRequired:  false,  // açıksa 1h veya 4h'ten en az biri ≥ confRsi olmalı
    macdRequired:  false,  // açıksa 5m MACD histogramı zayıflıyor (düşüyor ya da ≤ 0) olmalı
    minVolumeM:    5,      // izlenen evren: 24s hacim ≥ 5 milyon USDT
  },

  // Evrenden hariç tutulan baz varlıklar (stabil coinler) — TAM eşleşme
  autoFilter: {
    excludeBaseAssets: ['USDC', 'FDUSD', 'TUSD', 'USDP', 'BUSD', 'DAI', 'USDE', 'USD1', 'USDS', 'PYUSD', 'RLUSD'],
  },

  // ── SİSTEM ────────────────────────────────────────────
  // WebSocket: ping/pong ve yeniden bağlanma streamClient.js'te (combined stream)
  ws: {
    streamsPerConnection: 800,   // Binance limiti 1024
    staleMs:              60_000, // bu süre veri gelmezse bağlantı yenilenir
  },

  // Her 5 dk'da bir tek satırlık sağlık özeti
  heartbeatMs: 5 * 60 * 1000,

  // Telegram grup limiti dakikada 20 mesaj → mesajlar arası en az ~3 sn
  telegramMinIntervalMs: 3_100,
};
