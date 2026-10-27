'use strict';

/**
 * 🔻 Tepe kurulumu — pompadaki tepe adayında (src/eventLog.js) short kurulumu bildirimi.
 *
 *   Aday     : 1m mum son 60 dk'nın en yükseği ve 4 saatlik dipten ≥ %3 yukarıda (tepe defteriyle aynı)
 *   Şartlar  : kart derecesinin üç şartı — EMA21 ayrışma (3dk ve 5dk ≥ sepPct2) · 1s RSI gradeRsi1h–gradeRsi1hMax (80–88) ·
 *              15dk RSI ≥ gradeRsi15m (85) — en az peakAlertConds (2) VE funding < peakAlertFundingMax (%0.005, taban oranın altı).
 *              1s trend aşağıysa ⭐ ile işaretlenir (bildirim şartı değil).
 *   Veri     : H42 + H43 (17–25.10, 6.825 pompa; pompa başına ilk eşleşen aday, giriş 1dk kapanış, 60 dk sonra aşağıda):
 *                tüm pompalar                       %56
 *                3 şarttan ≥ 2                      %66 (342 pompa)
 *                3 şarttan ≥ 2 + funding < %0.005   %73 (149) · dönemler %76 / %73 / %73 · medyan 60 dk −%1.7, ters +%1.8
 *                  + 1s trend aşağı (⭐)             %80 (74)  · %83 / %78 / %81 · ters +%1.2
 *                3 şartın üçü + funding             %80 (25)  · medyan dip −%7.8
 *              Eski kural (mum reddi skor 4 + 5dk ATR ≥ 1.2) aynı veride %52'ye düştü (18–20.10'da %78) → kaldırıldı.
 *              Funding ≥ %0.01 iken aynı şartlar %56. Mum reddi skoru (peakScore) Detay'da bilgi olarak kalır.
 *              Varsayılanlarla (pompa ≥ %5, coin başına 30 dk) 8 günde ~186 bildirim (günde ~23).
 *   Bildirim : şartlar, pompa ≥ peakAlertPumpPct, coin başına peakAlertGapMin dk'da bir; kart biçimine dokunmaz,
 *              ayrı mesaj (+ grafik), /konu tepe (boşsa kart konusu). Bilgi amaçlıdır — al/sat sinyali değildir.
 */

const { esc, px, dayTime, cardKeyboard } = require('./infoCard');

const pa = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `%${Math.abs(v).toFixed(d)}`);

/** @param {object} f  tepe adayı göstergeleri (eventLog FEATURE_COLS) */
function peakScore(f = {}) {
  const R = (f.wick_5m != null && f.wick_5m >= 0.35) || (f.clv_1m != null && f.clv_1m <= 0.5);
  const K = f.body_1m != null && f.body_1m < 0;
  const V = f.volx_3m != null && f.volx_3m >= 2;
  const SE = f.session === 'Asya' || f.session === 'Avrupa';
  return { score: R + K + V + SE, R, K, V, SE };
}

/**
 * Tepe kurulumu şartları (kart derecesiyle aynı eşikler) + funding.
 * @param {object} f  tepe adayı göstergeleri · @param {object} s  ayarlar
 */
function peakSetup(f = {}, s = {}) {
  const sepMin = s.sepPct2 ?? 2, h1Min = s.gradeRsi1h ?? 80, h1Max = s.gradeRsi1hMax ?? 88;
  const sep = f.sep3 != null && f.sep5 != null && f.sep3 >= sepMin && f.sep5 >= sepMin;
  const h1 = Number.isFinite(f.rsi1h) && f.rsi1h >= h1Min && !(h1Max > 0 && f.rsi1h >= h1Max);
  const r15 = Number.isFinite(f.rsi15) && f.rsi15 >= (s.gradeRsi15m ?? 85);
  const fund = Number.isFinite(f.funding) && f.funding < (s.peakAlertFundingMax ?? 0.005);
  const n = sep + h1 + r15;
  return { n, sep, h1, r15, fund, trendDown: f.trend_1h === 'aşağı', ok: n >= (s.peakAlertConds ?? 2) && fund };
}

/** EMA21 fiyatı: ema21_<tf> = fiyatın EMA21'e uzaklığı % (üstündeyse +) */
function emaPrice(price, sepPct) {
  return price > 0 && Number.isFinite(sepPct) ? price / (1 + sepPct / 100) : null;
}

/**
 * @param {object} o { sym, e: aday (t, price=tepe, feat), st: peakSetup, sc: peakScore, s: ayarlar (eşikler), level, followed, id }
 * @returns {{text, keyboard, details}}
 */
