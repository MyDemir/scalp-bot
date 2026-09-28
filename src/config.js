'use strict';

module.exports = {

  // ── BİLGİ BOTU ────────────────────────────────────────
  // Buradakiler VARSAYILAN değerler. Telegram'dan /ayarlar ile değiştirilenler /data/info-settings.json'a
  // yazılır ve bunların önüne geçer (deploy sonrası korunur). Anlamları: src/infoSettings.js
  info: {
    // RSI derecesi (kart başlığındaki daireler):
    //   🔴     : 3m/5m/15m'den en az minTFs tanesinde RSI ≥ rsiMin (kart eşiği)
    //   🔴🔴   : en az minTFs tanesinde RSI ≥ rsiMin2 VE üstte %levelMaxPct içinde seviye (2 şart)
    //   🔴🔴🔴 : üç dilimde de RSI ≥ rsiMin2 + fiyat dirence dayalı (dipte) + EMA21 ayrışması (tüm şartlar)
    rsiMin:        85,     // kart eşiği (🔴)
    rsiMin2:       90,     // 🔴🔴 / 🔴🔴🔴 eşiği
    minTFs:        2,      // eşiği geçmesi gereken dilim sayısı (3 üzerinden)
    strongRsi:     95,     // RSI satırında 🔴🔴🔴 ve "95 üstüne çıktı" yeniliği
    rsiPeriod:     14,     // RSI periyodu (Binance/TradingView varsayılanı 14; Binance uygulamasındaki RSI(6) daha oynaktır)
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
    // Hacim derecesi (hacimli mum ve ⚡ hareket uyarısı):
    //   🔴 temel şart (hacimli mum / 1 dk ≥ %2) · 🔴🔴 + hacim ≥ volGrade2X × ortalama
    //   🔴🔴🔴 + alış/satış oranı hareket yönünde ≥ %dirGrade3Pct
    volGrade2X:    3,
    dirGrade3Pct:  65,
    windowMin:     60,     // sayaç penceresi (dk)
    shortWindowMin: 15,    // kısa sayaç penceresi (dk)
    resetRsi:      75,     // 5m RSI bunun altında kapanınca kart numarası sıfırlanır (#1'den başlar)
    seriesBursts:  true,   // seri sürerken (numara sıfırlanmadan) gelen hacimli mum şart aranmadan kart olur
    sepATR:        0.5,    // EMA21 ayrışması (3m & 5m, ATR cinsinden)
    sepRequired:   false,
    confRsi:       70,     // destek: 1h / 4h RSI ≥ bu
    confRequired:  false,  // açıksa 1h veya 4h'ten en az biri ≥ confRsi olmalı
    macdRequired:  false,  // açıksa 5m MACD histogramı zayıflıyor (düşüyor ya da ≤ 0) olmalı
    minVolumeM:    3,      // izlenen evren: 24s hacim ≥ 3 milyon USDT
    // Hareket uyarısı: herhangi bir paritede 1m kapanış, bir önceki 1m kapanışa göre ≥ %moveAlertPct
    moveAlertPct:  2,      // 0 = kapalı
    moveAlertAll:  true,   // true: TÜM USDT perpetual'lar (hacim filtresi yok) · false: yalnızca izlenen evren
    moveAlertSound: true,  // hareket uyarıları sesli
    // Grafik (5m mumlar + Ichimoku + hacim + seviye) — kartlara ve ⚡ uyarılara fotoğraf olarak eklenir
    chart:         true,
    chartMoves:    true,
    // Ichimoku — KivancOzbilgic "ICHIMOKU Kinko Hyo by KIVANC" düzeni (5 parametre). Kripto önerisi 1-3-3-6-3
    // oranında 10/30/30/60/30 (klasik: 9/26/26/52/26). /ayar ichiTenkan 9 … ile değişir.
    ichiTenkan:    10,
    ichiKijun:     30,
    ichiChikou:    30,
    ichiSenkouB:   60,
    ichiShift:     30,
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
