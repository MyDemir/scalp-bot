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
| Seviye (zorunlu) | fiyatın üstünde en fazla **%2.5** uzakta bir seviye: 4h MA200 · 4h EMA200 · 1d MA200 · 1d EMA200 · 30 günlük tepe (son 30 **kapanmış** günün en yüksek 3 tepesinin ortalaması) · **7 / 30 günlük en yüksek** (gerçek tepe) · **1h / 4h tepe** (salınım tepesi: iki yanındaki 3 mumdan yüksek) · **Haftalık bölge** (günlük mumlar Binance haftasına — Pazartesi 00:00 UTC — toplanır; haftalık pivot tepe/diplerden %2 içinde ≥ 2 temas; `levelsWeeklyZone`) · **Günlük bölge** (son ~1 yılın günlük tepe/dip noktalarından ≥ 3 temas alan bölge — `zoneTouches`, menüden 2–6; eski destekler dahil; değer = bölgenin alt kenarı) · **Günlük trend çizgisi** (en yüksek günlük tepeden sonraki tepelere log ölçekte çizilen düşen çizgi, bugüne uzatılmış; kapanışlar üstüne çıkınca kırılmış sayılır) · **Fib 0.236 / 0.382 / 0.5 / 0.618 / 0.786** (1 SAATLİK geniş bacak: son ~2 haftanın 1h en yüksek tepesi ↔ en düşük dibi, yön otomatik — kart grafiğindeki Fib ile aynı). Birbirine %0.3'ten yakın seviyeler tek sayılır (çakışma Detay'da yazar). Yakında direnç yoksa bkz. **Fiyat keşfi** |
| Yeni veri | önceki karttan bu yana: RSI dilim sayısı değişti · bir dilim 95'i geçti · hacimli mum · seviye/bölge değişti (⭐ Dirençte'ye girdi, seviye kırıldı) · MACD ya da Stoch RSI kesişimi · 1m/3m negatif tepe arttı. **Yeni veri yoksa kart gitmez.** |

