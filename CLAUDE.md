# Scalp Bilgi Botu

Tek paket Node.js (CommonJS, Node ≥ 20) projesi: Binance USDT-M Futures
bilgi / sınıflandırma botu. Koşulu sağlayan coinler için Telegram'a kart
ve 🔻 tepe kurulumu bildirimi gönderir; otomatik işlem yoktur. Aynı
süreçte salt okunur web paneli (`src/server.js`, port 3000) çalışır.
Kod `src/`, testler `test/`; kullanıcı kılavuzu `README.md`.

## Komutlar
- Kurulum: `npm ci` (better-sqlite3 ve @napi-rs/canvas yerel modül; ilk
  kurulum birkaç dakika sürebilir)
- Testler: `npm test` (tümü, `test/run.js`), tek tek:
  `node test/run.js peak weekly` (ada göre süzer). Ağ gerekmez; Binance
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
  raporlanır. Node heap sınırı (`--max-old-space-size`) şu an
  `fly.toml`/`Dockerfile`'da ayarlı değil; eklemek onay kapısıdır.
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
  ve dönemlere bölünmüş sonuç (README'deki tepe kurulumu tablosu gibi).
  Tek dönemde tutup diğerinde tutmayan kural öneri olamaz.
- Bot bilgi verir, karar vermez: kart ve bildirim metni al/sat emri gibi
  yazılmaz; otomatik işlem eklenmez.
- Canlı ve backtest aynı kodu kullanır (`series.js`, `infoEngine.js`,
  `infoCard.js`, `eventLog.js`, `levelTouch.js`). Bir tarafa özel dal
  açılmaz; look-ahead yok.
- Kart derece / tepe kuralları ve varsayılan eşikleri (`src/config.js`
  `info`, `src/infoEngine.js` derece hesabı, `src/peakAlert.js`)
  kullanıcı onayı gerektirir. Kart biçimi değişikliği de onaylıdır.
- Davranış ya da komut değişikliği aynı dalda `README.md`'ye yansır
  (tablo, örnek kart, komut listesi).
- Analizler Claude projesinin `analiz/` klasöründe durur
  (`short-kurulum.md`, `long-kurulum.md`, `gelistirme-alanlari.md`);
  kural işinde önce bunlar okunur.

## Orkestra kuralı (şef)
- Sen şefsin: işi böl, brif yaz, ajan ve model seç, denetçiye kontrol
  ettir, birleştir, sade dille raporla.
- Kod, tasarım ya da metni kendin üretme; kendi işini kendin onaylama.
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
GÖREV · SENİN DOSYALARIN · DOKUNMA · ARAYÜZ · ONAY KAPILARI · ÖNCE OKU ·
BİTTİ TANIMI · RAPOR
- ARAYÜZ: başka bir işle paylaşılan sözleşme; dosya yolu, fonksiyon
  imzası, ayar anahtarı, Telegram komutu ve argümanları, kart / CSV
  kolonları, SQLite kolonu, CLI argümanları, çıkış kodları. Yoksa "yok".
- ONAY KAPILARI: bu iş için kullanıcının önceden verdiği onaylar,
  açıkça ("src/peakAlert.js funding eşiği: onaylı"). Yazmayan kapı
  kapalıdır.
- BİTTİ TANIMI: çalıştırılacak komutlar ve beklenen sonuç
  (ör. `node test/run.js peak` -> 1/1 geçti; `npm test` -> 28/28).

## Ajan ortak kuralları (her ajan uyar)
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
