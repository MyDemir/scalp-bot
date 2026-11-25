'use strict';

/**
 * Haftalık istatistik dosyası — her Pazartesi 03:01 (TSİ) gruba gönderilir, sonra veritabanından silinir.
 *
 *   Dosya    : veri-<yıl>-H<hafta>.zip (tek belge) — haftalik-<yıl>-H<hafta>.md (okunur özet + olay listesi) · tepeler.csv (tüm tepe adayları) · kartlar.csv · temaslar.csv (Sheets / Excel / Python)
 *              Zip 40 MB'ı aşarsa (Telegram sınırı 50 MB) kalan satırlar veri-…-2.zip'e geçer.
 *   Bellek   : tepe adayları (haftada on binlerce, 214 sütun) ve seviye temasları (haftada ~50 bin) veritabanından PARÇA
 *              PARÇA okunur, CSV satırı doğrudan zip'e sıkıştırılır; özet sayaçlarla / yalnız özetin kullandığı alanlarla
 *              hesaplanır — hiçbir anda tüm hafta bellekte tutulmaz. (Temaslar önceden tümüyle okunup CSV için düz
 *              kopyası çıkarılıyordu: +300 MB heap → 2026-10-26 03:01'de 512 MB makinede heap taşması.)
 *   Kapsam   : rapor anından 5 saat öncesine kadarki TÜM kayıtlar (kartın 240 dk takibi ve düşüşün 240 dk sonrası
 *              dolmuş olsun diye; son 5 saat bir sonraki haftaya kalır). Önceki raporda gönderilemeyenler de girer.
 *   Silme    : dosyaların HEPSİ gruba gittikten sonra kapsamdaki kartlar, temaslar ve düşüşler silinir (VACUUM ile
 *              disk geri kazanılır). Gönderim başarısızsa hiçbir şey silinmez, 10 dk sonra tekrar denenir.
 *   Zaman    : son "Pazartesi 03:01 TSİ" geçmiş ve daha önce yapılmamışsa çalışır (bot o saatte kapalıysa açılınca).
 *              İlk kurulumda durum dosyası yoksa ilk rapor bir SONRAKİ Pazartesi'dir (deploy anında veri silinmez).
 *   Durum    : <veri klasörü>/weekly-state.json  { lastSlot }
 */

const fs = require('fs');
const path = require('path');
const { rowToStat, rowToTouch, PATH_COLS, pathRow } = require('./cardStore');
const { createSetupAcc } = require('./setupTable');
const { flatDrop, dropCols, dropText, teyitText, createTeyitAcc, slimDrop, csvLine, csvHeader } = require('./eventLog');
const { createZipSet } = require('./zipWriter');
const { touchText } = require('./infoStats');
const { flatten, cardRow, colsOf, cardColsOf } = require('./exportData');

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000, WEEK = 7 * DAY, MONDAY0 = 4 * DAY;
const TZ = process.env.DISPLAY_TZ || 'Europe/Istanbul';
const LAG_MS = 5 * HOUR;

/** Saat dilimi farkı (ms): yerel = UTC + off */
function tzOffset(t, tz = TZ) {
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(t)).map(x => [x.type, x.value]));
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(t / 1000) * 1000;
  } catch { return 3 * HOUR; }
}

/** En son geçmiş "Pazartesi 03:01" (yerel) anı — UTC ms */
function lastSlot(now = Date.now(), tz = TZ) {
  const off = tzOffset(now, tz);
  const L = now + off;
  let slot = Math.floor((L - MONDAY0) / WEEK) * WEEK + MONDAY0 + 3 * HOUR + MIN;
  if (L < slot) slot -= WEEK;
  return slot - off;
}

/** ISO hafta etiketi (yerel tarih): 2026-H41 */
function weekLabel(t, tz = TZ) {
  const L = new Date(t + tzOffset(t, tz));
  const d = new Date(Date.UTC(L.getUTCFullYear(), L.getUTCMonth(), L.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const wk = Math.ceil(((d - y0) / DAY + 1) / 7);
  return `${d.getUTCFullYear()}-H${String(wk).padStart(2, '0')}`;
}

const fmt = (t, tz = TZ) => { const L = new Date(t + tzOffset(t, tz)); return `${String(L.getUTCDate()).padStart(2, '0')}.${String(L.getUTCMonth() + 1).padStart(2, '0')} ${String(L.getUTCHours()).padStart(2, '0')}:${String(L.getUTCMinutes()).padStart(2, '0')}`; };
const plain = html => html.replace(/<blockquote expandable>/g, '\n').replace(/<\/blockquote>/g, '').replace(/<[^>]+>/g, '')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const pS = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d)}`);
const n0 = v => (v == null || !Number.isFinite(v) ? '—' : String(Math.round(v)));
const sg = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}σ`);