**Kurulum kontrol listesi** (Detay'da ✅/▫️). 9 madde, puanla; yalnızca bilgi — kartı engellemez, varsayılan derece hesabında da kullanılmaz (bkz. Derece):

1. Günlük / haftalık direnç yakın (1d MA200 / 1d EMA200 / 30 günlük tepe / 7–30 günlük en yüksek / günlük–haftalık bölge, üstte ≤ %2.5) — 1 puan
2. Çakışan direnç (başka bir seviye %0.5 içinde) — 1 puan
3. 3m ya da 5m RSI 95–100 (`rsiEntryMax`) — 1 puan
4. 15m RSI ≥ 95 — 1 puan
5. 5m ve 15m birlikte ≥ 95 — 1 puan
6. 1h ve 4h RSI ≥ 80 (şişkin) — 1 puan
7. EMA21 ayrışma: fiyat 3m ya da 5m EMA21'in **üstünde** %2 / %5 / %10 → 1 / 2 / 3 puan (`sepPct2/5/10`; altındaysa 0) — yoksa "⚠️ RSI 95 üstü ama EMA21 yakın"
8. 1m ya da 3m'de ≥ 2 negatif tepe — 1 puan
9. 3m ya da 5m MACD sat (aşağı) kesişimi — 1 puan

Detay'da 🎯 hedef: 3m EMA21 ve 5m EMA21 uzaklığı. Kontrol listesi Detay'da bilgi olarak durur.

**Derece (varsayılan `gradeBy = sart3`):** daireler hep 🔴 (short olgunluğu); 1 + sağlanan şart sayısı — EMA21 ayrışma (3m ve 5m ≥ `sepPct2`) ·
1s RSI `gradeRsi1h`–`gradeRsi1hMax` (80–88) · 15dk RSI ≥ `gradeRsi15m` (85). **🚀 Kaçak pompa** (1s RSI ≥ 88 ya da 4s RSI ≥ `gradeRsi4hMax` 80):
en fazla `gradeRunawayMax` (2) daire — bu durumda tepe çoğu zaman sürdü (60 dk sonra %27–39 aşağıda, önce medyan +%11–12).
Direnç yoksa (fiyat keşfi) en fazla `gradeNoLevelMax` (3) daire. 🔔 satırında son 15 dk yönü (▲/▼) ve 3dk/5dk RSI ≥ 95 ise `🔥 RSI 95+`
(dereceye girmez: tek başına sonucu ayırmadı). Bu kurallarla aynı veride: 🔴 %14 · 🔴🔴 %29 · 🔴🔴🔴 %63 · 🔴🔴🔴🔴 %82 aşağıda
(eski liste: 🔴 %27 · 🔴🔴 %50 · 🔴🔴🔴 %30). Tavansız ilk sürüm: 18–20.10 verisinde (769 kart, 60 dk sonra fiyat kart anının altında):

| Sağlanan şart | Kart | 60 dk sonra aşağıda | Medyan dip (60 dk) |
|---|---|---|---|
| 0 → 🔴 | 310 | %14 | −%0.1 |
| 1 → 🔴🔴 | 296 | %28 | −%0.4 |
| 2 → 🔴🔴🔴 | 99 | %61 | −%1.2 |
| 3 → 🔴🔴🔴🔴 | 64 | %72 | −%4.1 |

Aynı veride 3m/5m RSI eşikleri, tetik TF'si, günlük/çakışan direnç, negatif tepe, MACD, Stoch ve VWAP σ sonucu ayırmadı
(kontrol listesi skoru 3 → %47). Veri iki günlük; yeni dışa aktarmayla yeniden bakılmalı.
**`gradeBy = liste`** eski hesap: kontrol listesi puanı 🔴 0–2 · 🔴🔴 3–4 · 🔴🔴🔴 5–6 · 🔴🔴🔴🔴 7+
(`grade2Min` / `grade3Min` / `grade4Min`, `/ayarlar` → Derece). 🔴🔴🔴 ve 🔴🔴🔴🔴 sesli (kart sesi kapalıyken bile) ve `/konu kart3`'e gider.
Eşikler `/ayarlar → 🏅 Derece ve kontrol listesi`: `gradeBy`, `gradeRsi1h`, `gradeRsi15m`, `strongRsi`, `rsiEntryMax`, `confRsi`, `confluencePct`, `sepPct2/5/10`, `grade2Min`, `grade3Min`, `grade4Min`.
Hacim/⚡ daireleri: 1 temel · 2 hacim ≥ 3× · 3 + yön uyumu ≥ %65; renk yönü gösterir (🟢 alış/yükseliş · 🔴 satış/düşüş · ⚪ nötr).

**Seri içi patlama:** bir coinde kart gittikten sonra seri sürerken (kapanmış 15m RSI 75'in altına inmeden)
gelen hacimli 1m mum, o an **15m RSI ≥ 85** ise (`seriesMinRsi15m`) şart aranmadan kart olur (`#SERI`). 15m RSI 85'in altına
inmişse (sert satış mumu RSI'ı düşürdüyse) kart gelmez — sürekli hacim bildirimi olmasın diye. `/ayarlar` → "Seri patlama" ile kapatılabilir.

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
· `#SAHTEKIRILIM`. Derece aynı hesapla (`gradeBy`). Aynı coinde bir SFP kartından sonra 30 dk yeni SFP kartı gelmez.
Aynı coinde kartlar **#1, #2 …** diye numaralanır; kapanmış 15m RSI 75'in altına inince numara sıfırlanır.

### Kartın içeriği
Hızlı okunsun diye kısa ve her şey açıkta (açılır kutu yok):
```
🔴🔴 #CVXUSDT — RSI                 ← daire sayısı = derece (1 + sağlanan şart), rengi = son 15 dk yön (🟢 yükseliş · 🔴 düşüş)
🔔: RSI 85+ · Kart 3 · ⭐ Dirençte   ← neden geldi (sahte kırılımda "⚠️ Sahte kırılım", seri içinde "Seri sürüyor (şart dışı)")
⚠️ Sahte kırılım: … / 🚀 Fiyat keşfi: …   ← yalnız özel olay varsa (en fazla 2 satır)
RSI 3dk: 86.1
RSI 5dk: 88.4
RSI 15dk: 85.2
RSI 1s: 75.7
RSI 4s: 67.9

Direnç: 4h MA200 2.3664 (%0.36 kala)
Fiyat: 2.358
Funding: −%0.0050 · 40dk sonra       ← funding oranı ve sonraki ödemeye kalan süre
🟢🟢 Hacimli yükselen mum: +%1.6 · hacim 3.9 kat · alış %61   ← yalnız varsa (⚡ 1 dk hareket satırı da burada)
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
- 🏅 **Derece x/4** — üç şartın durumu: `✅ EMA21 ayrışma · ✅ 1s RSI ≥ 80 · ▫️ 15dk RSI ≥ 85` (`gradeBy = liste` iken yok)
- 🎯 **Kontrol x/9** — sağlanan maddeler değerleriyle, eksikler tek satırda, varsa ⚠️ uyarı
- 📏 **Hedef** (3dk/5dk EMA21) · 3dk EMA21 durumu (izliyor / koptu / serbest) · fiyat keşfinde kırılan seviye, sonraki direnç, Fib uzantı
- 🧭 **Diğer** — açık pozisyon (1 saat), BTC (1 saat) · MACD 5dk, Stoch RSI, VWAP · üstteki dirençler
Ayrıntılar bellekte tutulur (son 3000 kart); bot yeniden başlayınca eski kartların Detay'ı "artık yok" der.

- **EMA21** 3m/5m: fiyata uzaklığı (%) ve ATR cinsinden ayrışma (geri çekilme hedefleri)
- **Negatif tepe** (1m/3m): fiyat eşit ya da daha yüksek tepe yaparken RSI daha düşük tepe — ardışık sayı
  ("2–3 tepe negatif yapıp çakarsa"). Son tepe 6 mumdan eskiyse sayılmaz. ≥2 ise `#NEGTEPE`.
- **Hacim sayacı** (60 dk ve 15 dk): 1m gövde ≥ %1 / ≥ %1.5 ve hacim ≥ 2× (önceki 20 mum ortalaması);
  taker alış > %55 → alım, < %45 → satış, arası nötr. Art arda gelen patlama mumları tek patlama sayılır.
- Hashtag'ler (Detay mesajında; dokununca o sınıftaki tüm kartlar listelenir): `#COIN #DERECE1/2/3/4 #DIRENCTE/#YAKLASIYOR #HACIM #SERI #SAHTEKIRILIM #FIYATKESFI #NEGTEPE #AYRISMA #TAKIP`
- **Bildirim:** her yeni kart sesli gelir (`/ayarlar` → "Kart sesli" kapatılırsa yalnız 🔴🔴🔴 ve takipteki coinler sesli).

### Grafik
Kartlar ve ⚡ uyarılar **grafikli** gelir (fotoğraf + açıklama). Varsayılan **1 saatlik** grafik (son 100 mum ≈ 4 gün):
- **Fibonacci düzeltme seviyeleri** (0 · 0.236 · 0.382 · 0.5 · 0.618 · 0.786 · 1) — 1 SAATLİK geniş bacak (son ~2 haftanın 1h en
  yüksek tepesi ↔ en düşük dibi; dip sonra geldiyse tepe → dip, düşüşte seviyeler dirençtir). TradingView'deki gibi 1 = bacağın başı,
  0 = sonu; tepe ve dip noktaları işaretli. Grafik bacağın başladığı mumdan itibaren çizilir (en fazla 240 mum). Motorun direnç
  listesiyle aynı bacak. 0.618 kalın.
- **Sağ üst liste — yalnız önemli, henüz geçilmemiş dirençler (en fazla 5):** her türden **yalnız en yakını** (4 günlük bölge
  değil, fiyatın önce test edeceği 1 tane). Önem sırası H42 temas verisinden (60 dk'da kırılmama oranı, oynaklığa göre):
  MA/EMA200 (%66–67) → günlük/haftalık bölge, 4h tepe → 1h tepe, trend çizgisi, Fib → 7/30 günlük en yüksek, 30 günlük
  tepe (%48–58, sık kırılır). Kartın direnci her zaman listede. Liste fiyata göre sıralı:
  `↑ ★ Günlük bölge 0.39294 (+%7.0 · 6 temas)` — ★ ve açık renk = en az 4 temas.
- **Grafik içi çizgiler yalnız güçlü dirençler:** kesikli çizgiler her türden fiyatın üstünde ve altında yalnız en yakını, en az **4 kez test edilmiş** dirençler (`chartMinTouches`,
  `/ayarlar` → 🖼 Grafik). Temas = kapanmış 4h mumlarda (~100 gün) tepe seviyeye %0.5 yaklaşıp kapanışın üstünde kalmaması;
  art arda değen mumlar tek temas; MA/EMA200 ve trend çizgisi kendi o anki değeriyle. Kartın direnci her zaman çizilir
  (`4h tepe 0.37164 · 2 temas`). Detay'da "Direnç testi: … N kez denendi".
- **Ichimoku bulutu** (KivancOzbilgic parametreleri, varsayılan 10/30/30/60/30; Senkou A ≥ B yeşil, A < B kırmızı)
- Yakındaki direnç seviyeleri (kartın direnci turuncu, diğerleri gri — fiyatın altındakilerin yanında temas sayısı), hacim, son fiyat etiketi
- 5m grafik seçilirse 3m EMA21 (beyaz) ve 5m EMA21 (sarı) çizgileri de çizilir

`/ayarlar` → 🖼 Grafik: **Grafik TF** (5m / 15m / 1h / 4h), Fibonacci, Ichimoku, Grafik (kartlar), Grafik ⚡ (uyarılar).
Evren dışı pariteler için grafik verisi o an REST'ten çekilir. Açıklama 1024 karakteri aşarsa "Detaylar" sondan kırpılır.
Çizim `@napi-rs/canvas` ile, yazı tipi repo içinde (`src/assets/fonts`, DejaVu); grafikler diske yazılmaz.

### ⚡ 1 dakikalık hareket (RSI kartının içinde)
Ayrı hareket kartı **yok**. Yalnızca **izlenen** coinlerde (24s hacim ≥ 3M $) 1m kapanış, bir önceki 1m kapanışa göre
**≥ %2** değişirse:
- **RSI şartı sağlanıyorsa** RSI kartı gelir; kartın altında (⏱ satırının üstünde) `⚡🟢🟢🟢 1 dk +%3.29 · hacim 34.0 kat · alış %70`
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

### 🔻 Tepe reddi (ayrı bildirim)
Kart biçimine dokunmaz; şart oluşunca gruba **ayrı kısa mesaj + grafik** gider (`/konu tepe`, boşsa kart konusu).
Tepe defterinin her yeni adayında (1dk mum son 60 dk'nın en yükseği, 4 saatlik dipten ≥ %3) tepe mumu puanlanır:

| Koşul (1 puan) | Tanım |
|---|---|
| Mum reddi | 5dk mumda üst fitil ≥ %35 **ya da** 1dk mum alt yarısında kapandı |
| Kırmızı mum | tepe 1dk mumu açılışının altında kapandı |
| Hacim | 3dk mum hacmi önceki 20 mumun ≥ 2 katı |
| Seans | Asya (03–09 TSİ) ya da Avrupa (10–15 TSİ) |

H42 verisi (22.572 aday): skor 0 → %7 · 2 → %21 · 3 → %32 · 4 → %39 "gerçek tepe" (60 dk tepe aşılmadı + kapanıştan ≥ 2×ATR(5dk)
düşüş); tüm adaylarda %16. RSI, VWAP σ, açık pozisyon, long/short, funding ve 5dk teyit mumu tutarlı katkı yapmadı.

**Oynaklık şartı (5dk ATR):** 18–20.10 verisinde (7.700 aday, 1.213 pompa; pompa başına ilk eşleşen aday, pompa ≥ %5)
belirleyici olan coinin o anki oynaklığıydı:

| Filtre | Pompa | 15 dk'da −%1.5'e indi | 60 dk sonra aşağıda | Medyan dip (60 dk) |
|---|---|---|---|---|
| Skor 4 | 84 | %67 | %68 | −%2.2 |
| **Skor 4 + ATR ≥ %1.2** (varsayılan) | 23 | %100 | %78 | −%5.6 |
| Skor 3 + ATR ≥ %1.2 | 74 | %85 | %62 | −%4.5 |
| Skor 3 + ATR < %1 | 237 | %26 | %60 | −%1.3 |

Veri 39 saatlik; yeni dışa aktarmayla yeniden bakılmalı.
```
🔻 #XUSDT — Tepe reddi 4/4
✅ Mum reddi · ✅ Kırmızı mum · ✅ Hacim 2.5 kat · ✅ Seans (Avrupa)
Pompa: +%6.2 (4s dipten · 48 dk) · ATR 5dk %1.60
Tepe: 1.06 · Fiyat: 1.05
EMA21 3dk 1.03448 (−%1.5) · 5dk 1.0224 (−%2.7) · 15dk 1.00286 (−%4.7)
⏱: 13.10 12:32
```
📋 Detay: mum ölçüleri (fitil %, kapanış konumu, gövde, hacim, alış), RSI, VWAP σ, ATR, tepki seviyesi, direnç, açıklama. `#TEPERED`
`/ayarlar` → 🔻 Tepe reddi: aç/kapa (`peakAlert`), en az skor (`peakAlertMin`, varsayılan **4** → yalnız 03–15 TSİ; 3 = her saat), 5dk ATR en az % (`peakAlertAtrPct`, varsayılan **1.2**; 0 = kapalı),
pompa en az % (`peakAlertPumpPct`, varsayılan 5), **yalnız RSI kart şartı sağlanan coinlerde** (`peakAlertRsiOnly`, varsayılan kapalı — açıkken o an RSI şartı (`rsiMin`, `minTFs`) sağlanmayan tepeler atlanır; H42'de skor ≥ 3 + RSI şartlı adaylar %41 gerçek tepe ama sayıca çok az), coin başına aralık (`peakAlertGapMin`, varsayılan 30 dk). Mesajda RSI şartı sağlanıyorsa `RSI şartı ✅` yazar. Varsayılanlarla
H42'de günde ~60 bildirim olurdu (skor ≥ 3, pompa ≥ %3 ile ~600). Susturulan coinlere gitmez. Kayıt: `cards` tablosu, `kind = tepe`
(5/15/30/60/240 dk sonrası takip edilir; `/gecmis`'te görünür). Bilgi amaçlıdır, al/sat sinyali değildir.

### Kart geçmişi
Her kart ve ⚡ uyarı `/data/cards.db`'ye (SQLite) yazılır; sonrasında fiyat 5 / 15 / 30 / 60 / 240 dk izlenir
(en düşük / en yüksek / kapanış değişimi, kart anındaki fiyata göre — kazanç/kayıp değil). 90 gün saklanır.
Yeniden başlatmada yarım kalan takipler "eksik" işaretlenir.
- `/gecmis ETH [adet]` — coinin son kartları + sonrasında fiyat
- `/istatistik [gün]` — kart sınıfları (dip 5/15/30/60 dk · 60 dk tepe · 60. dk) (RSI 2/3–3/3, Dirençte, hacim, seri içi, negatif tepe …) ve ⚡ uyarılar için
  "sonraki 60 dk" medyanları — backtest'teki tablonun canlı hali

### Seviye tepkisi (/seviye)
İzlenen her coinde fiyat bir dirence **alttan** değdiğinde (önceki 1m kapanış seviyenin %0.3'ten fazla altında, bu
mumun tepesi %0.3 yakınında ya da üstünde) sonraki **60 dk** kaydedilir — kart çıksın çıkmasın. Seviyeler kartlardakiyle
aynı (Fib 0.236–0.786, günlük bölge / trend çizgisi, 7/30g en yüksek, MA200/EMA200, 1h/4h tepe). Aynı seviye için
60 dk içinde ikinci temas yazılmaz. Kartı etkilemez; `/data/cards.db` → `touches` tablosu, 60 gün saklanır.
- Temasta: 3m/5m/15m RSI (RSI kart şartı sağlanıyor mu), ±5 dk içinde kart çıktı mı, fiyatın 3dk EMA21'e uzaklığı
- **Kısa pencereler:** 5 / 15 / 30 dk anındaki en derin çekilme, seviyeye göre en düşük ve kapanış da kaydedilir (`pb5/dn5/c5` …);
  `/seviye` raporunda "⏱ 5 / 15 / 30 / 60 dk: kırılmadı % · çekilme %" satırları.
- 60 dk'da: **çekilme** (o ana kadarki en yüksekten en derin geri çekilme, %) · **EMA21'e dönüş** (1m mum 3dk EMA21'e
  indi mi, kaç dk sonra) · **kırdı** (5dk kapanış seviyenin %`dipAbovePct` üstünde; EMA21'e döndükten sonra mı) ·
  **üstte kaldı** (60. dk kapanışı seviyenin üstünde)
- **Nerede durdu:** ret yiyen (seviyeyi kıramadan geri çekilen) temasta en derin çekilmenin dibi, o andaki hareketli
  ortalamalarla kıyaslanır — 3dk / 5dk / 15dk EMA21 (grafikte görünen, canlı mum dahil).
  Dip bir ortalamanın ±%0.5'inde durduysa o ortalama (ör. "5dk EMA21"); birini %0.5'ten fazla delip alttakine inmediyse
  "5dk–15dk EMA21 arası"; 15dk EMA21'i de deldiyse "15dk EMA21 altı"; hiçbirine inmediyse "ortalamaya inmedi".
- **Seviye gücü:** her temasta seviyenin daha önce kaç kez test edildiği (`lvTouches`); `/seviye` raporunda "💪 Seviye gücüne
  göre" (4+ kez / 1–3 kez / ilk kez: ret %, çekilme, kırıp kalan), `/kacan`'da "Tepki seviyesinin gücü".
- `/seviye [gün] [ad]` — telefona göre kısa satırlar: 🔥 **Pompa (RSI 85+)**: temas · ret / kırdı (hangisi önce) ·
  ret çekilmesi · dibe kaç dk · 🛑 **ret sonrası nerede durdu** dağılımı · kırıp üstte kalan; 💤 RSI şartı yokken kısa
  özet; 📊 seviyelere göre (pompa, 5+ örnekli seviyeler; azı tek satırda); tanımlar en altta açılır blokta.
  Ör. `/seviye 7 fib`, `/seviye 14 bölge`. Kazanç/kayıp değildir. Backtest aynı tabloyu geçmiş veriden hemen verir (aşağıda).

### Tepe defteri (/kacan, /teyit) ve veri dışa aktarma (/disaaktar)
Kart çıksın çıkmasın, **pompadaki her tepe adayı** kaydedilir — "o an her şey nasıldı, sonra düştü mü?" Amaç: short teyidi
için hangi durumların düşüşe eşlik ettiğini veriden bulmak.
- **Tepe adayı:** 1 dk mumun tepesi son 60 dk'nın en yükseği ve son 4 saatin dibinden ≥ %3 yukarıda. O dakikada tüm
  göstergelerin fotoğrafı alınır.
- **Sonuç (15 dk içinde, hangisi önce):** **düştü** (tepenin %1.5 altı) · **devam** (daha yüksek tepe → o mum yeni aday) ·
  **yatay** (ikisi de değil). Düştü ve yatay hep kaydedilir; devam en fazla 5 dk'da bir (`sampleGapMin`) — pompa boyunca örnek.
- Ek sonuç alanları: `upBeforeDrop` (düşmeden önce tepenin ne kadar üstüne çıktı), `t1/t2/t3` (−%1 / −%2 / −%3'e kaç dk),
  **5dk teyit mumu** (tepeden sonraki ilk tam 5dk mum: kırmızı mı, yutan ayı mı, önceki dibi kırdı mı, sonraki 60 dk dibi).
- **Kartlı / kartsız:** o coinde tepeden 15 dk önce ile düşüşten 5 dk sonrası arasında kart çıktı mı.
- **Tepe fotoğrafı (214 sütun):**
  - **1m / 3m / 5m / 15m / 1h / 4h** her biri için: RSI, EMA21'e uzaklık %, MACD (kesişim / zayıf / güçlü) ve histogram,
    Stoch RSI K/D, ATR %, son mumun hacim katı, taker alış %
  - **VWAP:** günlük / haftalık / aylık (UTC gün, Pazartesi, ay başı) % ve σ (±1/2/3σ bantları seviye olarak),
    kayan 90 dk / 24 saat / 7 gün, pompa dibinden sabitlenmiş VWAP
  - **Tepki seviyesi:** (+ `pkLvTouches`: o seviyenin önceki ~100 günde kaç kez test edildiği) tepenin %0.3 içindeki en yakın seviye (Fib, günlük/haftalık bölge, trend çizgisi, 7/30g en yüksek,
    MA200/EMA200, 1s/4s/15dk tepe, VWAP ve bantları, EMA21 3/5/15dk/1s) + %0.5 içindeki tüm seviyeler
  - Kart şartları (`fails`), kontrol listesi, en yakın direnç, negatif tepe, hacim pencereleri, funding, BTC 1s, pompa büyüklüğü/süresi
  - **CVD / alış:** 15 ve 60 dk net taker alış ($), fiyat yükselirken CVD düşüyor mu (`cvdDiv`), alış payı değişimi
  - **Mum yapısı:** 1m/5m/15m üst fitil, kapanış konumu (CLV), gövde; art arda yeşil mum sayısı
  - **Hacim / hız:** 15 dk hacim eğilimi, tepe mumunun hacim katı, 5m/15m/1h negatif tepe, son 15 dk hızı / önceki 15 dk, ivme, pompa ATR cinsinden
  - **Bollinger** %B ve genişlik (5m / 15m / 1h)
  - **Piyasa:** coinlerin yüzde kaçında 15m RSI ≥ 80, kaç coin pompada, BTC 5/15 dk ve 15m RSI
  - **Zaman:** TSİ saat, haftanın günü, seans (Asya/Avrupa/ABD/Gece), funding'e kalan dk
  - **Coin / trend:** listelenme yaşı, ATH'ye uzaklık, 30 gün dibinden yükseliş, günlük değişim ve gün içi konum,
    1h/4h trend ve EMA200, Ichimoku bulutuna göre konum
  - **Coin geçmişi (24 saat):** aday sayısı, düşüş sayısı, kart sayısı, son sonuç, son düşüşten beri dk
  - **Binance ek verisi** (tepe anına hizalı): açık pozisyon 15/60 dk değişim ve $ · en büyük trader'lar long/short (hesap ve
    pozisyon) · tüm hesaplar long/short · taker alış/satış oranı · **emir defteri** (tepe anında, %1/%2 içi alış payı) ·
    **spot** prim ve spot hacim payı · **baz** (mark − endeks) · **likidasyon** (15/60 dk short/long $, tüm piyasa akışından).
    REST kuyruğu doluysa atlanır (kartlar öncelikli); kartı etkilemez.
- **Dip:** tepeden sonraki 60 dk'nın en düşüğü — kaç % / kaç dk, %0.3 içindeki en yakın destek (aynı seviye listesi) ve
  3/5/15dk EMA21 merdiveninde nereye indiği; 55. dk'dan sonraysa "hâlâ düşüyor".
- **Sonrası:** tepeye göre 5 / 15 / 30 / 60 / 240 dk en düşük / en yüksek / kapanış (%).
- Kartı ve tetik kurallarını etkilemez. `/data/cards.db` → `events` tablosu (haftalık raporla temizlenir). Eşikler `src/config.js` → `events`.

`/kacan [gün]` — yalnız **düştü** sonuçlu adaylar: kartlı/kartsız sayısı, kartsızlarda eksik şart dağılımı ("RSI 85+ yok %62 ·
direnç yok %20 · şart vardı, kart çıkmadı %18"), kartsızların tepe RSI'ı, kartlı/kartsız karşılaştırma, tepeden sonraki düşüş.
Başlıkta tüm adayların dağılımı (düştü / devam / yatay). Tanımlar açılır blokta.

`/teyit [gün]` — **tüm** adaylar üzerinde ~38 koşul (üst fitil, CVD ayrışması, Bollinger dışı, açık pozisyon artışı, short
likidasyonu, funding, spot prim, piyasa geneli …): o koşul **varken / yokken** adayların yüzde kaçı düştü, farka göre sıralı
(📈 varken daha sık düşüyor · 📉 varken daha az — devam riski) + 5dk teyit mumu oranları. Her koşul en az 5 örnekle;
ilk günlerde az örnek olur, backtest hemen geçmiş veriden verir.

`/disaaktar [gün]` (yönetici) — tek **zip** **özelden** gelir (önce bota özelden bir kez /start yaz); içinde 4 CSV:
`tepeler.csv` (tüm tepe adayları + `outcome`, tüm göstergeler), `kartlar.csv` (kartlar + kart anı göstergeleri + 5/15/30/60/240 dk sonrası),
`temaslar.csv` (seviye tepkisi), `akis.csv` (alım-satım akışı pencereleri + 🐋 büyük işlem sayıları; akış kapalıysa yok). UTF-8, virgülle ayrılmış, ondalık nokta → Google Sheets / Excel / Python (pandas).
Zip 40 MB'ı aşarsa (Telegram sınırı 50 MB) kalan satırlar `…-2.zip`'e geçer (`tepeler-2.csv`).
Komut satırından: `fly ssh console` → `cd /app && node src/exportData.js --days 30` → `/data/export/veri.zip`,
bilgisayara: `fly ssh sftp get /data/export/veri.zip`.

**Bellek:** tepe adayları haftada on binlerce satır (214 sütun) olabilir. `/kacan`, `/teyit`, `/disaaktar`, `/haftalik` ve
haftalık rapor veritabanını **parça parça** okur (100 satır, araya olay döngüsü molası): CSV satırı doğrudan zip'e sıkıştırılır,
özetler sayaçlarla hesaplanır, `/kacan` yalnız "düştü"leri rapor alanlarıyla tutar. Bu raporlardan aynı anda yalnız biri çalışır. Backtest de aynı defteri hesaplar
(`backtest-results/tepeler-*.csv`, gruba rapor + teyit tablosu).

Kartlar, ⚡ uyarılar, bot mesajları ve backtest raporları grubun **ayrı konularına** gönderilebilir.
1. Grup ayarları → **Konular**'ı aç (grup süpergrup olmalı; ID çoğunlukla değişmez). Yeni bir grup kullanacaksan
   botu ekle, gruba bir komut yaz ve `fly logs`'ta `Tanımsız sohbetten mesaj yok sayıldı: … ID -100…` satırındaki
   ID'yi `fly secrets set TELEGRAM_CHAT_ID=-100…` ile tanımla.
2. İstediğin konunun **içinde** (yönetici olarak) yaz: `/konu kart` · `/konu sistem` ·
   `/konu kart3` (🔴🔴🔴'ler ayrı konuya) · `/konu backtest` · `/konu rapor` (haftalık dosyalar) · `/konu tepe` (🔻 tepe reddi). Bağlantı `/data`'da saklanır.
3. `/konu` listeyi gösterir, `/konu sil kart` kaldırır. Bağlanmamış tür genel akışa gider; konu silinirse mesajlar
   kaybolmaz, genel akışa düşer. Komut yanıtları, komutun yazıldığı konuya gelir.

### 🌊 Alım-satım akışı (/akis)
Kartı etkilemez; yalnız `/akis` komutu, panel (Raporlar → Alım-satım akışı, `/api/flow`) ve `/disaaktar` (`akis.csv`).
Botun hacim filtresinden (3M $) **bağımsız**: spotta USDT paritesi olan tüm USDT perpetual'lar (`1000PEPEUSDT` ↔ `PEPEUSDT` gibi eşleşmeyle; stabil coinler hariç, liste saatte bir yenilenir). Her parite için **spot ve futures** taker alış/satış dengesi **1s / 4s / günlük / haftalık / aylık** kapanmış pencerelerde
`/data/flow.db`'ye yazılır (`src/spotFlow.js`). Kaynak Binance klines: toplam quote hacmi ve taker alış hacmi
(satış = toplam − alış); 1m mum biriktirilmez. İlk açılışta (mum tohumlamasından sonra) coin başına geçmiş yüklenir
(1s 168 · 4s 120 · günlük 60 · haftalık 30 · aylık 12 pencere), sonra her pencere kapanışından ~90 sn sonra güncellenir. 1s satırları 30, 4s satırları 180 gün tutulur.

Etiket son `flowK` (6) pencerede fiyat değişimi ile CVD'nin (net akış / hacim %) birlikte okunmasıdır:

| Fiyat \ CVD | artıyor (≥ +%3) | yatay | düşüyor (≤ −%3) |
|---|---|---|---|
| yukarı (≥ +%2) | 📈 Trend teyitli (alım) | ⚪ Nötr | 🔴 Dağıtım |
| yatay | 🟢 Toplanıyor | ⚪ Nötr | 🔴 Dağıtım |
| aşağı (≤ −%2) | 🟢 Toplanıyor | ⚪ Nötr | 📉 Trend teyitli (satış) |

Son pencerenin hacmi önceki pencerelerin ortalamasının ≥ 1.5 katıysa "güçlü", 0.7'den azsa "zayıf hacim"; spot ve futures
CVD'si ters yöndeyse "⚠️ spot/futures ayrışması". Etiket değişince (ör. günlük Nötr → Toplanıyor) kayda geçer:
`/akis` (argümansız) son 24 saatin değişikliklerini, `/akis ETH` coinin 5 penceresini ve son değişikliklerini gösterir
(ayrı bildirim gönderilmez). Eşikler `/ayarlar → 🌊 Akış`: `flowK`, `flowCvdPct`, `flowPricePct`, `flowStrongX`, `flowWeakX`,
`flowBuyPct`, `flowSellPct`. Kapatmak için `SPOT_FLOW=0`.

**🐋 Büyük alım / satım** (`src/bigTrades.js`): aynı evrendeki spot paritelerin işlem akışı (`<sembol>@aggTrade`, tek WebSocket)
dinlenir; tek market emri coinin eşiğini geçerse alış ya da satış olarak sayılır. Eşik coine göre:
`max(flowBigMinUsd, son günlük spot hacmi × flowBigPct %)` — varsayılan %0,05 ve en az 5K $ (10M $ hacim → 5K $, 100M $ → 50K $,
1B $ → 500K $). Sayaçlar saat başına `flow_big` tablosuna yazılır; `/akis`, panel ve `akis.csv` pencere toplamlarını gösterir.
Binance geçmiş büyük işlem listesi vermediği için sayım botun açılışından başlar. Kapatmak için `BIG_TRADES=0`.

**Panel → Alım-Satım Akışı sekmesi:** tüm pariteler tek tabloda (günlük hacim, alış-satış %, değişim %, 1s/4s/günlük/haftalık/aylık
etiket, bugünkü 🐋 alım/satım), coin arama ve günlük etiket filtresi; satıra tıklayınca pencere ayrıntısı (spot + futures) ve spot 4s
geçmişi, yanda son 7 günün etiket güncellemeleri. Taker alış "piyasa emriyle alan" demektir; etiket yorumdur, mal toplamanın kanıtı değildir.

### Telegram komutları
| Komut | Kim | |
|---|---|---|
| `/ayarlar` | herkes görür, yöneticiler değiştirir | ana sayfa: bölümler + özet değerler (RSI kartı · Direnç · Derece · Hacimli mum · ⚡ Hareket · 🔻 Tepe reddi · Bildirim · Grafik · 🌊 Akış · İzlenen coinler) → bölüm: her ayar bir buton (aç-kapa ayarları tek dokunuşla) → sayısal ayar: kendi sayfasında −5/−1/+1/+5 adım ve ↺ Varsayılan |
| `/ayar anahtar değer` · `/ayar sifirla` | yönetici | ör. `/ayar rsiMin 95`, `/ayar levelMaxPct 2` |
| `/coin ETH` | herkes | coinin anlık durumu (şart aranmadan) |
| `/sustur ETH [dk]` · `/ac ETH` · `/sessiz` | yönetici / herkes | susturma |
| `/takip [ETH]` | liste herkes, ekle-çıkar yönetici | takipteki coinlerin kartları her zaman sesli |
| `/gecmis ETH [adet]` · `/istatistik [gün]` | herkes | kart geçmişi ve sınıf istatistiği |
| `/akis [ETH]` | herkes | spot/futures alım-satım akışı (1s/4s/günlük/haftalık/aylık) ve Toplanıyor/Dağıtım etiketi; argümansız: son etiket değişiklikleri |
| `/kacan [gün]` | herkes | tepe defteri: pompa tepesinden düşüşler, kartlı/kartsız, kartsızlarda eksik şart |
| `/teyit [gün]` | herkes | short teyidi: hangi koşul varken tepe adayları daha sık düştü (varken / yokken) |
| `/disaaktar [gün]` | yönetici | istatistik verisi CSV olarak özelden (tepeler, kartlar, temaslar, akış) |
| `/haftalik` | yönetici | haftalık dosyaların (MD + zip) ön izlemesi özelden (silmez); asıl dosyalar Pazartesi 03:01'de gruba gider |
| `/seviye [gün] [ad]` | herkes | seviye tepkisi: temastan sonra çekilme / 3dk EMA21'e dönüş / kırılım (ör. `/seviye 7 fib`) |
| `/konu [ad]` · `/konu sil ad` | liste herkes, bağlama yönetici | konulu grupta yönlendirme |
| `/durum` · `/benkimim` · `/yardim` | herkes | `/durum`: izlenen/hazır coin, **geride kalan coinler** (son 3 dk'da 1m mumu gelmeyen), son 5 dk'da işlenen mum sayısı, **gecikme** (mum kapanışı → bot işledi; ort / en fazla, Binance ve yerel kısım ayrı) ve işlem yükü. Heartbeat ayrıca CPU %, steal % (paylaşımlı CPU kotası) ve event loop gecikmesini yazar. Gecikme 20 sn'yi aşarsa ya da geride coin varsa `fly logs`'ta `[UYARI]` |

Yönetici: `TELEGRAM_ADMIN_IDS` (virgüllü kullanıcı ID'leri; `/benkimim` ile öğrenilir) tanımlıysa o liste,
değilse **grubun yöneticileri**. Ayarlar `/data/info-settings.json`'a yazılır → deploy sonrası korunur.
Varsayılanlar `src/config.js` → `info` bölümünde.

**🌐 Hisse / emtia (kripto dışı) — `tradfi`, varsayılan kapalı.** Binance'in kripto dışı vadelileri (hisse, ETF,
altın/gümüş, döviz; exchangeInfo'da `contractType: TRADIFI_PERPETUAL`) yalnız bu ayar açıkken evrene girer
(24s hacim şartı onlara da uygulanır). `/ayarlar → 🌐 İzlenen coinler → Hisse/emtia` ya da `/ayar tradfi aç` / `kapat`;
değişiklik beklemeden uygulanır (kapatınca abonelikleri bırakılır). Kendi piyasası kapalıyken mum gelmeyebileceği için
bu semboller `/durum`'daki "geride" uyarısına sayılmaz; `/durum` açıkken kaç tanesinin izlendiğini gösterir.

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
├── cardStore.js      # Kart geçmişi (SQLite /data/cards.db) + 5/15/30/60/240 dk takip + seviye tepkisi tablosu
├── peakAlert.js      # 🔻 Tepe reddi: skor (mum reddi · kırmızı · hacim · seans) + ayrı bildirim metni
├── eventLog.js       # Tepe defteri: pompa tepe adayı → düştü/devam/yatay, kartlı/kartsız, /kacan, /teyit (canlı + backtest ortak)
├── peakFeatures.js   # Tepe adayı ek özellikleri: CVD, mum yapısı, Bollinger, hız, piyasa, zaman, coin geçmişi
├── marketData.js     # Binance ek verisi: açık pozisyon, long/short, emir defteri, spot, baz, likidasyon akışı
├── spotFlow.js       # Spot/futures alım-satım akışı (1s/4s/günlük/haftalık/aylık) → flow.db, Toplanıyor/Dağıtım etiketi, /akis
├── bigTrades.js      # Spot büyük alım/satım sayacı (aggTrade akışı, coin başına eşik) → flow.db
├── exportData.js     # CSV dışa aktarma (/disaaktar ve komut satırı)
├── marketSnap.js     # 1m–4h göstergeleri, VWAP seti, tepki/destek seviyesi eşleştirme (istatistik kaydı)
├── weeklyReport.js   # Haftalık MD + zip (CSV'ler; Pazartesi 03:01 TSİ) → gruba, sonra veritabanından silme
├── zipWriter.js      # Küçük ZIP yazıcı (zlib): büyük CSV'ler satır satır sıkıştırılır, 40 MB'da bölünür
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
test/
├── run.js            # Tüm testleri sırayla çalıştırır (npm test)
├── gen.js            # Sentetik mum üreteci
├── mockinfo.js       # Sahte Binance REST/WS + sahte Telegram sunucusu
└── test-*.js         # 17 test
```

## Testler
`npm test` — 17 test dosyası (`test/`), ağ gerekmez: Binance REST/WS ve Telegram sahte sunucularla taklit edilir.
Kart şartları, seviyeler, hacim sayacı, grafik, seviye tepkisi, tepe defteri, haftalık rapor, uçtan uca bot ve backtest denenir.
Yalnız bazıları: `node test/run.js drops weekly`. Geçici dosyalar ve loglar `test/.tmp/`'ye yazılır (git'e girmez).
Docker imajına girmez (Dockerfile yalnız `src/`'yi kopyalar).

## Kurulum (yerel)

```bash
npm install
cp .env.example .env   # düzenle
npm start
```

## Canlı Web Paneli & Multi-Bot Hub (Port 3000)

Scalp botu, hem kendi sinyallerini canlı izleyebileceğiniz hem de **farklı repolardaki diğer Telegram botlarınızı** tek çatı altında toplayabileceğiniz Bloomberg/Linear tarzı kurumsal bir web terminali içerir (`src/server.js`).

```bash
# Paneli başlat (veya npm run dev)
npm start
```
Tarayıcınızdan `http://localhost:3000` adresine giderek:
* **Bot Merkezi (Multi-Bot Hub):** Tüm Telegram botlarınızın durumunu, son nabızlarını ve sinyallerini canlı izleyin.
* **Sinyal Akışı:** Canlı RSI değerleri, EMA21 ayrışması ve seviye kartları.
* **Direnç & Temas Kayıtları:** SQLite veritabanındaki seviye tepkileri tablosu.
* **Motor Ayarları (salt okunur):** Çalışan motorun güncel ayarlarının tamamı. Panel yalnızca yansıtma ekranıdır; ayarlar Telegram komutlarıyla değiştirilir, panelden hiçbir yazma işlemi yapılamaz (`/api/*` yazma istekleri 405 döner).
* **Hata & Olay Günlüğü:** Sistem hataları, WebSocket kopuklukları ve Telegram hız sınırlarını anlık log akışından filtreleme.

---

## Deploy Sonrası Web Panelini Telegram'dan Adminlere Gönderme

Bot deploy edildikten veya yeniden başlatıldıktan sonra web panelinin adresini Telegram grubuna ve tüm yöneticilere otomatik olarak iletir:

1. **Otomatik Deploy Bildirimi (Deploy-time Notification):**
   * Bot açılışında çalıştığı platformu ve URL'yi otomatik tespit eder:
     * **Fly.io:** `FLY_APP_NAME` üzerinden `https://<app>.fly.dev` adresini otomatik çözer.
     * **Özel Alan Adı:** `WEB_PANEL_URL` veya `APP_URL` tanımlıysa doğrudan onu kullanır.
     * **Render / Railway / Diğer:** İlgili platform ortam değişkenlerini destekler.
   * Gruba butonlu **"🚀 Scalp Terminal & Web Paneli Devrede!"** duyurusu iletilir.
   * Gruptaki tüm yetkili yöneticiler Telegram API (`getChatAdministrators`) ile otomatik bulunur; ayrıca `TELEGRAM_ADMIN_IDS` ile tanımlanan kullanıcılara özel mesajla (DM) doğrudan butonlu bildirim iletilir.

2. **Telegram Komutları (`/panel` ve `/panel gonder`):**
   * `/panel` veya `/web`: Bot anlık olarak panel adresini ve **"🌐 Web Panelini Aç"** butonunu döner.
   * `/panel gonder` (veya `/panelligonder`): Yöneticiler bu komutu yazdığında panel linki gruba ve tüm adminlere anında yeniden duyurulur.

3. **Fly.io 7/24 Kesintisiz Çalışma Yapılandırması:**
   * `fly.toml` dosyasında `[http_service]` aktif edilmiştir.
   * `auto_stop_machines = false` yapılandırması sayesinde web trafiği olmasa dahi makine uyutulmaz; Binance WebSocket ve Telegram botu kesintisiz 7/24 çalışmaya devam eder.

---

## Harici Telegram Botlarınızı Bu Panele Bağlama

Diğer GitHub depolarınızda veya bağımsız sunucularda çalışan botlarınıza küçük bir heartbeat (nabız) ekleyerek bu panelde görünmelerini sağlayabilirsiniz. Uç nokta yetki ister: sunucuda en az 16 karakterlik `EXTERNAL_BOT_KEY` tanımlayın ve isteğe `X-Bot-Key` başlığıyla ekleyin (anahtar yalnızca nabız gönderebilir, panel verisini okuyamaz):

```python
# Python Botu Örneği
import requests

def report_to_hub(error_msg=None):
    requests.post("https://<PANEL_ADRESI>/api/external-bots/heartbeat", headers={"X-Bot-Key": "<EXTERNAL_BOT_KEY>"}, json={
        "id": "trend-bot-1",
        "name": "BTC Trend Botu",
        "telegram": "@BtcTrendBot",
        "status": "error" if error_msg else "online",
        "error": error_msg,
        "lastSignal": "BTC LONG @ 64,200",
        "metrics": { "Açık Pozisyon": "2", "Kâr": "+%4.2" }
    }, timeout=5)
```

---

## Güvenilirlik & Dayanıklılık İyileştirmeleri (v2.5)

* **Kontrollü Kapanış:** `uncaughtException` veya `unhandledRejection` durumunda bağlantılar güvenle kapatılır ve süreç `exit(1)` ile yeniden başlatılır.
* **Telegram Kuyruk Koruması:** `TELEGRAM_MAX_QUEUE_LEN` (250) sınırı ve 20-30 dk üzeri bayat scalp sinyalleri için TTL temizliği (`droppedExpired`) ile OOM bellek patlamaları önlenir. Kullanıcı komut yanıtları önceliklidir (`kind: 'reply'`).
* **Mükerrer Mum Koruması:** WebSocket kopması sonrasında REST tamamlama (`backfillGap`) sırasında son işlenen mum zaman damgası (`lastT`) kontrol edilerek çift sinyal üretimi kesin olarak engellenir.
* **Deterministik Docker Derlemesi:** `package-lock.json` ile `COPY package*.json ./` ve `npm ci` kullanılır.
* **Panel API Güvenliği:** Tüm `/api/*` uçları Telegram OTP oturumu ister; kullanıcının grupta hâlâ yönetici olduğu 5 dakikada bir canlı doğrulanır (çıkarılan yöneticinin oturumu iptal edilir), panel salt okunurdur, farklı kaynaktan gelen yazma istekleri (CSRF) reddedilir, URL'deki `?token=` yalnızca panel açılışında kabul edilir. Harici bot alanları tür/uzunluk sınırıyla saklanır ve panelde HTML kaçışıyla gösterilir.
* **Sert Kuyruk Sınırı:** Telegram 429 sonrası yeniden deneme de `TELEGRAM_MAX_QUEUE_LEN` sınırını aşamaz.
* **Kontrollü Backfill:** Tohumlama (`SEED_CONCURRENCY`, varsayılan 4) ve boşluk doldurma (`GAP_FILL_CONCURRENCY`, varsayılan 8, en fazla 16) sınırlı paralellikle, REST weight bütçesi (`BINANCE_REST_WEIGHT_PER_MIN`) içinde çalışır. Her coin için doldurma sonrası eksik 1m mum ve son mum yaşı kontrol edilir; delik ya da eski veri kalırsa coin sinyalleri durdurulup kurtarma kuyruğuna alınır.
* **Otomatik Test Paketi:** 26 adet kapsamlı test (`npm test`) ve GitHub Actions CI iş akışı (`.github/workflows/test.yml`).

---

## Fly.io'ya Deploy

Fly.io'da hem arka plan scalp motoru hem de web paneli tek makinede çalıştırılabilir:

```bash
# 1. flyctl kur
curl -L https://fly.io/install.sh | sh

# 2. Giriş yap
fly auth login

# 3. fly.toml'daki app adını değiştir
#    "scalp-bot-vip" → "scalp-bot-senin-adin"

# 4. Uygulamayı oluştur
fly apps create scalp-bot-senin-adin

# 5. Kalıcı disk oluştur
fly volumes create scalp_data --region fra --size 1

# 6. Secrets tanımla
fly secrets set \
  BINANCE_API_KEY=xxx \
  BINANCE_API_SECRET=xxx \
  TELEGRAM_BOT_TOKEN=xxx \
  TELEGRAM_CHAT_ID=xxx \
  TELEGRAM_ADMIN_IDS=123456789

# 7. Deploy et
fly deploy
```

Deploy tamamlandığında Telegram botunuz gruba ve adminlere doğrudan canlı panel bağlantısını butonlu mesaj olarak gönderecektir!


## Web Yönetici Paneli Güvenliği

Web paneli bağlantısı Telegram'daki `/panel` komutuyla ve dağıtım bildirimi içindeki **🌐 Web Panelini Aç** butonuyla açılır. Panel/API erişimi tek kullanımlık Telegram doğrulama kodu ile açılan oturumla korunur.

Panel girişinde izin listesi elle tutmanız gerekmez: sunucu, `TELEGRAM_CHAT_ID` ile yapılandırılmış grup/kanalın yöneticilerini Telegram Bot API `getChatAdministrators` üzerinden güncel olarak alır. Kod yalnızca bu listedeki yöneticiye botun özel mesajı olarak gönderilir ve kod doğrulanırken yöneticilik tekrar kontrol edilir. Telegram yöneticileri önce botla özel sohbeti açıp `/start` göndermelidir; aksi durumda bot özel mesaj gönderemez. Bot, ilgili grup/kanalda yönetici olmalı ve `TELEGRAM_BOT_TOKEN` ile `TELEGRAM_CHAT_ID` doğru tanımlanmalıdır.

Kod 5 dakika geçerlidir, en fazla 5 doğrulama denemesi yapılabilir ve yeniden kod gönderimi yönetici başına 60 saniyede bir sınırlandırılır. Oturum çerezi HttpOnly, SameSite=Strict ve production ortamında Secure bayraklarıyla ayarlanır; oturum 8 saat sonra sona erer. Grup/kanal yöneticiliği Telegram üzerinden doğrulanamazsa giriş reddedilir.
