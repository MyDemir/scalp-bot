# Scalp Bilgi Botu

> Binance USDT-M Futures — **bilgi / sınıflandırma botu**. Koşulları sağlayan coinler için Telegram'a
> bilgi kartı gönderir; **işleme girme kararı kullanıcıdadır** (otomatik işlem yok).
> Eski SHORT sinyal botu ve eski backtest (Mert varyantları) kaldırıldı; git geçmişinde `4fa2e01` ve öncesinde duruyor.

---

## Bilgi Botu

### Ne izler
Tüm USDT perpetual pariteler, **24s hacim ≥ 3 milyon $** (stabil coinler hariç). Liste saatte bir
yenilenir: yeni coinler eklenir, hacmi eşiğin %80'inin altına düşenler çıkar.

Veri: coin başına **tek WebSocket akışı** (1m kline, yalnızca kapanışlar işlenir). 3m/5m/15m/1h/4h/1d
mumları botun kendisi 1m'lerden üretir (`src/series.js`) → tüm market tek bağlantıya sığar.
Başlangıçta her zaman dilimi REST'ten yüklenir (birkaç dakika; hazır olan coin hemen değerlendirilir).

### Kart ne zaman gelir
Kontrol anı: **3m / 5m / 15m mum kapanışları** + **hacimli her 1m mum kapanışı**. Kart için:

| Şart | Varsayılan |
|---|---|
| 3m/5m/15m RSI | en az **2/3** dilimde **≥ 85** (kapanmamış dilimde devam eden mumla hesaplanır; RSI periyodu 14) |
| Seviye (zorunlu) | fiyatın üstünde en fazla **%2.5** uzakta bir seviye: 4h MA200 · 4h EMA200 · 1d MA200 · 1d EMA200 · 30 günlük tepe (son 30 **kapanmış** günün en yüksek 3 tepesinin ortalaması) |
| Yeni veri | önceki karttan bu yana: RSI dilim sayısı değişti · bir dilim 95'i geçti · hacimli mum · seviye/bölge değişti (DİPTE'ye girdi, seviye kırıldı) · MACD ya da Stoch RSI kesişimi · 1m/3m negatif tepe arttı. **Yeni veri yoksa kart gitmez.** |

**Derece daireleri** (kart başlığında):

| | RSI kartı | Hacimli mum / ⚡ hareket |
|---|---|---|
| 🔴 | 2/3 dilimde RSI ≥ 85 | temel şart (hacimli mum · 1 dk ≥ %2) |
| 🔴🔴 | 2/3 dilimde RSI ≥ 90 **ve** üstte %2.5 içinde seviye | + hacim ≥ 3× (önceki 20 dk ortalaması) |
| 🔴🔴🔴 | 3/3 dilimde RSI ≥ 90 + fiyat dirence dayalı (dipte) + EMA21 ayrışması — **sesli** | + alış/satış oranı hareket yönünde ≥ %65 |

Hacim/⚡ dairelerinin **rengi yönü** gösterir: 🟢 alış/yükseliş · 🔴 satış/düşüş · ⚪ nötr (daire sayısı derecedir).
RSI kartı daireleri kırmızıdır (aşırı alım). RSI satırlarında: 🔴 ≥ 85 · 🔴🔴 ≥ 90 · 🔴🔴🔴 ≥ 95. Derece değişimi yeni veri sayılır
("Derece yükseldi: 🔴🔴🔴"). Eşikler `/ayarlar`'dan değişir (`rsiMin`, `rsiMin2`, `volGrade2X`, `dirGrade3Pct`, `rsiPeriod`).

