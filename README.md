# Scalp Sinyal Motoru

> Binance USDT-M Futures için RSI + Volume + Multi-Timeframe scalp sinyal botu  
> Mert stratejisi entegreli — Telegram alert, Trade Event takibi, Rejim tespiti

---

## Mimari

```
DATA (WebSocket + REST)
  └── Market Regime Tespiti
        └── Setup Detector (3A Mert Kapısı)
              └── Hard Gates
                    └── Score Engine (0–100)
                          └── Trade Plan (TP/SL)
                                └── Event Tracker (MFE/MAE/R-multiple)
                                      └── Performance DB (SQLite)
```

## Dosya Yapısı

```
scalp-bot/
├── src/
│   ├── index.js          # Ana giriş noktası
│   ├── config.js         # Tüm parametreler
│   ├── binanceClient.js  # WebSocket + REST istemcisi
│   ├── candleStore.js    # Mum tamponu (her sembol × TF)
│   ├── indicators.js     # RSI, EMA, ATR, CVD, negatif tepe
│   ├── regime.js         # Market regime tespiti (Reversal / Continuation)
│   ├── gates.js          # Mert 3A zorunlu koşullar
│   ├── scorer.js         # 0–100 skor motoru + derece sistemi
│   ├── levels.js         # Günlük EMA200/direnç + yakınlık (canlı + backtest ortak)
│   ├── tradePlan.js      # TP-A/TP-B/SL planı (canlı + backtest ortak)
│   ├── backtest.js       # Look-ahead'siz geçmiş test
│   ├── signalEngine.js   # Orkestrasyon — evaluate()
│   ├── htfPoller.js      # 4h/1D REST polling + OI delta
│   ├── eventTracker.js   # MFE/MAE/TP-SL hit/R-multiple takibi
│   ├── telegram.js       # Alert gönderimi + bot komutları
│   └── db.js             # SQLite sinyal log + sorgular
├── .env.example
├── .gitignore
├── package.json
└── README.md
```

## Kurulum

```bash
git clone <repo>
cd scalp-bot
npm install
cp .env.example .env
# .env dosyasını düzenle
```

## Çalıştırma

```bash
# Test modu (config.js'deki testSymbols)
node src/index.js

# Development (hot reload)
npm run dev
```

## Fly.io'ya Deploy

Bot bir arka plan worker'ı (WebSocket + REST polling + Telegram bot) — HTTP
servisi açmadığı için `fly.toml`'da `[http_service]` bloğu yok.

**Önkoşul:** Binance Futures API ABD IP'lerini (`iad`, `ord`, `sea`, `dfw`
vb.) 451 hatasıyla engeller. `primary_region` mutlaka `fra` (Frankfurt)
veya `ams` (Amsterdam) olmalı — `fly.toml`'da zaten öyle ayarlı.

```bash
# 1. flyctl kur (bir kere)
curl -L https://fly.io/install.sh | sh

# 2. Giriş yap
fly auth login

# 3. fly.toml'daki app adını değiştir (global olarak benzersiz olmalı)
#    "scalp-bot-CHANGEME" → "scalp-bot-senin-adin"

# 4. Uygulamayı oluştur (henüz deploy etme)
fly apps create scalp-bot-senin-adin

# 5. Kalıcı disk oluştur — SQLite burada yaşayacak
fly volumes create scalp_data --region fra --size 1

# 6. Secrets tanımla (API anahtarları imaja gömülmez, .env kullanılmaz)
fly secrets set \
  BINANCE_API_KEY=xxx \
  BINANCE_API_SECRET=xxx \
  TELEGRAM_BOT_TOKEN=xxx \
  TELEGRAM_CHAT_ID=xxx

# 7. Deploy et
fly deploy

# 8. Logları izle
fly logs

# 9. Bağlan / durumu kontrol et
fly status
fly ssh console
```

**Güncelleme:** kod değiştikçe `git push` sonrası tekrar `fly deploy`
çalıştırman yeterli — volume ve secrets kalıcı, sıfırlanmaz.

