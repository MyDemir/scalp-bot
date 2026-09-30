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
| Seviye (zorunlu) | fiyatın üstünde en fazla **%2.5** uzakta bir seviye: 4h MA200 · 4h EMA200 · 1d MA200 · 1d EMA200 · 30 günlük tepe (son 30 **kapanmış** günün en yüksek 3 tepesinin ortalaması) · **7 / 30 günlük en yüksek** (gerçek tepe) · **1h / 4h tepe** (salınım tepesi: iki yanındaki 3 mumdan yüksek) · **Günlük bölge** (son ~1 yılın günlük tepe/dip noktalarından ≥ 3 temas alan bölge — `zoneTouches`, menüden 2–6; eski destekler dahil; değer = bölgenin alt kenarı) · **Günlük trend çizgisi** (en yüksek günlük tepeden sonraki tepelere log ölçekte çizilen düşen çizgi, bugüne uzatılmış; kapanışlar üstüne çıkınca kırılmış sayılır) · **Fib 0.236 / 0.382 / 0.5 / 0.618 / 0.786** (1 SAATLİK geniş bacak: son ~2 haftanın 1h en yüksek tepesi ↔ en düşük dibi, yön otomatik — kart grafiğindeki Fib ile aynı). Birbirine %0.3'ten yakın seviyeler tek sayılır (çakışma Detay'da yazar). Yakında direnç yoksa bkz. **Fiyat keşfi** |
| Yeni veri | önceki karttan bu yana: RSI dilim sayısı değişti · bir dilim 95'i geçti · hacimli mum · seviye/bölge değişti (⭐ Dirençte'ye girdi, seviye kırıldı) · MACD ya da Stoch RSI kesişimi · 1m/3m negatif tepe arttı. **Yeni veri yoksa kart gitmez.** |

**Kurulum kontrol listesi ve derece** (kartta ✅/▫️, başlıkta daireler). 8 madde, yalnızca bilgi (kartı engellemez):

1. Günlük direnç yakın (1d MA200 / 1d EMA200 / 30 günlük tepe / 7–30 günlük en yüksek, üstte ≤ %2.5)
2. Çakışan direnç (başka bir seviye %0.5 içinde — "genelde majör dirençlerle kesişiyor")
3. 3m ya da 5m RSI 95–98 aralığında (98 üstü "aşırı" diye ayrı yazılır)
4. 15m RSI ≥ 95
5. 5m ve 15m birlikte ≥ 95
6. 1h ve 4h RSI ≥ 80 (şişkin)
7. 3m ve 5m EMA21'den ayrışmış (≥ 0.5 ATR, son 3 mumda dokunmamış) — değilse "⚠️ RSI 95 üstü ama EMA21'e yakın"
8. 1m ya da 3m'de ≥ 2 negatif tepe

Altında 🎯 hedef bölgeleri: 3m EMA21 ve 5m EMA21 (fiyat ve uzaklık). **Derece:** 🔴 skor 0–2 · 🔴🔴 3–5 · 🔴🔴🔴 6–8 (8 madde; `/ayarlar` → Derece).
🔴🔴🔴 sesli (kart sesi kapalıyken bile). Skor değişince kart gelir ("Kontrol listesi 5/8 → 7/8"). Eşikler `/ayarlar`:
`strongRsi`, `rsiEntryMax`, `confRsi`, `confluencePct`, `grade2Min`, `grade3Min`.
Hacim/⚡ daireleri: 1 temel · 2 hacim ≥ 3× · 3 + yön uyumu ≥ %65; renk yönü gösterir (🟢 alış/yükseliş · 🔴 satış/düşüş · ⚪ nötr).