**Seri içi patlama:** bir coinde kart gittikten sonra seri sürerken (kapanmış 5m RSI 75'in altına inmeden)
gelen hacimli 1m mum **şart aranmadan** kart olur (`#SERI`, kartta "Seri içi · şart dışı (RSI 1/3)" gibi).
Böylece tepedeki sert satış mumu RSI'ı 90'ın altına indirse de bildirilir. `/ayarlar` → "Seri patlama" ile kapatılabilir.

Seviye kırılırsa (fiyat seviyenin %0.3'ten fazla üstünde) o seviye sayılmaz, bir üstteki aranır.
Aynı coinde kartlar **#1, #2 …** diye numaralanır; kapanmış 5m RSI 75'in altına inince numara sıfırlanır.

### Kartın içeriği
- Başlık: derece daireleri, coin (tıklanabilir `#COINUSDT` etiketi — dokununca o coinin tüm kartları), kart no · 🔔 bu kartı doğuran yeni veri
- RSI 3m/5m/15m · seviye + mesafe (**⭐ DİPTE**: seviyenin %0.5 altı–%0.3 üstü, ya da **↗ yaklaşıyor**)
- **EMA21** 3m/5m: fiyatı, fiyata uzaklığı (%) ve ATR cinsinden ayrışma (geri çekilme hedefleri) · destek RSI (1h/4h ≥ 70)
- **〽️ Negatif tepe** (1m/3m): fiyat eşit ya da daha yüksek tepe yaparken RSI daha düşük tepe — ardışık sayı
  ("2–3 tepe negatif yapıp çakarsa"). Son tepe 6 mumdan eskiyse gösterilmez. ≥2 ise `#NEGTEPE`.
- **Hacim sayacı** (60 dk ve 15 dk): 1m gövde ≥ %1 / ≥ %1.5 ve hacim ≥ 2× (önceki 20 mum ortalaması);
  taker alış > %55 → ▲ alım, < %45 → ▼ satış, arası ◆ nötr. Art arda gelen patlama mumları tek patlama sayılır.
- Taker net akış (USDT) · **Detaylar** (dokununca açılır): MACD 5m/15m, Stoch RSI 5m, günlük VWAP ±σ,
  yakındaki tüm seviyeler, funding + sonraki funding zamanı, OI 1h değişimi, BTC 1h değişimi
- Hashtag'ler (dokununca o sınıftaki tüm kartlar listelenir): `#COIN #DERECE1/2/3 #DIPTE/#YAKLASIYOR #HACIM #SERI #NEGTEPE #AYRISMA #TAKIP`
- Butonlar: 📈 TradingView · 🟡 Binance · ℹ️ Özet (açılır pencere: bu serideki kart sayısı, ilk karttan beri fiyat) · 🔕 1s sustur · ⭐ Takip
- **Sesli bildirim** yalnızca 🔴🔴🔴 kartlar ve takipteki coinler; diğerleri sessiz gelir.

### Grafik
Kartlar ve ⚡ uyarılar **grafikli** gelir (fotoğraf + açıklama): son ~8 saatin 5m mumları, hacim, direnç seviyesi
(kesikli turuncu), son fiyat etiketi ve **Ichimoku** — KivancOzbilgic'in "ICHIMOKU Kinko Hyo by KIVANC" düzeni:
Tenkan (kırmızı), Kijun (mavi), Chikou (erik), Senkou A (yeşil), Senkou B (mor), bulut. Varsayılan periyotlar
Kıvanç'ın kripto önerisi 10/30/30/60/30 (1-3-3-6-3 oranı); klasik 9/26/26/52/26 için `/ayar ichiTenkan 9` vb.
Evren dışı pariteler için grafik verisi o an REST'ten çekilir. Açıklama Telegram'ın 1024 karakter sınırını
aşarsa açılır "Detaylar" bloğu çıkarılır. Kapatmak: `/ayarlar` → Grafik / Grafik ⚡. Çizim `@napi-rs/canvas`
ile yapılır, yazı tipi repo içinde (`src/assets/fonts`, DejaVu); kütüphane yüklenemezse kartlar grafiksiz gider.

### ⚡ 1 dakikalık hareket uyarısı
**Tüm** USDT perpetual paritelerde (hacim filtresi yok, stabil coinler hariç) 1m mum kapanışı, bir önceki
1m kapanışa göre **≥ %2** değişirse ayrı bir ⚡ uyarı gelir: yön, eski → yeni fiyat, hacim katı (önceki 20 dk
ortalaması), taker oranı, 24s hacim; coin izlenen evrendeyse RSI ve seviye de. `#HAREKET #YUKSELIS/#DUSUS`.
Evren dışı pariteler de WebSocket'e eklenir ama yalnızca son kapanış + hacim tutulur (hafif).
Ayarlar: `moveAlertPct` (0 = kapalı), `moveAlertAll` (tüm pariteler / yalnızca evren), `moveAlertSound`.

### Kart geçmişi
Her kart ve ⚡ uyarı `/data/cards.db`'ye (SQLite) yazılır; sonrasında fiyat 15 / 60 / 240 dk izlenir
(en düşük / en yüksek / kapanış değişimi, kart anındaki fiyata göre — kazanç/kayıp değil). 90 gün saklanır.
Yeniden başlatmada yarım kalan takipler "eksik" işaretlenir.
- `/gecmis ETH [adet]` — coinin son kartları + sonrasında fiyat
- `/istatistik [gün]` — kart sınıfları (RSI 2/3–3/3, DİPTE, hacim, seri içi, negatif tepe …) ve ⚡ uyarılar için
  "sonraki 60 dk" medyanları — backtest'teki tablonun canlı hali

### Telegram komutları
| Komut | Kim | |
|---|---|---|
| `/ayarlar` | herkes görür, yöneticiler değiştirir | tüm parametreler ➖/➕ ve aç-kapa butonlarıyla |
| `/ayar anahtar değer` · `/ayar sifirla` | yönetici | ör. `/ayar rsiMin 95`, `/ayar levelMaxPct 2` |
| `/coin ETH` | herkes | coinin anlık durumu (şart aranmadan) |
| `/sustur ETH [dk]` · `/ac ETH` · `/sessiz` | yönetici / herkes | susturma |
| `/takip [ETH]` | liste herkes, ekle-çıkar yönetici | takipteki coinlerin kartları her zaman sesli |
| `/gecmis ETH [adet]` · `/istatistik [gün]` | herkes | kart geçmişi ve sınıf istatistiği |
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
node src/infoBacktest.js --days 7 --max-coins 50          # hızlı deneme (npm run backtest -- ... da olur)
node src/infoBacktest.js                                  # tüm evren, son 30 gün (uzun sürer)
node src/infoBacktest.js --symbol ETH,SOL --days 60 --ornek 5
node src/infoBacktest.js --ayar rsiMin=95,minTFs=3        # başka ayarla dene
node src/infoBacktest.js --canli-ayar --telegram          # Telegram'dan değiştirilmiş ayarlarla, sonucu gruba gönder
node src/infoBacktest.js --kanit --days 1 --max-coins 50  # kanıt modu (RSI 70) — yalnızca backtest
```
Çıktı: kart sayısı (günlük), seri sayısı, sesli/sessiz, Telegram yükü (en yoğun dakika/saat), sınıf
tablosu (RSI 2/3–3/3, DİPTE/yaklaşıyor, hacim tetikli, seri içi, ayrışma, destek, negatif tepe), listedeki
coinlerde 1 dk ≥ %2 hareket sayısı ve `backtest-results/info-*.json`. Varsayılan ayarlar canlıyla aynıdır.
**Kanıt modu:** `--kanit` yalnızca o backtest çalışmasında RSI eşiğini 70'e, sıfırlamayı 60'a indirir (çok kart →
motorun çalıştığı görülür); canlı bota ve ayar dosyasına dokunmaz. `--canli-ayar` ayar dosyasını yalnızca okur.
Süre: coin başına ~`gün × 0.7` sn veri çekme (30 gün ≈ 20–25 sn/coin).

### Duraklatma
`fly secrets set BOT_PAUSED=1` → makine açık kalır, bot hiçbir bağlantı açmaz (uzun backtest'ler için).
Devam: `fly secrets unset BOT_PAUSED`.

## Dosya Yapısı

```
src/
├── index.js          # Giriş (BOT_PAUSED kontrolü, kapanış)
├── infoBot.js        # Canlı çalışma: evren, 1m WS, tohum, boşluk doldurma, funding/OI, heartbeat
├── series.js         # 1m'den 3m/5m/15m/1h/4h/1d üretimi (canlı + backtest ortak)
├── infoEngine.js     # Şart, hacim sayacı, yeni veri tespiti, seri, numaralandırma (canlı + backtest ortak)
├── infoCard.js       # Kart metni (Telegram HTML) + butonlar + özet
├── infoTelegram.js   # /ayarlar, /coin, /sustur, /takip … + buton işleyicileri
├── infoSettings.js   # Ayarlar (varsayılan config.info, değişiklikler /data/info-settings.json)
├── infoStats.js      # Kart sınıfları + "sonrası" medyanları (backtest ve /istatistik ortak)
├── cardStore.js      # Kart geçmişi (SQLite /data/cards.db) + 15/60/240 dk takip
├── infoBacktest.js   # Bilgi botu backtest'i
├── levels.js         # 4h/1d MA200 · EMA200 · 30 günlük tepe
├── ta.js             # RSI/EMA/ATR/MACD/Stoch RSI/VWAP
├── chart.js          # Grafik PNG: 5m mumlar + Ichimoku (Kıvanç düzeni) + hacim + seviye
├── assets/fonts/     # Grafik yazı tipi (DejaVu, lisansı yanında)
├── binanceClient.js  # REST (weight bütçeli kuyruk) + sembol/hacim listesi + funding/OI
├── streamClient.js   # Combined stream WS (≤800 stream/bağlantı, watchdog, dinamik abonelik)
├── telegram.js       # Gönderim kuyruğu (20 msj/dk, 429 tekrar) + komut/buton dinleme
└── config.js         # Varsayılan parametreler
```

## Kurulum (yerel)

```bash
npm install
cp .env.example .env   # düzenle
npm start
```

## Fly.io'ya Deploy

Bot bir arka plan worker'ı (WebSocket + REST + Telegram) — HTTP
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

# 5. Kalıcı disk oluştur — ayarlar (info-settings.json) burada yaşar
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