**Maliyet:** `shared-cpu-1x` + 512MB RAM + 1GB volume ≈ $3–4/ay
(Fly.io'da artık ücretsiz katman yok, kullandığın kadar öde).

## Config

`src/config.js` — tüm parametreler buradan yönetilir:

| Parametre | Varsayılan | Açıklama |
|---|---|---|
| `mode` | `'test'` | `'test'` \| `'production'` |
| `testSymbols` | `['BTCUSDT',...]` | Test modunda izlenecek coinler |
| `rsiEntryMin` | `90` | 5m/15m RSI giriş eşiği |
| `rsiEMCThreshold` | `95` | Extreme Momentum Condition eşiği (15m) |
| `ema21DistanceThreshold` | `0.5` | Min EMA21 uzaklığı (ATR cinsinden) |
| `initialRiskPct` | `0.5` | R-multiple hesabı için risk % |
| `minScoreToSend` | `40` | Bu skoru geçemeyen sinyal gönderilmez |

## Telegram Komutları

| Komut | Açıklama |
|---|---|
| `/signals` | Son 10 sinyal |
| `/stats` | Genel istatistik |
| `/winrate` | Dereceye göre win rate |
| `/regime` | Rejime göre win rate |
| `/emc` | EMC (15m RSI 95+) analizi |
| `/best` | En başarılı coinler |
| `/worst` | En başarısız coinler |
| `/report` | Performans raporu |

## Sinyal Dereceleri

| Derece | Puan | Anlamı |
|---|---|---|
| A+ | 85–100 | Çok yüksek güven |
| A  | 70–84  | Yüksek güven |
| B  | 55–69  | Orta — dikkatli ol |
| C  | 40–54  | Bilgi amaçlı |
| D  | 0–39   | Gönderilmez |

## Validasyon Sırası

> Bu sıra atlanmaz. Canlıya çıkmadan önce:

1. **Backtest** → geçmiş veri
2. **Walk-Forward** → out-of-sample test
3. **Paper Trade** → gerçek zamanlı, sıfır risk
4. **Small Capital** → gerçek işlem, küçük lot

## Backtest Çalıştırma

Binance'e erişimi olan bir yerde çalıştır (`fly ssh console` içinde `cd /app` ya da kendi Ubuntu ortamın):

```bash
node src/backtest.js                                   # config.testSymbols, 90 gün
node src/backtest.js --symbol BTCUSDT,ETHUSDT --days 30
node src/backtest.js --days 90 --min-score 55
```

- Veri sayfalanarak çekilir; `--days` gerçekten o kadar günü kapsar (+200 mum ısınma).
- Look-ahead yok: her 5m kararında 15m/1h/4h için yalnızca o ana kadar kapanmış mumlar +
  5m'lerden kurulan devam eden mum kullanılır; günlük seviyeler 4 saatte bir o ana kadarki
  veriyle hesaplanır (canlı `htfPoller` gibi).
- Kapı, TP planı ve skor canlı botla aynı modüllerden gelir (`gates`, `tradePlan`, `scorer`, `levels`).
- Rate limit koruması: istekler arası 350 ms (≈ 860 weight/dk, limit 2400).
  Sembol başına 90 günde ~40 istek → ~15–20 sn.
- Raporda "Eleme Hunisi" sinyallerin hangi kapıda elendiğini gösterir.
- Sonuçlar `backtest-results/*.json` dosyasına yazılır.

## Önemli Notlar

- **RSI 90 eşiği** backtest sonuçlarıyla doğrulanacak, gerekirse revize edilecek
- **EMC** (15m RSI 95+) "kesin giriş" değil, ek bir momentum sinyalidir
- **Momentum Continuation** rejiminde SHORT sinyali üretilmez
- **2026 Nisan sonrası** kline stream'leri `wss://fstream.binance.com/market` endpoint'inden açılmalı
- Her sinyalin MFE/MAE/R-multiple'ı kaydedilir — performans kalibrasyonu için

## Gereksinimler

```
Node.js >= 20
Binance Futures API key (okuma yetkisi yeterli)
Telegram bot token + chat ID
```
