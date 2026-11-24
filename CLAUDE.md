# Scalp Bilgi Botu

Tek paket Node.js (CommonJS, Node ≥ 20) projesi: Binance USDT-M Futures
bilgi / sınıflandırma botu. Koşulu sağlayan coinler için Telegram'a kart
gönderir (🔻 tepe kurulumu bildirimi 24.11.2026'da kaldırıldı; tepe defteri kaydı sürer); otomatik işlem yoktur. Aynı
süreçte salt okunur web paneli (`src/server.js`, port 3000) çalışır.
Kod `src/`, testler `test/`; kullanıcı kılavuzu `README.md`.

## Her görevin başında (zorunlu)
Bu dosya her görevde, her ajan için bağlayıcıdır. İşe başlamadan:
1. Görevin hangi alana girdiğini belirle (aşağıdaki "Üç alan": web
   paneli, Telegram botu, istatistik kaydı; birden fazlası olabilir).
   Hiçbirine girmiyorsa "Sinyal motoru (ortak çekirdek)" bölümüne bak.
2. O alanın bölümünü, dosyalarını ve testlerini oku; alanın
   kurallarını brife ve RAPOR'a taşı.
3. "Kullanıcının kalıcı kuralları" ve "Ajan ortak kuralları"nı uygula;
   onay kapısına giren adım varsa başlamadan sor.
4. İş bitince alanın testlerini, ardından `npm test`'i çalıştır;
   davranış değiştiyse `README.md`'nin ilgili bölümünü güncelle.
Alan sınırını aşan değişiklikte (ör. yeni istatistik alanı + panelde
gösterim + Telegram komutu) her alan ayrı iş sayılır, ortak ARAYÜZ
(kolon adı, API alanı, komut argümanı) brifte yazılır.

## Üç alan

### 1. Web paneli
- Dosyalar: `src/server.js` (Express, port 3000; API uçları ve panelin
  HTML/JS'i aynı dosyada, `app.get('/')` altında), `src/adminAuth.js`
  (Telegram OTP ile oturum), `src/webUrl.js` (panel adresi:
  `WEB_PANEL_URL` / `APP_URL` / Fly).
- Uçlar: `/api/auth/*` (kod iste / doğrula / çıkış / oturum),
  `/api/external-bots/heartbeat` (harici bot nabzı, `X-Bot-Key` =
  `EXTERNAL_BOT_KEY`), oturum arkasında yalnız GET: `/api/status`,
  `/api/settings`, `/api/universe`, `/api/cards`, `/api/touches`,
  `/api/flow`, `/api/flow/table`, `/api/logs*`, `/api/reports/:name`,
  `/api/external-bots`.
- Kurallar: panel **salt okunurdur**; ayar değişikliği yalnız
  Telegram'dan. `adminAuth.middleware` arkasına girmeyen yeni `/api/`
  ucu, CSRF (`sameOrigin`) ya da güvenlik başlığı gevşetmesi, oturum /
  OTP sürelerinin uzatılması onay kapısıdır. Dışarıdan gelen metin
  `cleanText` ve HTML kaçışından geçer. Panel aynı süreçte botla
  çalışır: ağır sorgu bot döngüsünü bekletir, parça parça oku.
- Testler: `node test/run.js admin-auth dashboard-security api-security
  web-url`. Görsel değişiklikte 390px ve 1280px ekran görüntüsü.

### 2. Telegram botu
- Dosyalar: `src/telegram.js` (gönderim kuyruğu: grupta 20 msj/dk,
  429'da `retry_after` kadar bekleyip tekrar, `TELEGRAM_MAX_QUEUE_LEN`,
  kullanıcı yanıtları `kind: 'reply'` ile öncelikli; komutlara yalnız
  `TELEGRAM_CHAT_ID` sohbetinden yanıt), `src/infoTelegram.js`
  (komutlar, `/ayarlar` menüsü, butonlar, konu yönlendirme),
  `src/infoCard.js` (kart metni, Telegram HTML),
  `src/chart.js` (kart grafiği PNG),
  `src/infoSettings.js` (ayarlar → `/data/info-settings.json`).
- Kurallar: kart ve bildirim biçimi, derece daireleri, sesli/sessiz
  ayrımı ve `/konu` yönlendirmesi kullanıcının onaylı tasarımıdır;
  değişiklik onay kapısıdır. Yetki: ayar değiştirme yöneticide
  (`TELEGRAM_ADMIN_IDS` ya da grup yöneticileri); üyeye açık olanlar
  README'deki komut tablosunda yazılı, yetkiyi genişletmek onay ister.
  Metin `esc()` ile kaçışlanır, 4000 karakteri aşmaz. Yeni komut
  README "Telegram komutları" tablosuna ve `/yardim`'a eklenir. Yeni
  ayar `config.js` `info` + `/ayarlar` menüsü + README'ye birlikte
  girer. Mesaj sayısını artıran değişiklik (günde kaç mesaj)
  RAPOR'da yazılır.
- Testler: `node test/run.js telegram-queue info-e2e counter chart
  gap-dedup`.

### 3. İstatistik kaydı
- Dosyalar ve tablolar (hepsi `/data` altında, SQLite WAL):
  - `src/cardStore.js` → `cards.db`: `cards` (kart + 5/15/30/60/240 dk
    sonrası; `kind = tepe` tepe bildirimleri), `touches` (seviye
    tepkisi, `src/levelTouch.js`), `events` (tepe defteri,
    `src/eventLog.js`), `paths` (tepe sonrası 15 dk 1m yolu, `onPath`; en fazla 60 gün;
    haftalık rapordan sonra diğer kayıtlarla silinir, gönderim başarısızsa silinmez).
    Saklama: kart 90 gün, temas ve tepe 60 gün, yol 60 gün.
  - `src/spotFlow.js` + `src/bigTrades.js` → `flow.db`: `flow`,
    `flow_label`, `flow_changes`, `flow_big` (1s 30 gün, 4s 180 gün,
    büyük işlem 400 gün).
  - `src/logStore.js` → `logs/events-YYYY-MM-DD.jsonl`
    (`LOG_RETENTION_DAYS`, varsayılan 14).
  - Tepe anı fotoğrafı: `src/marketSnap.js`, `src/peakFeatures.js`,
    `src/marketData.js`; özet ve medyanlar `src/infoStats.js`.
  - Dışa aktarma: `src/exportData.js` (`/disaaktar`), haftalık
    `src/weeklyReport.js` + `src/zipWriter.js` (Pazartesi 03:01 TSİ:
    MD'yi de içeren tek zip gruba gider, ancak hepsi gittikten sonra kapsamdaki
    kayıtlar silinir; gönderim başarısızsa silme yok).
- Kurallar: kayıt hatası botu ya da kart gönderimini durdurmaz
  (logla, devam et). Kazanç/kayıp hesaplanmaz; "sonrası" yalnız fiyat
  değişimidir. Eksik veri uydurulmaz: yarım takip "eksik" işaretlenir.
  Şema yalnız `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN` ile ilerler.
  Yeni kolon CSV başlığına (`dropCols`, `csvHeader`) ve gerekiyorsa
  README'ye girer; mevcut kolonun adı ya da anlamı değişmez (eski
  haftalık dosyalarla kıyas bozulur). Büyük okuma parça parça yapılır
  (512 MB; haftalık rapor bunun için parçalı okur). Saklama süresi,
  silme mantığı ve şema değişikliği onay kapısıdır.
- Testler: `node test/run.js drops touch weekly spot-flow log-store
  info-unit`.

### Sinyal motoru (ortak çekirdek)
Üç alanı besleyen kod: `src/infoBot.js` (evren, WS, tohum, boşluk
doldurma, funding/OI, heartbeat, haftalık rapor tetiği), `src/series.js`,
`src/infoEngine.js`, `src/levels.js`, `src/ta.js`, `src/streamClient.js`,
`src/binanceClient.js` (REST weight bütçesi), `src/infoBacktest.js`.
Canlı ve backtest aynı kodu kullanır. Testler: `node test/run.js
info-unit breakout move neg daily-levels fib backfill symbol-recovery
info-bt`.

## Komutlar
- Kurulum: `npm ci` (better-sqlite3 ve @napi-rs/canvas yerel modül; ilk
  kurulum birkaç dakika sürebilir)
- Testler: `npm test` (tümü, `test/run.js`), tek tek:
  `node test/run.js drops weekly` (ada göre süzer). Ağ gerekmez; Binance
  ve Telegram `test/mockinfo.js` ile taklit edilir. Loglar
  `test/.tmp/logs/<ad>.log`. CI ortamı: `NODE_ENV=test TELEGRAM_OPTIONAL=1`.
- Lint: yok (package.json'da lint betiği tanımlı değil).
- Backtest: `npm run backtest -- --days 7 --max-coins 50` (Binance'e
  bağlanır, yani canlı veri ister; ayrıntı README "Bilgi botu backtest'i").
- Docker doğrulama: CI'da `docker build` (Dockerfile yalnız `src/`'yi
  kopyalar).

## Çalışma ortamı (canlı)
- Fly.io, `fra`, tek makine `shared-cpu-2x`, **512 MB** bellek
  (`fly.toml`). Kalıcı disk `/data`: `signals.db`, `cards.db`,
  `flow.db`, `info-settings.json`, `logs/`. Deploy sonrası korunur.
- `main`'e her push `.github/workflows/fly-deploy.yml` ile **otomatik
  canlıya çıkar** (`--app scalp-bot-vip`; `fly.toml`'daki `app` satırı
  `scalp-bot`, workflow `--app` ile ezer).
- Bellek dar: tüm USDT perpetual evreni tek süreçte tutulur. Coin başına
  dizi, önbellek ya da kuyruk ekleyen değişiklikte bellek etkisi
  raporlanır. Node heap sınırı `fly.toml`'da
  `NODE_OPTIONS = '--max-old-space-size=320'`; değiştirmek onay kapısıdır.
- Saatler kullanıcıya TSİ (Europe/Istanbul, `DISPLAY_TZ`) yazılır.
  Haftalık rapor her Pazartesi 03:01 TSİ gruba gider, ardından ilgili
  kayıtlar veritabanından **silinir** (`src/weeklyReport.js`).
- Ayarlar: varsayılanlar `src/config.js` → `info`; Telegram'dan
  değişenler `/data/info-settings.json`'da kalır. Yeni ayar anahtarı
  eklenirse eski dosyayla açılışta varsayılanı almalıdır.
- SQLite şeması `CREATE TABLE IF NOT EXISTS` + eksik kolon için
  `ALTER TABLE ... ADD COLUMN` ile ilerler (`src/cardStore.js`); canlı
  veritabanında kolon silme ya da yeniden adlandırma yok.

## Kullanıcının kalıcı kuralları
- Bağımsız işler brifte yazılı ARAYÜZ ile paralel yürüyebilir; onay
  soruları kullanıcıya teker teker gelir.
- Kanıtsız ve artı/eksisi gösterilmemiş öneri yok. Sinyal kuralı
  önerisi veriyle gelir: dönem, örnek sayısı, "60 dk sonra aşağıda" oranı
  ve dönemlere bölünmüş sonuç (örnek: /teyit çıktısı: dönem, n, oran).
  Tek dönemde tutup diğerinde tutmayan kural öneri olamaz.
- Bot bilgi verir, karar vermez: kart ve bildirim metni al/sat emri gibi
  yazılmaz; otomatik işlem eklenmez.
- Canlı ve backtest aynı kodu kullanır (`series.js`, `infoEngine.js`,
  `infoCard.js`, `eventLog.js`, `levelTouch.js`). Bir tarafa özel dal
  açılmaz; look-ahead yok.
- Kart derece / tepe kuralları ve varsayılan eşikleri (`src/config.js`
  `info`, `src/infoEngine.js` derece hesabı)
  kullanıcı onayı gerektirir. Kart biçimi değişikliği de onaylıdır.
- Davranış ya da komut değişikliği aynı dalda `README.md`'ye yansır
  (tablo, örnek kart, komut listesi).
- Analizler Claude projesinin `analiz/` klasöründe durur
  (`short-kurulum.md`, `long-kurulum.md`, `gelistirme-alanlari.md`);
  kural işinde önce bunlar okunur.

## Orkestra kuralı (şef)
- Sen şefsin: işi böl, brif yaz, ajan ve model seç, denetçiye kontrol
  ettir, birleştir, sade dille raporla.
- Brif, rapor ve kullanıcıya mesaj yazmak serbest; kod, tasarım ve
  teslim edilecek metin ajanlara verilir. Kendi işini kendin onaylama.
- Model: mekanik iş haiku; araştırma, tarif edilmiş kod ve denetim
  sonnet; tasarım ve riskli denetim (sinyal/derece kuralı, varsayılan
  eşik, veritabanı şeması, deploy ayarı değişikliği) opus. Genel amaçlı
  ajana modeli açıkça ver.
- Worktree'yi yalnızca harness açar (`isolation: worktree`). Ayrıca
  worktree açma, brife yol yazma. Ajanın raporladığı yol ve dal
  geçerlidir; denetçi brifine bunları yaz.
- Dosya değiştiren her ajan kendi worktree'sinde ve dalında çalışır,
  sık commit atar.
- `main`'e merge canlıya deploy demektir. Yalnızca sen, testler
  geçtikten ve kullanıcı onayından sonra, `merge --no-ff` ya da PR
  birleştirmesiyle yaparsın.
- Ajan DURDU dönerse ya da onay kapısı açılırsa kullanıcıya sor;
  kendin onaylama.
- DÜZELT en fazla 3 tur; sonra kullanıcıya sor.
- Küçük iş: denetçi yok, diff'e sen bak. Orta: 1 ajan + denetçi.
  Büyük: paralel ajanlar; ortak ARAYÜZ brifte yazılı olur.
- Workflow yalnızca kullanıcı "workflow kullan" derse.
- Dosyaya yazılacak araştırma raporu: arastirmaci mesaj olarak döner,
  dosyaya yukleyici ya da sen yazarsın.

## Brif şablonu
ALAN · GÖREV · SENİN DOSYALARIN · DOKUNMA · ARAYÜZ · ONAY KAPILARI · ÖNCE OKU ·
BİTTİ TANIMI · RAPOR
- ARAYÜZ: başka bir işle paylaşılan sözleşme; dosya yolu, fonksiyon
  imzası, ayar anahtarı, Telegram komutu ve argümanları, kart / CSV
  kolonları, SQLite kolonu, CLI argümanları, çıkış kodları. Yoksa "yok".
- ONAY KAPILARI: bu iş için kullanıcının önceden verdiği onaylar,
  açıkça ("src/config.js funding eşiği: onaylı"). Yazmayan kapı
  kapalıdır.
- BİTTİ TANIMI: çalıştırılacak komutlar ve beklenen sonuç
  (ör. `node test/run.js weekly` -> 1/1 geçti; `npm test` -> 28/28).

## Ajan ortak kuralları (her ajan uyar)
0. ALAN: İlk iş bu dosyanın "Her görevin başında" adımlarını uygular;
   RAPOR'un ilk satırına `ALAN: web paneli | Telegram botu | istatistik
   kaydı | sinyal motoru` yazar.
1. ÇALIŞMA YERİ: `isolation: worktree` olan ajan harness'in açtığı
   dizinde çalışır; ilk iş `pwd` ve dalı raporlar. Ana checkout'a ya da
   brifte yazan başka bir yola yazmaz.
2. KAPSAM: Yalnızca SENİN DOSYALARIN. Brif dışı dosya gerekiyorsa DUR.
3. KANIT: Her iddia etiket taşır: `[kanıt: dosya:satır]`,
   `[kanıt: komut -> çıktı özeti]`, `[kaynak: URL]` ya da
   `[doğrulanamadı: neden]`. Varsayımla boşluk doldurulmaz. Oran ve
   sayılar veri kaynağıyla (dönem, örnek sayısı) yazılır.
4. ONAY KAPILARI: Aşağıdakiler ajanın kararı olamaz. Brifte onay
   yazmıyorsa DUR, kısmi iş ya da dolanma yok, RAPOR'da DURUM: DURDU:
   kart derece / tepe kuralı ya da `src/config.js` `info` varsayılanı
   değişikliği; kart ya da bildirim biçimi değişikliği; SQLite şema
   değişikliği ya da veri silme mantığı (`weeklyReport.js`, saklama
   süreleri); `fly.toml`, `Dockerfile`, `.github/workflows/` değişikliği;
   yeni bağımlılık; onaylı tasarımdan ya da ARAYÜZ'den sapma; canlı
   sistemlere erişim (Fly makinesi, `/data`, gerçek Telegram botu ya da
   grubu, anahtarlı Binance API, canlıya karşı backtest); brif dışı
   dosya; dosya silme; güvenlik kısıtını gevşetme (test, panel
   kimlik doğrulaması, yönetici yetkisi, `TELEGRAM_MAX_QUEUE_LEN`, REST
   weight bütçesi).
5. ARAYÜZ: Sapma yok. Zorunluysa DUR; karşı tarafı uyarlama.
6. COMMIT: Yalnızca `git add <dosya>`. `git add -A`, `git add .`,
   `git commit -a` yasak. Commit öncesi `git status --short` ve
   `git diff --cached --summary`: node_modules, symlink (mode 120000),
   `test/.tmp/`, `backtest-results/`, `*.db` ya da kapsam dışı dosya
   varsa commit yok. node_modules symlink ile bağlanmaz.
7. GÜVENLİK: .env, `BINANCE_API_*`, `TELEGRAM_BOT_TOKEN`,
   `EXTERNAL_BOT_KEY`, Fly token, kullanıcı ve grup ID'leri okuma,
   yazma, loglama yok. Brif dışı veri dış servise gitmez. git push,
   force push, rebase, `main`'e merge yok. `rm -rf`, toplu silme yok.
   Testi atlatma, silme, `ALL` listesinden çıkarma yok.
8. TOKEN: Yalnızca brifteki ve ÖNCE OKU dosyaları; depoyu baştan tarama.
   Büyük dosyada (`server.js`, `infoBot.js`, `infoEngine.js`,
   `README.md`) Grep. Log'un ilgili kısmı (`| tail -40`).
9. RAPOR (denetçi hariç; o JSON döner):
   ALAN: web paneli | Telegram botu | istatistik kaydı | sinyal motoru
   DURUM: BİTTİ | KISMİ | DURDU
   ÇALIŞMA YERİ: yol, dal
   DEĞİŞEN DOSYALAR: yol (+/- satır)
   COMMIT'LER: kısa hash, mesaj
   KOMUTLAR VE SONUÇLAR: komut -> sayılı sonuç (ör. 28/28 geçti)
   MUTASYON KONTROLÜ: geri alınan değişiklik -> kırılan test, ya da
     "uygulanamaz: neden"
   BELLEK / YÜK ETKİSİ: coin başına yeni veri, Telegram mesaj sayısı,
     REST çağrısı; yoksa "yok"
   DOĞRULANAMAYANLAR
   ONAY GEREKTİRENLER: soru + seçenekler (artı/eksi)
   Boş bölüm "yok" yazılır, silinmez.