function dropLine(r) {
  const f = r.feat || {};
  const rsi = ['1m', '3m', '5m', '15m', '1h', '4h'].map(tf => n0(f[`rsi_${tf}`])).join('/');
  const pk = f.pkLv ? `${f.pkLv} (${pS(f.pkLvDist, 2)}${f.pkLvTouches != null ? ` · ${f.pkLvTouches} temas` : ''})` : 'seviye yok';
  const tr = f.trLv ? `${f.trLv}${f.trLvTouches != null ? ` (${f.trLvTouches} temas)` : ''}` : (f.trEma && f.trEma !== 'yok' ? f.trEma : 'destek yok');
  return `- ${fmt(r.t)} **${r.symbol}** tepe ${+(+r.price).toPrecision(6)} · pompa ${pS(f.pumpPct, 1)} (${n0(f.pumpMin)} dk) · RSI 1/3/5/15dk/1s/4s ${rsi}`
    + ` · tepki: ${pk} · VWAP gün ${sg(f.vwD_sig)} / hafta ${sg(f.vwW_sig)} / 90dk ${pS(f.vw90_pct)}`
    + ` · dip ${pS(f.trPct)} (${n0(f.trMin)} dk) ${tr}${f.trEma && f.trEma !== 'yok' && f.trLv ? ` · EMA21: ${f.trEma}` : ''}`
    + ` · ${r.card ? `kart ✅ (derece ${r.cardGrade ?? '—'})` : `kart ❌${f.fails ? ` eksik: ${f.fails.replace(/\|/g, ', ')}` : ' (şart vardı)'}`}`
    + ` · en düşük 5/15/30/60dk ${[5, 15, 30, 60].map(w => pS(r.out?.[w]?.low)).join(' / ')} · 240dk ${pS(r.out?.[240]?.low)}`;
}

function cardLine(r) {
  const rsi = r.rsi ? ['3m', '5m', '15m'].map(tf => n0(r.rsi[tf])).join('/') : '—';
  const lv = r.level ? `${r.level.name} ${pS(r.level.dist, 2)}${r.level.touches != null ? ` (${r.level.touches} temas)` : ''}` : 'seviye yok';
  const f60 = r.fwd?.[60];
  return `- ${fmt(r.t)} **${r.symbol}** #${r.seq ?? '—'} derece ${r.grade ?? '—'} · RSI 3/5/15dk ${rsi} · ${lv}`
    + `${r.sfp ? ` · sahte kırılım (${r.sfp.level})` : ''}${r.discovery ? ` · fiyat keşfi (${r.discovery.broken})` : ''}`
    + ` · 60dk en düşük ${pS(f60?.low)} / en yüksek ${pS(f60?.high)}${r.partial ? ' · (takip eksik)' : ''}`;
}

const MD_DROP_LINES = 300;          // MD'deki düşüş satırı sınırı (tamamı CSV'de)

/** Seviye tepkisi özetinin (infoStats.touchText / touchSum) okuduğu alanlar — temasın geri kalanı yalnız CSV'ye gider */
const TOUCH_TEXT_FIELDS = ['t', 'name', 'rsiOk', 'card', 'lvTouches', 'pb', 'pbMin', 'emaMin', 'brokeMin', 'brokeAfterEma', 'held', 'stop', 'falling', 'pb5', 'pb15', 'pb30'];
const slimTouch = r => { const o = {}; for (const k of TOUCH_TEXT_FIELDS) o[k] = r[k]; return o; };
// pb0 / belowMin en sona (time'dan sonra): mevcut kolonların sırası değişmez
const touchRow = r => { const { pb0, belowMin, ...q } = r; return flatten({ ...q, time: new Date(r.t).toISOString(), pb0, belowMin }); };
const TOUCH_COLS = Object.keys(touchRow(rowToTouch({ t: 0 })));