**Seri içi patlama:** bir coinde kart gittikten sonra seri sürerken (kapanmış 5m RSI 75'in altına inmeden)
gelen hacimli 1m mum **şart aranmadan** kart olur (`#SERI`, kartta "Seri içi · şart dışı (RSI 1/3)" gibi).
Böylece tepedeki sert satış mumu RSI'ı 90'ın altına indirse de bildirilir. `/ayarlar` → "Seri patlama" ile kapatılabilir.

Seviye kırılırsa (fiyat seviyenin %0.3'ten fazla üstünde) o seviye sayılmaz, bir üstteki aranır.
Çakışan direnç maddesinde Fib ve 1h tepe sayılmaz (yalnız MA/EMA200, günlük tepeler, 4h tepe).

**🚀 Fiyat keşfi** (`/ayarlar` → 🎯 Direnç ve kırılım → Fiyat keşfi): RSI şartı sağlanıyor ama %2.5 içinde direnç yok
ve fiyat son 24 saatte bir seviyeyi (Fib hariç) yukarı kırmış → kart engellenmez. Kartta kırılan seviye, en yakın üst seviye
(varsa) ve son 1h bacağın **Fib uzantı** hedefleri (1.272 / 1.618; fiyat geçtiyse 2 / 2.618) yazılır · `#FIYATKESFI`.

**⚠️ Sahte kırılım (SFP)** (`/ayarlar` → Sahte kırılım, SFP süresi): her 5m kapanışında, fiyatın kırdığı seviyeler izlenir.
Kırılım = 5m mum seviyenin %0.3'ten fazla üstünde kapanır **ve** o an RSI kart şartı sağlanıyor (3m/5m/15m'den en az 2'si ≥ 85).
Kart da yalnızca **geri dönüş anında RSI kart şartı hâlâ sağlanıyorsa** gelir (sağlanmıyorsa bildirim yok). Kartın Direnç satırı ve ⭐, kırılan seviyeye göredir.
Yalnızca güçlü seviyeler izlenir: MA200/EMA200, 30 günlük tepe, 7/30 günlük en yüksek, günlük bölge, günlük trend çizgisi, 4h tepe (1h tepe ve Fib izlenmez).
Kırılımdan sonraki **6 mum (30 dk)** içinde bir 5m mum seviyenin **altında kapanırsa** — ya da aynı 5m mumun fitili seviyeyi
**≥ %0.5** aşıp gövdesi **≥ %0.2 altında** kapanırsa ve mumun hacmi önceki 20 mumun ortalamasının üstündeyse (fitil türü) — kart gelir.
Kartta 🔔 satırı `⚠️ Sahte kırılım` (ya da `⚠️ Sahte kırılım (fitil)`), altındaki satır ayrıntı (başlık tekrarlanmaz) ve daireler hep 🔴: `⚠️ Sahte kırılım: 30 günlük tepe 0.7646 · 20 dk önce üstüne çıktı, şimdi altında kapandı`
· `#SAHTEKIRILIM`. Derece kontrol listesinden. Aynı coinde bir SFP kartından sonra 30 dk yeni SFP kartı gelmez.
Aynı coinde kartlar **#1, #2 …** diye numaralanır; kapanmış 5m RSI 75'in altına inince numara sıfırlanır.

### Kartın içeriği
Hızlı okunsun diye kısa ve her şey açıkta (açılır kutu yok):
```
🔴🔴 #CVXUSDT — RSI                 ← daire sayısı = derece (kontrol skoru), rengi = son 15 dk yön (🟢 yükseliş · 🔴 düşüş)
🔔: RSI 85+ · Kart 3 · ⭐ Dirençte   ← neden geldi (sahte kırılımda "⚠️ Sahte kırılım", seri içinde "Seri sürüyor (şart dışı)")
⚠️ Sahte kırılım: … / 🚀 Fiyat keşfi: … / 🟢🟢 Hacimli yükselen mum …   ← yalnız özel olay varsa (en fazla 2 satır)
RSI 3dk: 86.1
RSI 5dk: 88.4
RSI 15dk: 85.2
RSI 1s: 75.7
RSI 4s: 67.9

Direnç: 4h MA200 2.3664 (%0.36 kala)
Fiyat: 2.358
⏱: 29.09 09:35
```
1 dk ≥ %2 hareket ayrı kart değildir: RSI şartı sağlanan coinde RSI kartına `⚡…` satırı olarak girer (bkz. aşağıda).

**Butonlar:** 📈 TradingView · 🟡 Binance / **📋 Detay** · 🔕 1s sustur · ☆ Takip.
**📋 Detay** yalnızca **basan kişiye özel mesajla** gelir; grupta hiçbir şey görünmez. Botu daha önce özel sohbette
başlatmamış kullanıcıda buton botla özel sohbeti açar (bir kez **Başlat**), Detay hemen gelir; sonrakiler doğrudan gelir.
Özel sohbette yalnızca bu istek kabul edilir ve yalnızca grup üyelerine gönderilir. Detay'ın bölümleri:
- 📊 **Hacim ve alış–satış** — 15 dk / 1 saat / 4 saat / 24 saat: USDT hacim · normaline oranı (15 dk ve 1 saat için son 24 saat,
  4 ve 24 saat için son 7 gün ortalaması) · alış % / satış % (taker) · net (alış − satış $) · hacimli mum sayısı (1 saat) ·
  `Bugün 1 dk ≥ %2: ▲ 5 · ▼ 3 · fark +2`; kartı 1 dk hareket doğurduysa onun ayrıntısı
- 🎯 **Kontrol x/8** — sağlanan maddeler değerleriyle, eksikler tek satırda, varsa ⚠️ uyarı
- 📏 **Hedef** (3dk/5dk EMA21) · 3dk EMA21 durumu (izliyor / koptu / serbest) · fiyat keşfinde kırılan seviye, sonraki direnç, Fib uzantı
- 🧭 **Diğer** — funding, açık pozisyon (1 saat), BTC (1 saat) · MACD 5dk, Stoch RSI, VWAP · üstteki dirençler
Ayrıntılar bellekte tutulur (son 3000 kart); bot yeniden başlayınca eski kartların Detay'ı "artık yok" der.

- **EMA21** 3m/5m: fiyata uzaklığı (%) ve ATR cinsinden ayrışma (geri çekilme hedefleri)
- **Negatif tepe** (1m/3m): fiyat eşit ya da daha yüksek tepe yaparken RSI daha düşük tepe — ardışık sayı
  ("2–3 tepe negatif yapıp çakarsa"). Son tepe 6 mumdan eskiyse sayılmaz. ≥2 ise `#NEGTEPE`.
- **Hacim sayacı** (60 dk ve 15 dk): 1m gövde ≥ %1 / ≥ %1.5 ve hacim ≥ 2× (önceki 20 mum ortalaması);
  taker alış > %55 → alım, < %45 → satış, arası nötr. Art arda gelen patlama mumları tek patlama sayılır.
- Hashtag'ler (Detay mesajında; dokununca o sınıftaki tüm kartlar listelenir): `#COIN #DERECE1/2/3 #DIRENCTE/#YAKLASIYOR #HACIM #SERI #SAHTEKIRILIM #FIYATKESFI #NEGTEPE #AYRISMA #TAKIP`
- **Bildirim:** her yeni kart sesli gelir (`/ayarlar` → "Kart sesli" kapatılırsa yalnız 🔴🔴🔴 ve takipteki coinler sesli).

### Grafik
Kartlar ve ⚡ uyarılar **grafikli** gelir (fotoğraf + açıklama). Varsayılan **1 saatlik** grafik (son 100 mum ≈ 4 gün):
- **Fibonacci düzeltme seviyeleri** (0 · 0.236 · 0.382 · 0.5 · 0.618 · 0.786 · 1) — 1 SAATLİK geniş bacak (son ~2 haftanın 1h en
  yüksek tepesi ↔ en düşük dibi; dip sonra geldiyse tepe → dip, düşüşte seviyeler dirençtir). TradingView'deki gibi 1 = bacağın başı,
  0 = sonu; tepe ve dip noktaları işaretli. Grafik bacağın başladığı mumdan itibaren çizilir (en fazla 240 mum). Motorun direnç
  listesiyle aynı bacak. 0.618 kalın.
- **Kenar etiketleri:** görünen aralığın (fiyatın ±%12'si) üstünde kalan en yakın 4 seviye — Fib ve günlük dirençler (MA/EMA200,
  günlük bölge, trend çizgisi, 7/30 günlük en yüksek) — sağ üstte `↑ 1d MA200 0.0052 (+%35.2)` biçiminde yazılır.
- **Ichimoku bulutu** (KivancOzbilgic parametreleri, varsayılan 10/30/30/60/30; Senkou A ≥ B yeşil, A < B kırmızı)
- Yakındaki direnç seviyeleri (en yakını turuncu, diğerleri gri), hacim, son fiyat etiketi
- 5m grafik seçilirse 3m EMA21 (beyaz) ve 5m EMA21 (sarı) çizgileri de çizilir

`/ayarlar` → 🖼 Grafik: **Grafik TF** (5m / 15m / 1h / 4h), Fibonacci, Ichimoku, Grafik (kartlar), Grafik ⚡ (uyarılar).
Evren dışı pariteler için grafik verisi o an REST'ten çekilir. Açıklama 1024 karakteri aşarsa "Detaylar" sondan kırpılır.
Çizim `@napi-rs/canvas` ile, yazı tipi repo içinde (`src/assets/fonts`, DejaVu); grafikler diske yazılmaz.

### ⚡ 1 dakikalık hareket (RSI kartının içinde)
Ayrı hareket kartı **yok**. Yalnızca **izlenen** coinlerde (24s hacim ≥ 3M $) 1m kapanış, bir önceki 1m kapanışa göre
**≥ %2** değişirse:
- **RSI şartı sağlanıyorsa** RSI kartı gelir; 🔔 satırının altında `⚡🟢🟢🟢 1 dk +%3.29 · hacim 34.0 kat · alış %70`
  (daire sayısı = hacim derecesi, rengi = yön). Aynı mum hacimli mum da sayılıyorsa yalnız ⚡ satırı yazılır. `#HAREKET`
- **RSI şartı yoksa** kart gelmez; hareket yalnızca günlük sayaca yazılır.
- **📋 Detay**'da: hareketin ayrıntısı (eski → yeni fiyat, hacim katı, alış/satış) ve
  `Bugün 1 dk ≥ %2 hareket: ▲ 5 · ▼ 3 · fark +2`. Sayaç bellekte tutulur (diske yazılmaz), gece yarısı (İstanbul) sıfırlanır,
  bot yeniden başlayınca sıfırdan başlar.
- İzlenen liste dışındaki pariteler dinlenmez (bildirim yok).
Ayar: `/ayarlar` → ⚡ Hareket (`moveAlertPct`, 0 = kapalı).

**⚠️ Short'a karşı** (yalnız 📋 Detay'da, dereceyi etkilemez): **4s gizli PU** — son iki 4 saatlik dipte fiyat daha yüksek dip,
RSI daha düşük dip (ikinci dip son 10 mum içinde) · **günlük golden cross** — SMA50, SMA200'ün altında ama fark ≤ %2 ve 5 günde daralıyor
("yakın") ya da son 10 günde kesti ("oldu").

**⭐ Dirençte** (yalnız 🔔 satırında): fiyat en yakın direncin en fazla %0.5 altında ya da %0.3 üstünde (fitil payı). Daha yukarısı = seviye kırıldı.
Detay'da direnç ayrıntısı: günlük bölgenin aralığı ve temas sayısı, trend çizgisinin iki tepesi, günlük Fib bacağı, çakışan seviyeler.

**3dk EMA21 durumu** (yalnız 📋 Detay'da): *izliyor (trend)* — son 10 mumun ≥ 6'sında fiyat EMA21'e değdi;
*koptu* — önceki 10 mumun ≥ 6'sında değmişken son 3 mumda değmedi ve fiyat ≥ 1.5 ATR yukarıda; aksi *serbest*.

### Kart geçmişi
Her kart ve ⚡ uyarı `/data/cards.db`'ye (SQLite) yazılır; sonrasında fiyat 15 / 60 / 240 dk izlenir
(en düşük / en yüksek / kapanış değişimi, kart anındaki fiyata göre — kazanç/kayıp değil). 90 gün saklanır.
Yeniden başlatmada yarım kalan takipler "eksik" işaretlenir.
- `/gecmis ETH [adet]` — coinin son kartları + sonrasında fiyat
- `/istatistik [gün]` — kart sınıfları (RSI 2/3–3/3, Dirençte, hacim, seri içi, negatif tepe …) ve ⚡ uyarılar için
  "sonraki 60 dk" medyanları — backtest'teki tablonun canlı hali

### Seviye tepkisi (/seviye)
İzlenen her coinde fiyat bir dirence **alttan** değdiğinde (önceki 1m kapanış seviyenin %0.3'ten fazla altında, bu
mumun tepesi %0.3 yakınında ya da üstünde) sonraki **60 dk** kaydedilir — kart çıksın çıkmasın. Seviyeler kartlardakiyle
aynı (Fib 0.236–0.786, günlük bölge / trend çizgisi, 7/30g en yüksek, MA200/EMA200, 1h/4h tepe). Aynı seviye için
60 dk içinde ikinci temas yazılmaz. Kartı etkilemez; `/data/cards.db` → `touches` tablosu, 60 gün saklanır.
- Temasta: 3m/5m/15m RSI (RSI kart şartı sağlanıyor mu), ±5 dk içinde kart çıktı mı, fiyatın 3dk EMA21'e uzaklığı
- 60 dk'da: **çekilme** (o ana kadarki en yüksekten en derin geri çekilme, %) · **EMA21'e dönüş** (1m mum 3dk EMA21'e
  indi mi, kaç dk sonra) · **kırdı** (5dk kapanış seviyenin %`dipAbovePct` üstünde; EMA21'e döndükten sonra mı) ·
  **üstte kaldı** (60. dk kapanışı seviyenin üstünde)
- **Nerede durdu:** ret yiyen (seviyeyi kıramadan geri çekilen) temasta en derin çekilmenin dibi, o andaki hareketli
  ortalamalarla kıyaslanır — 3dk / 5dk / 15dk EMA21 (grafikte görünen, canlı mum dahil).
  Dip bir ortalamanın ±%0.5'inde durduysa o ortalama (ör. "5dk EMA21"); birini %0.5'ten fazla delip alttakine inmediyse
  "5dk–15dk EMA21 arası"; 15dk EMA21'i de deldiyse "15dk EMA21 altı"; hiçbirine inmediyse "ortalamaya inmedi".
- `/seviye [gün] [ad]` — telefona göre kısa satırlar: 🔥 **Pompa (RSI 85+)**: temas · ret / kırdı (hangisi önce) ·
  ret çekilmesi · dibe kaç dk · 🛑 **ret sonrası nerede durdu** dağılımı · kırıp üstte kalan; 💤 RSI şartı yokken kısa
  özet; 📊 seviyelere göre (pompa, 5+ örnekli seviyeler; azı tek satırda); tanımlar en altta açılır blokta.
  Ör. `/seviye 7 fib`, `/seviye 14 bölge`. Kazanç/kayıp değildir. Backtest aynı tabloyu geçmiş veriden hemen verir (aşağıda).

### Konulu (forum) gruba bağlama
Kartlar, ⚡ uyarılar, bot mesajları ve backtest raporları grubun **ayrı konularına** gönderilebilir.
1. Grup ayarları → **Konular**'ı aç (grup süpergrup olmalı; ID çoğunlukla değişmez). Yeni bir grup kullanacaksan
   botu ekle, gruba bir komut yaz ve `fly logs`'ta `Tanımsız sohbetten mesaj yok sayıldı: … ID -100…` satırındaki
   ID'yi `fly secrets set TELEGRAM_CHAT_ID=-100…` ile tanımla.
2. İstediğin konunun **içinde** (yönetici olarak) yaz: `/konu kart` · `/konu sistem` ·
   `/konu kart3` (🔴🔴🔴'ler ayrı konuya) · `/konu backtest`. Bağlantı `/data`'da saklanır.
3. `/konu` listeyi gösterir, `/konu sil kart` kaldırır. Bağlanmamış tür genel akışa gider; konu silinirse mesajlar
   kaybolmaz, genel akışa düşer. Komut yanıtları, komutun yazıldığı konuya gelir.

### Telegram komutları
| Komut | Kim | |
|---|---|---|
| `/ayarlar` | herkes görür, yöneticiler değiştirir | ana sayfa: bölümler + özet değerler (RSI kartı · Direnç · Derece · Hacimli mum · ⚡ Hareket · Bildirim · Grafik · İzlenen coinler) → bölüm: her ayar bir buton (aç-kapa ayarları tek dokunuşla) → sayısal ayar: kendi sayfasında −5/−1/+1/+5 adım ve ↺ Varsayılan |
| `/ayar anahtar değer` · `/ayar sifirla` | yönetici | ör. `/ayar rsiMin 95`, `/ayar levelMaxPct 2` |
| `/coin ETH` | herkes | coinin anlık durumu (şart aranmadan) |
| `/sustur ETH [dk]` · `/ac ETH` · `/sessiz` | yönetici / herkes | susturma |
| `/takip [ETH]` | liste herkes, ekle-çıkar yönetici | takipteki coinlerin kartları her zaman sesli |
| `/gecmis ETH [adet]` · `/istatistik [gün]` | herkes | kart geçmişi ve sınıf istatistiği |
| `/seviye [gün] [ad]` | herkes | seviye tepkisi: temastan sonra çekilme / 3dk EMA21'e dönüş / kırılım (ör. `/seviye 7 fib`) |
| `/konu [ad]` · `/konu sil ad` | liste herkes, bağlama yönetici | konulu grupta yönlendirme |
| `/durum` · `/benkimim` · `/yardim` | herkes | `/durum`: izlenen/hazır coin, **geride kalan coinler** (son 3 dk'da 1m mumu gelmeyen), son 5 dk'da işlenen mum sayısı, **gecikme** (mum kapanışı → bot işledi; ort / en fazla) ve işlem yükü. Gecikme 20 sn'yi aşarsa ya da geride coin varsa `fly logs`'ta `[UYARI]` |

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
node src/infoBacktest.js --symbol ARK,ETH,SOL --days 30 --canli-ayar --seviye-filtre fib --telegram  # seviye tepkisi (yalnız Fib)
```
Çıktı: kart sayısı (günlük), seri sayısı, sesli/sessiz, Telegram yükü (en yoğun dakika/saat), sınıf
tablosu (RSI 2/3–3/3, Dirençte/yaklaşıyor, hacim tetikli, seri içi, ayrışma, destek, negatif tepe), listedeki
coinlerde 1 dk ≥ %2 hareket sayısı, **seviye tepkisi tablosu** (canlıdaki `/seviye` ile aynı; `--seviye-filtre fib`
ile süzülür) ve `backtest-results/info-*.json`. Varsayılan ayarlar canlıyla aynıdır.
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
├── cardStore.js      # Kart geçmişi (SQLite /data/cards.db) + 15/60/240 dk takip + seviye tepkisi tablosu
├── levelTouch.js     # Seviye tepkisi: dirence alttan temas → 60 dk çekilme / EMA21 / kırılım (canlı + backtest ortak)
├── infoBacktest.js   # Bilgi botu backtest'i
├── levels.js         # 4h/1d MA200 · EMA200 · 30 günlük tepe · 7/30g en yüksek · 1h/4h tepe · Fib düzeltme/uzantı
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