function formatPeakAlert({ sym, e, st, sc, s = {}, level = null, followed = false, id }) {
  const f = e.feat || {};
  const sepMin = s.sepPct2 ?? 2, h1Min = s.gradeRsi1h ?? 80, h1Max = s.gradeRsi1hMax ?? 88, r15Min = s.gradeRsi15m ?? 85, fMax = s.peakAlertFundingMax ?? 0.005;
  const close = f.price ?? e.price;
  const mark = b => (b ? '✅' : '▫️');
  const r1 = v => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
  const sg = v => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}%${Math.abs(v).toFixed(1)}`);
  const fund = Number.isFinite(f.funding) ? `${f.funding >= 0 ? '+' : '−'}%${Math.abs(f.funding).toFixed(4)}` : '—';
  const sess = f.session ? ` (${f.session})` : '';
  const emas = [['3dk', f.ema21_3m], ['5dk', f.ema21_5m], ['15dk', f.ema21_15m]]
    .map(([n, sep]) => { const v = emaPrice(close, sep); return v ? `${n} ${px(v)} (${sep >= 0 ? '−' : '+'}${pa(sep)})` : null; }).filter(Boolean);
  const title = `Tepe kurulumu ${st.n}/3${st.trendDown ? ' ⭐' : ''}`;
  const L = [
    `🔻 <b>#${esc(sym)} — ${title}</b>`,
    `${mark(st.sep)} EMA21 ayrışma 3dk ${sg(f.sep3)} · 5dk ${sg(f.sep5)}`,
    `${mark(st.h1)} 1s RSI ${r1(f.rsi1h)} · ${mark(st.r15)} 15dk RSI ${r1(f.rsi15)}`,
    `${mark(st.fund)} Funding ${fund}${st.trendDown ? ' · ⭐ 1s trend aşağı' : ''}`,
    `Pompa: +${pa(f.pumpPct)} (4s dipten${Number.isFinite(f.pumpMin) ? ` · ${Math.round(f.pumpMin)} dk` : ''}) · ATR 5dk ${pa(f.atr5Pct, 2)}${f.rsiOk ? ' · RSI şartı ✅' : ''}`,
    `Tepe: ${px(e.price)} · Fiyat: ${px(close)}`,
    ...(emas.length ? [`EMA21 ${emas.join(' · ')}`] : []),
    `⏱: ${dayTime(e.t)}`,
  ];
  const D = [
    `📋 <b>#${esc(sym)} — ${title}</b> · ${dayTime(e.t)}`,
    '',
    '🏅 <b>Şartlar</b>',
    `${mark(st.sep)} EMA21 ayrışma: 3dk ${sg(f.sep3)} · 5dk ${sg(f.sep5)} (ikisi de ≥ %${sepMin})`,
    `${mark(st.h1)} 1s RSI ${r1(f.rsi1h)} (${h1Min}${h1Max > 0 ? `–${h1Max}` : '+'})`,
    `${mark(st.r15)} 15dk RSI ${r1(f.rsi15)} (≥ ${r15Min})`,
    `${mark(st.fund)} Funding ${fund} (< %${fMax})`,
    `${st.trendDown ? '⭐' : '▫️'} 1s trend ${f.trend_1h ? esc(f.trend_1h) : '—'}`,
    '',
    '🕯 <b>Tepe mumu</b> (bilgi)',
    `${mark(sc.R)} Mum reddi · ${mark(sc.K)} Kırmızı mum · ${mark(sc.V)} Hacim${Number.isFinite(f.volx_3m) ? ` ${f.volx_3m.toFixed(1)} kat` : ''} · ${mark(sc.SE)} Seans${sess}`,
    `5dk üst fitil: ${Number.isFinite(f.wick_5m) ? `%${Math.round(f.wick_5m * 100)}` : '—'} · 1dk kapanış konumu: ${Number.isFinite(f.clv_1m) ? f.clv_1m.toFixed(2) : '—'} (0 = dip, 1 = tepe)`,
    '',
    '📊 <b>Durum</b>',
    `RSI 3dk/5dk/15dk/1s/4s: ${r1(f.rsi3)} / ${r1(f.rsi5)} / ${r1(f.rsi15)} / ${r1(f.rsi1h)} / ${r1(f.rsi4h)}`,
    `Günlük VWAP: ${Number.isFinite(f.vwD_sig) ? `${f.vwD_sig >= 0 ? '+' : '−'}${Math.abs(f.vwD_sig).toFixed(1)}σ` : '—'} · ATR 5dk: ${pa(f.atr5Pct, 2)}`,
    `Tepki seviyesi: ${f.pkLv ? esc(f.pkLv) : 'yok (%0.3 içinde)'}`,
    `Direnç: ${level ? `${esc(level.name)} ${px(level.value)}` : '—'}`,
    '',
    '<blockquote expandable>ℹ️ <b>Nasıl okunur</b>',
    '• Aday: 1dk mum son 60 dk\'nın en yükseği, 4 saatlik dipten ≥ %3 yukarıda',
    `• Şart: kart derecesinin 3 şartından en az ${s.peakAlertConds ?? 2} tanesi + funding %${fMax} altında (taban oran %0.005)`,
    '• H42 + H43 (17–25.10, 6.825 pompa, pompa başına ilk aday, 1dk kapanıştan): 60 dk sonra %73 aşağıda (tüm pompalar %56), medyan −%1.7; 60 dk içinde medyan +%1.8 yukarı da gitti',
    '• ⭐ 1s trend aşağı: %80 aşağıda, yukarı gidiş medyan +%1.2 · 3 şartın üçü: %80, medyan dip −%7.8',
    '• Funding ≥ %0.01 iken aynı şartlar yalnız %56 — bu yüzden şart',
    '• Bilgi amaçlıdır, al/sat sinyali değildir</blockquote>',
    '',
    `#${esc(sym)} #TEPEKURULUM`,
  ];
  return { text: L.join('\n'), keyboard: cardKeyboard(id, sym, followed), details: D.join('\n') };
}

module.exports = { peakScore, peakSetup, formatPeakAlert, emaPrice };