/**
 * @param {object} store  cardStore
 * @returns {Promise<{label, md, files:{name, buf, type}[], counts, cutoff, from}>}
 */
async function buildWeekly(store, { now = Date.now(), s = {}, E = {}, cutoff = now - LAG_MS, maxZipBytes = 40e6 } = {}) {
  const label = weekLabel(cutoff);
  const cards = store.since(0).filter(r => r.t < cutoff).map(rowToStat).filter(r => r.kind === 'card');
  const counts = { cards: cards.length, touches: 0, drops: 0, peaks: 0 };
  let from = cutoff;
  for (const r of cards) if (r.t < from) from = r.t;

  const zip = createZipSet(`veri-${label}`, { maxBytes: maxZipBytes });
  const cardRows = cards.map(r => cardRow(r, true));
  {
    const cols = cardColsOf(cardRows), e = zip.entry('kartlar.csv', csvHeader(cols));
    for (const r of cardRows) await e.write(csvLine(r, cols));
    await e.end();
  }

  // Seviye temasları: parça parça oku → CSV satırı zip'e; özet için yalnız gereken alanlar tutulur
  const touches = [];
  const tz = zip.entry('temaslar.csv', csvHeader(TOUCH_COLS));
  const onTouch = async r => {
    counts.touches++;
    if (r.t < from) from = r.t;
    touches.push(slimTouch(r));
    await tz.write(csvLine(touchRow(r), TOUCH_COLS));
  };
  if (store.forEachTouch) await store.forEachTouch({ until: cutoff }, onTouch);
  else if (store.touchesSince) for (const r of store.touchesSince(0)) if (r.t < cutoff) await onTouch(r);
  await tz.end();

  // Tepe adayları: parça parça oku → CSV satırı zip'e, teyit sayaçları, "düştü"ler sade biçimde (rapor alanları)
  const acc = createTeyitAcc();
  if (E.dropPct) acc.setDropPct(E.dropPct);
  const setup = createSetupAcc({ s });
  const drops = [];
  const dcols = dropCols(), te = zip.entry('tepeler.csv', csvHeader(dcols));
  if (store.forEachEvent) {
    await store.forEachEvent({ until: cutoff }, async r => {
      counts.peaks++;
      if (r.t < from) from = r.t;
      acc.add(r);
      setup.add(r);
      if ((r.outcome || 'düştü') === 'düştü') { counts.drops++; drops.push(slimDrop(r)); }
      await te.write(csvLine(flatDrop(r), dcols));
    });
  }
  await te.end();
  // Yollar (tepe sonrası 1m): kapsam diğerleri gibi t < cutoff
  if (store.forEachPath) {
    let pe = null;   // yol yoksa dosya açılmaz
    await store.forEachPath({ until: cutoff }, async r => {
      if (!pe) pe = zip.entry('yollar.csv', csvHeader(PATH_COLS));
      await pe.write(csvLine(pathRow(r), PATH_COLS));
    });
    if (pe) await pe.end();
  }
  drops.sort((a, b) => a.t - b.t);

  const grade = g => cards.filter(c => c.grade === g).length;
  const gradeOld = g => cards.filter(c => c.gradeOld === g).length;
  const oldN = cards.filter(c => c.gradeOld != null).length;
  const snapCards = cards.filter(c => c.snapOk != null);   // alanı olmayan eski kartlar sayılmaz
  const byp = snapCards.filter(c => c.filterBypass === 1);
  const bypBy = k => byp.filter(c => c.bypassBy === k).length;
  const bypFull = byp.filter(c => c.fwd?.[60]?.close != null && c.fwd[60].full !== false);
  const bypDown = bypFull.filter(c => c.fwd[60].close < 0).length;
  const bypLine = snapCards.length ? `Filtre dışı kart: ${byp.length} (SFP ${bypBy('sfp')} · patlama ${bypBy('burst')} · hareket ${bypBy('move')}); 60 dk sonra aşağı ${bypFull.length ? '%' + (bypDown / bypFull.length * 100).toFixed(0) : '—'} (${bypFull.length}); kayıtlı ${snapCards.length} kart` : null;
  const oc = { düştü: counts.drops, devam: acc.oc('devam'), yatay: acc.oc('yatay') };
  const md = [
    `# Haftalık istatistik — ${label}`,
    '',
    `Kapsam: ${fmt(from)} → ${fmt(cutoff)} (TSİ) · ${counts.cards} kart · ${counts.peaks} tepe adayı (${counts.drops} düştü) · ${counts.touches} seviye teması`,
    '',
    'Bu dosya botun kaydettiği olayların dökümüdür; kazanç/kayıp hesabı yoktur, "eşlik eden durum"dur. Sayısal analiz için bu zip içindeki CSV dosyalarını kullan.',
    '',
    '## Kartlar',
    `Derece: 🔴 ${grade(1)} · 🔴🔴 ${grade(2)} · 🔴🔴🔴 ${grade(3)} · 🔴🔴🔴🔴 ${grade(4)}`,
    oldN ? `Eski derece (MACD 5m, Stoch 5m ve 3dk RSI şartsız, gradeOld; ${oldN} kart): 🔴 ${gradeOld(1)} · 🔴🔴 ${gradeOld(2)} · 🔴🔴🔴 ${gradeOld(3)} · 🔴🔴🔴🔴 ${gradeOld(4)}` : null,
    bypLine,
    '',
    '## Düşüş defteri (özet)',
    '```',
    plain(dropText(drops, { title: `${counts.drops} düşüş`, s, E, counts: oc })),
    '```',
    '',
    '## Teyit adayları (tüm tepe adayları: düştü / devam / yatay)',
    '```',
    plain(teyitText(acc, { title: `${counts.peaks} tepe adayı`, E })),
    '```',
    '',
    '## Kurulum tablosu (pompa başına ilk aday, giriş 1dk kapanış)',
    setup.text(),
    '',
    '## Seviye tepkisi (özet)',
    '```',
    plain(touchText(touches, { title: `${counts.touches} temas`, s })),
    '```',
    '',
    `## Düşüşler (${counts.drops})`,
    'Her satır: tepe zamanı · coin · tepe fiyatı · pompa (4 saatlik dipten) · tepe anında RSI 1/3/5/15dk/1s/4s · tepkinin geldiği seviye (tepenin %0.3 içi) · tepede VWAP (σ) · tepeden sonraki 60 dk\'nın dibi ve orada en yakın destek · kart durumu · tepeye göre 5/15/30/60/240 dk en düşük',
    '',
    ...drops.slice(0, MD_DROP_LINES).map(dropLine),
    ...(drops.length > MD_DROP_LINES ? [`- … ve ${drops.length - MD_DROP_LINES} düşüş daha — tamamı tepeler.csv'de (outcome = düştü)`] : []),
    '',
    `## Kartlar (${counts.cards})`,
    ...cards.map(cardLine),
    '',
    '## Sütunlar (CSV)',
    '- tepeler.csv: her satır bir pompa tepe adayı; outcome = düştü / devam / yatay (CSV\'de süzerek düşüşleri ayır); tepe high\'ından ölçülür, ilk eşik; contPct 0 olduğundan \'devam\' = sonraki mumda herhangi bir yeni high, tepenin ayakta kaldığı anlamına gelmez',
    '- Ek: cvd*, wick_/clv_/body_<tf> (mum yapısı), greens_*, volTrend15, volPeakX, neg5/neg15/neg1h, bbB_/bbW_<tf> (Bollinger), spd15/accel/pumpAtr (hız), breadth80/pumping/btc5/btc15/btcRsi15 (piyasa), hourTR/dow/session/minToFunding (zaman), ageDays/athDist/fromLow30, dayChg/dayPos, trend_/ema200_<1h|4h>, ichiPos/ichiDist, samples24h/drops24h/cards24h/lastOutcome/minsSinceDrop (coin geçmişi)',
    '- Binance: basisPct (mark−endeks), liqShort*/liqLong* (likidasyon USDT, liqShortPct15 = 15 dk hacmine oran), oiChg15/oiChg60/oiUsd (açık pozisyon), lsTopAcc/lsTopPos/lsGlobal/takerLS (long/short), obBid1/obBid2 (emir defteri alış payı), spotPrem/spotShare60 (spot)',
    '- Sonuç: outcome, upBeforeDrop (düşmeden önce en fazla yükseliş %), t1/t2/t3 (−%1/−%2/−%3\'e dk), c5Red/c5Engulf/c5BelowPrev/c5ClosePct/c5Next60Low (ilk tam 5dk teyit mumu)',
    '- rsi_<tf> · ema21_<tf> (EMA21\'e uzaklık %) · macd_<tf> (down/up/zayıf/güçlü) · hist_<tf> (% fiyat) · stk_/std_<tf> (Stoch RSI) · atr_<tf> (%) · volx_<tf> (son mum hacmi / önceki 20 ortalama) · buy_<tf> (taker alış %) — tf: 1m 3m 5m 15m 1h 4h',
    '- VWAP: vwD/vwW/vwM_pct ve _sig (günlük/haftalık/aylık; % ve σ), vw90_pct/_sig (kayan 90 dk), vw24h_pct, vw7d_pct, avwLow_pct (pompa dibinden sabitlenmiş)',
    '- Tepe: pkLv / pkLvKind / pkLvDist / pkLvTouches (tepki seviyesi ve önceki ~100 günde kaç kez test edildiği), pkNear (%0.5 içindeki tüm seviyeler) · Dip: trPct, trMin, trLv, trLvDist, trLvTouches, trNear, trEma (3/5/15dk EMA21 merdiveni), trFalling',
    '- yollar.csv: her tepe adayının sonraki 15 dk 1m yolu; entry = tepe anı 1dk kapanışı, h/l/c<k> = k. dakikanın en yüksek/en düşük/kapanış değişimi (% , entry\'ye göre), n = kaydedilen dakika (<15 ise eksik). t < cutoff kapsamındaki adaylar; haftalık rapordan sonra diğer kayıtlarla silinir (en fazla 60 gün)',
    '- temaslar.csv: lvTouches = seviyenin önceki ~100 günde (4s mumlar) kaç ayrı kez test edildiği · kartlar.csv: level_touches',
    '- tepeler.csv doğruluk sütunları (sonda): sameBar, cardWhen, contSkipped, rsi15c/rsi1hc/rsi4hc/rsi3c/rsi5c (kapanmış mumlu RSI), sep3c/sep5c, cfg* (kayıt anı ayarı; cfgVer = package.json sürümü; dataVer = el ile artırılan kayıt/derece sürümü), wick_/clv_ 5mc/15mc, bar5Pct/bar15Pct, volPeakXc (tepe 1dk hacmi / pompa süresindeki mumların ortalaması; payda gerçek mum sayısı), miss60, futQ60t/spotQ60/spotShare60t, dropC15/lowC15/closeC60 (girişe göre), atr2C15 (en sonda; 1: giriş kapanışından 15 dk içinde 2×ATR(5m)% kadar düştü, 0: düşmedi, boş: lowC15 ya da atr5Pct yok; eski satırlarda boş), incTf/inc5/inc15 (eksik 1m\'li mum), lvZoneHiN/lvZoneLoN, pkLvTouchUp/pkLvTouchDn',
    '- v3 kurulum puanı (tepeler.csv, atr2C15\'ten sonra, derece bunu kullanmaz; v3B kuralı 25.11.2026\'dan beri ⭐ kurulum kartını tetikler (setupCards); dataVer 2026.11.25-2 ve sonrası, eski satırlarda boş): v3_rsi1m (1dk RSI ≥ 85), v3_bb15 (15dk Bollinger %B > 1), v3_stoch5 (5dk Stoch RSI aşağı kesişim), v3_vol3 (3dk hacim ≥ 3 kat), v3_liq (son 15 dk short likidasyon > 0; backtest\'te boş) — 1/0, alan yoksa boş; v3S = bayrakların toplamı (hepsi boşsa boş); v3B = 1: v3S ≥ 4 ve pumpPct ≥ 5 ve aynı pompada (sembolde adaylar arası < 60 dk) daha önce v3B=1 olmayan ilk aday. Kayıtta cfgSetupVer = 1',
    '- Derece alanları (tepeler.csv sonda; kartlar.csv kurulum 3 kolonundan önceki 16 kolon): grade = o anki kart derecesi (gradeVer 2: 1 + ayrışma + 1s + 15dk + ATR + MACD 5m + Stoch 5m + 3dk RSI), gradeOld = MACD/Stoch/3dk RSI şartsız eski formül (ayrışma eşiği güncel), g_sep/g_h1/g_r15/g_atr/g_macd/g_stoch/g_rsi3hi/g_runaway (0/1), cfgGradeRsi15m/cfgGradeAtr5Pct/cfgGradeMacd5m/cfgGradeStoch5m/cfgSepPct2/cfgGradeRsi3m (o andaki ayar). Eski satırlarda boş',
    '- Filtre dışı kart (kartlar.csv; mevcut kolonlardan sonra, derece alanlarından önce): snapOk (0/1: kart anında zorunlu filtreler sağlandı mı), snapFails (sağlanmayan şartlar, | ile), filterBypass (1: kart snapOk=0 iken SFP / seri patlaması / hareket yüzünden çıktı), bypassBy (sfp | burst | move | setup). Yalnız kayıt, kural değişmedi; eski satırlarda boş. MD satırındaki "aşağı" = 60 dk kapanış < 0 (tam pencereli kartlar, n parantezde)',
    '- ⭐ v3 B kurulum kartı (kartlar.csv en son 3 kolon, 25.11.2026; eski satırlarda boş): setup (1: kart v3 B kurulumu ile çıktı ya da aynı mumdaki karta ⭐ eklendi, 0: değil), setupS (v3S, 0–5), setupPump (pumpPct %). Kural tepeler.csv v3B ile aynı (aday anında karar); filtre dışı çıkan kurulum kartında bypassBy = setup',
    '- temaslar.csv: pb0, belowMin (sonda)',
    '- Kart şartı: rsiOk, hits, ok, fails (rsi|seviye…), score, checkOk · sonrası: low/high/close 5, 15, 30, 60, 240 (tepeye göre %)',
    '',
  ].filter(x => x != null).join('\n');

  // MD de zip'in içinde (tek belge); özet en sonda bilindiği için girdi en son kapanır (tek zip'te arşivin son girdisi)
  const mz = zip.entry(`haftalik-${label}.md`);
  await mz.write(md);
  await mz.end();
  const files = await zip.finish();
  return { label, md, files, counts, cutoff, from };
}

