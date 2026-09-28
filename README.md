# Scalp Bilgi Botu

> Binance USDT-M Futures — **bilgi / sınıflandırma botu**. Koşulları sağlayan coinler için Telegram'a
> bilgi kartı gönderir; **işleme girme kararı kullanıcıdadır** (otomatik işlem yok).
> Eski SHORT sinyal botu da duruyor: `BOT_MODE=signal` (aşağıda "Eski sinyal botu").

---

## Bilgi Botu (varsayılan)

### Ne izler
Tüm USDT perpetual pariteler, **24s hacim ≥ 5 milyon $** (stabil coinler hariç). Liste saatte bir
yenilenir: yeni coinler eklenir, hacmi eşiğin %80'inin altına düşenler çıkar.

Veri: coin başına **tek WebSocket akışı** (1m kline, yalnızca kapanışlar işlenir). 3m/5m/15m/1h/4h/1d
mumları botun kendisi 1m'lerden üretir (`src/series.js`) → tüm market tek bağlantıya sığar.
Başlangıçta her zaman dilimi REST'ten yüklenir (birkaç dakika; hazır olan coin hemen değerlendirilir).

### Kart ne zaman gelir
Kontrol anı: **3m / 5m / 15m mum kapanışları** + **hacimli her 1m mum kapanışı**. Kart için:

| Şart | Varsayılan |
|---|---|
| 3m/5m/15m RSI | en az **2/3** dilimde **≥ 90** (kapanmamış dilimde devam eden mumla — kartta `~`) |
| Seviye (zorunlu) | fiyatın üstünde en fazla **%2.5** uzakta bir seviye: 4h MA200 · 4h EMA200 · 1d MA200 · 1d EMA200 · günlük direnç (son 30 **kapanmış** günün en yüksek 3 tepesi) |
| Yeni veri | önceki karttan bu yana: RSI dilim sayısı değişti · bir dilim 95'i geçti · hacimli mum · seviye/bölge değişti (DİPTE'ye girdi, seviye kırıldı) · MACD ya da Stoch RSI kesişimi. **Yeni veri yoksa kart gitmez.** |