/**
 * Zamanlayıcı. send(files, caption) → Promise<boolean> (hepsi gittiyse true). purge(cutoff) veritabanını temizler.
 * @returns {{tick(now?): Promise<string|null>, state}}
 */
function createWeeklyJob({ store, file, send, purge, getSettings = () => ({}), E = {}, logger = console }) {
  let state = null;
  let retryAt = 0, running = false;
  const load = (now = Date.now()) => {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch {
      state = { lastSlot: lastSlot(now) };                            // ilk kurulum: ilk rapor bir sonraki Pazartesi
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch { /* yok */ }
    }
    return state;
  };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(state)); } catch (err) { logger.error(`[HAFTALIK] durum yazılamadı: ${err.message}`); } };

  async function tick(now = Date.now()) {
    load(now);
    const slot = lastSlot(now);
    if (running || slot <= state.lastSlot || now < retryAt) return null;
    running = true;
    try {
      const w = await buildWeekly(store, { now, s: getSettings(), E });
      const caption = `📦 <b>Haftalık istatistik</b> · ${w.label}\n${w.counts.cards} kart · ${w.counts.drops} düşüş · ${w.counts.touches} seviye teması`;
      const ok = await send(w.files, caption);
      if (!ok) { retryAt = now + 10 * MIN; logger.warn('[HAFTALIK] gönderilemedi — 10 dk sonra tekrar, veri silinmedi'); return 'fail'; }
      purge(w.cutoff);
      state.lastSlot = slot; save();
      logger.log(`[HAFTALIK] ${w.label} gönderildi (${w.counts.cards} kart, ${w.counts.drops} düşüş, ${w.counts.touches} temas) ve veritabanından silindi`);
      return 'sent';
    } catch (err) {
      retryAt = now + 10 * MIN;
      logger.error(`[HAFTALIK] hata: ${err?.stack || err}`);
      return 'fail';
    } finally { running = false; }
  }
  return { tick, get state() { return load(); } };
}

module.exports = { buildWeekly, createWeeklyJob, lastSlot, weekLabel, tzOffset, LAG_MS };