Seviye kırılırsa (fiyat seviyenin %0.3'ten fazla üstünde) o seviye sayılmaz, bir üstteki aranır.
Aynı coinde kartlar **#1, #2 …** diye numaralanır; kapanmış 5m RSI 75'in altına inince numara sıfırlanır.

### Kartın içeriği
- Başlık: coin, kart no, fiyat, RSI x/3, saat · **🆕** bu kartı doğuran yeni veri
- RSI 3m/5m/15m · seviye + mesafe (**⭐ DİPTE**: seviyenin %0.5 altı–%0.3 üstü, ya da **↗ yaklaşıyor**)
- EMA21 ayrışması (3m/5m, ATR) · destek RSI (1h/4h ≥ 70)
- **Hacim sayacı** (60 dk ve 15 dk): 1m gövde ≥ %1 / ≥ %1.5 ve hacim ≥ 2× (önceki 20 mum ortalaması);
  taker alış > %55 → ▲ alım, < %45 → ▼ satış, arası ◆ nötr. Art arda gelen patlama mumları tek patlama sayılır.
- Taker net akış (USDT) · **Detaylar** (dokununca açılır): MACD 5m/15m, Stoch RSI 5m, günlük VWAP ±σ,
  yakındaki tüm seviyeler, funding + sonraki funding zamanı, OI 1h değişimi, BTC 1h değişimi
- Hashtag'ler (dokununca o sınıftaki tüm kartlar listelenir): `#COIN #RSI2/#RSI3 #DIPTE/#YAKLASIYOR #HACIM #AYRISMA #TAKIP`
- Butonlar: 📈 TradingView · 🟡 Binance · ℹ️ Özet (açılır pencere: bu serideki kart sayısı, ilk karttan beri fiyat) · 🔕 1s sustur · ⭐ Takip
- **Sesli bildirim** yalnızca RSI 3/3 + DİPTE ya da takipteki coin; diğerleri sessiz gelir.

### Telegram komutları
| Komut | Kim | |
|---|---|---|
| `/ayarlar` | herkes görür, yöneticiler değiştirir | tüm parametreler ➖/➕ ve aç-kapa butonlarıyla |
| `/ayar anahtar değer` · `/ayar sifirla` | yönetici | ör. `/ayar rsiMin 95`, `/ayar levelMaxPct 2` |
| `/coin ETH` | herkes | coinin anlık durumu (şart aranmadan) |
| `/sustur ETH [dk]` · `/ac ETH` · `/sessiz` | yönetici / herkes | susturma |
| `/takip [ETH]` | liste herkes, ekle-çıkar yönetici | takipteki coinlerin kartları her zaman sesli |
| `/durum` · `/benkimim` · `/yardim` | herkes | |

Yönetici: `TELEGRAM_ADMIN_IDS` (virgüllü kullanıcı ID'leri; `/benkimim` ile öğrenilir) tanımlıysa o liste,
değilse **grubun yöneticileri**. Ayarlar `/data/info-settings.json`'a yazılır → deploy sonrası korunur.
Varsayılanlar `src/config.js` → `info` bölümünde.

### Bilgi botu backtest'i
Geçmişte bot çalışsaydı hangi kartlar gelirdi — **canlıyla aynı kod** (series + infoEngine + infoCard),
her 1m kapanışı sırayla oynatılır, look-ahead yok. Kazanç/kayıp hesabı yoktur; her kart için yalnızca
sonraki 15/60 dk'da fiyatın en düşük / en yüksek / kapanış değeri tutulur (kart sınıflarını kıyaslamak için).

```bash
# Fly makinesinde (root@...:/app#)
node src/infoBacktest.js --days 7 --max-coins 50          # hızlı deneme
node src/infoBacktest.js                                  # tüm evren, son 30 gün (uzun sürer)
node src/infoBacktest.js --symbol ETH,SOL --days 60 --ornek 5
node src/infoBacktest.js --ayar rsiMin=95,minTFs=3        # başka ayarla dene
node src/infoBacktest.js --canli-ayar --telegram          # Telegram'dan değiştirilmiş ayarlarla, sonucu gruba gönder
```
Çıktı: kart sayısı (günlük), seri sayısı, sesli/sessiz, Telegram yükü (en yoğun dakika/saat), sınıf
tablosu (RSI 2/3–3/3, DİPTE/yaklaşıyor, hacim tetikli, ayrışma, destek) ve `backtest-results/info-*.json`.
Süre: coin başına ~`gün × 0.7` sn veri çekme (30 gün ≈ 20–25 sn/coin).

### Bot türü
`src/config.js` → `botMode: 'info'` (varsayılan) ya da ortam değişkeni `BOT_MODE=signal` (eski sinyal botu).
`BOT_PAUSED=1` her iki modda da botu bağlantı açmadan bekletir.

---

# Eski sinyal botu (`BOT_MODE=signal`)

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
│   ├── index.js          # Giriş: BOT_MODE → infoBot (varsayılan) / legacyBot
│   ├── infoBot.js        # BİLGİ BOTU: evren, 1m WS, tohum, boşluk doldurma, funding/OI
│   ├── series.js         # 1m'den 3m/5m/15m/1h/4h/1d üretimi (canlı + backtest ortak)
│   ├── infoEngine.js     # Şart, hacim sayacı, yeni veri tespiti, numaralandırma (canlı + backtest ortak)
│   ├── infoCard.js       # Kart metni (Telegram HTML) + butonlar
│   ├── infoTelegram.js   # /ayarlar, /coin, /sustur, /takip … + buton işleyicileri
│   ├── infoSettings.js   # Ayarlar (varsayılan config.info, değişiklikler /data/info-settings.json)
│   ├── infoBacktest.js   # Bilgi botu backtest'i
│   ├── ta.js             # Hızlı RSI/EMA/ATR/MACD/Stoch RSI/VWAP
│   ├── legacyBot.js      # Eski SHORT sinyal botu
│   ├── config.js         # Tüm parametreler
│   ├── binanceClient.js  # REST (weight bütçeli kuyruk) + sembol listesi
│   ├── streamClient.js   # Combined stream WS (bağlantı başına ≤800 stream, watchdog)
│   ├── candleStore.js    # Mum tamponu (her sembol × TF)
│   ├── indicators.js     # RSI, EMA, ATR, CVD, negatif tepe
│   ├── regime.js         # Market regime tespiti (Reversal / Continuation)
│   ├── gates.js          # Mert 3A zorunlu koşullar
│   ├── scorer.js         # 0–100 skor motoru + derece sistemi
│   ├── levels.js         # Günlük EMA200/direnç + yakınlık (canlı + backtest ortak)
│   ├── tradePlan.js      # TP-A/TP-B/SL planı (canlı + backtest ortak)
│   ├── backtest.js       # Look-ahead'siz geçmiş test
│   ├── mert.js           # Mert varyantı kuralları (yalnızca backtest --compare)
│   ├── signalEngine.js   # Orkestrasyon — evaluate()
│   ├── htfPoller.js      # 4h/1D REST polling + OI delta
│   ├── outcome.js        # WIN/LOSS kuralları (canlı + backtest ortak)
│   ├── eventTracker.js   # Canlı sinyal takibi (TP-A → WIN, TP-B 4 saat izlenir)
│   ├── telegram.js       # Gönderim kuyruğu (20 msg/dk, 429 tekrar) + komutlar (fetch)
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
| `rsi5mMin` | `90` | 5m RSI giriş eşiği (15m ile **birlikte** sağlanmalı) |
| `rsi15mMin` | `85` | 15m RSI giriş eşiği |
| `rsiEntryMax` | `98` | Üst sınır: max(5m, 15m) RSI |
| `rsi1hMin` / `rsi4hMin` | `80` / `70` | Üst zaman dilimi aşırı alım eşikleri |
| `rsiEMCThreshold` | `95` | Extreme Momentum Condition eşiği (15m) |
| `ema21DistanceThreshold` | `0.5` | Min EMA21 uzaklığı (ATR cinsinden) |
| `initialRiskPct` | `0.5` | R-multiple hesabı için risk % |
| `minScoreToSend` | `40` | Bu skoru geçemeyen sinyal gönderilmez |
| `autoFilter.maxCoins` | `30` | Production'da en likit N coin — `0` = tüm market |
| `heartbeatMs` | 5 dk | Tek satırlık sağlık özeti aralığı |
| `logGateRejects` | `null` | Sembol başına red logu (null: test'te açık, production'da kapalı) |

## Tüm Futures Market'i Tarama

`src/config.js` içinde:

```js
mode: 'production',
autoFilter: { minVolume24hUSDT: 10_000_000, maxCoins: 0, ... },
```

- Semboller `exchangeInfo`'dan gelir: yalnızca **PERPETUAL + TRADING + USDT**; stablecoin'ler baz varlıkta tam eşleşmeyle elenir.
- WebSocket combined stream kullanır: 500+ sembol × 4 TF ≈ 2–3 bağlantı (Binance limiti bağlantı başına 1024 stream).
- Başlangıç seed'i weight bütçeli kuyruktan geçer (≈1200 weight/dk): 500 sembolde birkaç dakika sürer, bu sürede o semboller "veri hazır değil" sayılır.
- Sembol listesi başlangıçta belirlenir; yeni listelenen coinler için botu yeniden başlat.

## Loglar

Her 5 dakikada bir:

```
[HEARTBEAT] WS 3/3 bağlı (2200 stream) | son 5dk: 812000 mesaj, 550 kapanış(5m) → 550 değerlendirme (0 veri hazır değil), 1 sinyal
            | red: Günlük EMA200 veya majör direnç yakınında değil: 480, 1h RSI yetersiz: 55 | açık sinyal: 2
            | telegram: 1 gönderildi, 0 kuyrukta | bellek: 180 MB
```

- `[UYARI] ... hiç 5m mum kapanışı gelmedi` → veri akışı durmuş (WS bağlı görünse bile).
- `[WS#n] ... sn'dir veri yok — bağlantı yenileniyor` → watchdog devrede; veri dönünce kaçan mumlar REST ile doldurulur.
- `[TELEGRAM] 409 çakışma` → aynı token'la başka bir kopya çalışıyor (ör. lokalde `npm start`).

## Telegram Komutları

Komutlara **yalnızca `TELEGRAM_CHAT_ID` sohbetinden** yanıt verilir; başka sohbetlerden gelenler yok sayılır.

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
node src/backtest.js --days 30 --telegram               # bitince gruba tek özet rapor mesajı
node src/backtest.js --all --days 90 --telegram         # tüm USDT perpetual'lar (hacim filtreli)
node src/backtest.js --all --min-volume 20000000 --max-coins 200 --days 90
```

`--all`: sembolleri `exchangeInfo` + 24 saatlik hacimden seçer (PERPETUAL + TRADING + USDT,
stablecoin'ler hariç). `--min-volume` varsayılanı `config.autoFilter.minVolume24hUSDT`, `--max-coins` 0 = sınırsız.
Liste **bugünkü** hacme göre seçildiğinden dönem içinde listeden çıkmış coinler dahil değildir.

Uzun çalışmalar (tüm market × 90 gün ≈ sembol başına 15–20 sn) SSH koparsa yarıda kalır —
arka planda başlat, rapor bitince Telegram'a gelir:

```bash
fly ssh console
cd /app
nohup node src/backtest.js --all --days 90 --telegram > /tmp/backtest.log 2>&1 &
tail -f /tmp/backtest.log     # ilerlemeyi izle (Ctrl+C sadece izlemeyi bırakır)
```

Raporda "Son aşama" bölümü günlük seviye + 1h + 4h'yi geçen adayların kalan kapılarda
nasıl elendiğini gösterir: **takılan** (o kapıya takılan aday), **tek engel** (yalnızca o kapıya
takılan — o kapı olmasaydı geçerdi), RSI eşiğine 5m mi 15m mi takıldığı ve adayların RSI dağılımı.

RSI eşiklerini kodu değiştirmeden denemek için (yalnızca o çalışmada geçerli; eşikler rapora ve JSON'a yazılır):

```bash
node src/backtest.js --all --days 90 --rsi5m 90 --rsi15m 85 --rsi1h 80 --rsi4h 70 --telegram
```

### Uzun backtest için canlı botu duraklatmak

Canlı bot makinenin ana işlemi olduğu için `kill` edilemez (makine kapanır). Bunun yerine:

```bash
fly secrets set BOT_PAUSED=1     # makine yeniden başlar, bot hiçbir bağlantı açmadan boşta bekler
fly ssh console                  # backtest'i çalıştır
fly secrets unset BOT_PAUSED     # iş bitince: bot normal çalışmaya döner (çalışan backtest'i durdurur!)
```

### RSI olay çalışması (her çalışmada otomatik)

Canlı kuralın **RSI şartı** (5m ≥ 90 · 15m ≥ 85 · 1h ≥ 80 · 4h ≥ 70 · üst sınır 98 — `--rsi*` bayraklarıyla
değiştirilebilir) sağlanan **her an**, diğer kapılardan (günlük seviye, rejim, EMA21) ve cooldown'dan bağımsız
kaydedilir. Aynı coinde 30 dk içinde tekrar eden anlar tek **olay** sayılır.

Her an için: coin, zaman, 4 RSI, **takıldığı diğer kapılar** (boşsa sinyal olurdu), o an short açılsaydı
15 dk / 1 saat / 4 saat sonraki getiri, 4 saatlik en iyi/en kötü hareket (MFE/MAE) ve canlı planla (TP-A/SL)
varsayımsal sonuç. Raporda her kapı için "takılan" ve "geçen" olayların ortalama sonucu yan yana gösterilir:
kapı işe yarıyor mu, yoksa iyi fırsatları mı eliyor. Kayıtlar JSON'da `rsiEvents` altında.

Canlı bot da aynı şartı sağlayan her coin için log yazar (diğer kapılara takılsa bile):

```
[RSI] ETHUSDT 5m 92.1 · 15m 88.4 · 1h 83.0 · 4h 74.2 → takıldı: EMA21 uzaklığı < 0.5 ATR
```

```bash
fly logs | grep '\[RSI\]'
```

### Mert varyantları (`--compare`)

Canlı kural (A) ile Mert'in kendi anlattığı kuralları **aynı semboller, aynı dönem, aynı veri** üzerinde test eder.
Canlı bot **değişmez** — Mert kuralları yalnızca backtest'tedir (`src/mert.js`, ayarlar `config.mert`).

| | Mert kuralı |
|---|---|
| Yer | Fiyat bir direncin dibinde: 4h MA200, 4h EMA200, 1d MA200, 1d EMA200 ya da günlük majör direnç. Seviyenin altında ≤ %0.5, üstünde ≤ %0.3 (fitil payı); seviyeyi aşıp yukarıdaysa sinyal yok |
| Karar | 3m / 5m / 15m RSI'lardan en az N tanesi ≥ eşik; **üst sınır yok** |
| Güven puanı | 1h RSI ≥ 70 → +1, 4h RSI ≥ 70 → +1 (0–2). **Zorunlu değil**; raporda sonuçlar puana göre ayrılır |
| Ayrışma | Fiyat 3m **ve** 5m EMA21'den ≥ 0.5 ATR uzakta, son 3 mumda dokunuş yok |
| TP | TP-A = 3m EMA21, TP-B = 5m EMA21 (izlenir) |
| Stop | Giriş × (1 + %SL) |
| Yönetim | Aynı coinde açık işlem varken yeni işlem yok (bir hareket = bir işlem) |

**Mert olay çalışması (`--compare`):** 3m/5m/15m'den en az 2'si RSI ≥ 90 olan **her an** filtre uygulanmadan
kaydedilir (yer, güven, ayrışma elenmez). Her an için: 5 seviyenin her birine uzaklık, en yakın üst seviye,
güven puanı, 3m/5m EMA21 ayrışması, son 1 saatteki yükseliş, 15 dk/1 saat/4 saat sonraki getiri ve Mert planıyla
(TP-A 3m EMA21) üç stopla varsayımsal sonuç: %1 · %1.5 · en yakın üst seviyenin %0.3 üstü. Rapor (ve ikinci
Telegram mesajı) sonuçları seviyeye uzaklığa, seviye türüne, güven puanına, TF sayısına, ayrışmaya ve son 1 saatteki
yükselişe göre ayırır — kuralın eşikleri bu tablolardan seçilir. JSON'da `mertEvents`.

8 kombinasyon denenir: RSI eşiği 90 / 95 × en az 2 / 3 zaman dilimi × stop %1.0 / %1.5.

**Walk-forward:** Dönemin ilk 2/3'ü **seçim**, son 1/3'ü **doğrulama**dır. En iyi kombinasyon yalnızca seçim
döneminde (en az 10 sinyal şartıyla, en yüksek toplam net R) seçilir; doğrulama sütunu onun görmediği veridir —
asıl kanıt odur.

```bash
nohup node src/backtest.js --compare --all --days 90 --telegram > /tmp/backtest.log 2>&1 &
```

- 1m veri çekilir; 3m/5m/15m/1h/4h'nin devam eden mumları 1m'den **kesin** kurulur (look-ahead yok).
- Sonuçlar hepsinde **1m mumlarla** ölçülür. A'nın kararları normal modla birebir aynıdır; sonuç etiketleri
  (5m yerine 1m çözünürlük yüzünden) az da olsa farklı çıkabilir.
- Sembol başına ~1 dk (90 günde); tüm market ~1 saat.

`--fee-pct 0.05` (varsayılan): raporlardaki **net R**, giriş+çıkış komisyonu (2 × %0.05) düşülerek
hesaplanır. %0.5 SL ile bu işlem başına ≈ 0.2R eder. Brüt R ve WIN/LOSS etiketleri değişmez.

`--telegram`: backtest bitince `TELEGRAM_CHAT_ID` sohbetine **tek** bir özet mesaj gönderir
("canlı sinyal değildir" etiketli). Canlı botun gönderim kodunu kullanır, komut dinlemeyi
başlatmaz (çalışan botla çakışmaz). Grubu görmesin istersen başka bir sohbete yönlendir:
`TELEGRAM_CHAT_ID=<kendi_id> node src/backtest.js --telegram`.

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

- **RSI eşikleri** (5m ≥ 90, 15m ≥ 85, 1h ≥ 80) backtest sonuçlarıyla doğrulanacak, gerekirse revize edilecek
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
