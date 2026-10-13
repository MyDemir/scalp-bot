'use strict';

/**
 * 🔻 Tepe reddi — pompadaki tepe adayında (src/eventLog.js) tepe mumunun reddi.
 *
 *   Aday     : 1m mum son 60 dk'nın en yükseği ve 4 saatlik dipten ≥ %3 yukarıda (tepe defteriyle aynı)
 *   Skor 0–4 : (H42 verisi, 22.572 aday — "gerçek tepe": 60 dk tepe aşılmadı + kapanıştan ≥ 2×ATR(5dk) düşüş)
 *     R  mum reddi   — 5dk mumda üst fitil ≥ %35 YA DA 1dk mum alt yarısında kapandı
 *     K  kırmızı     — tepe 1dk mumu açılışının altında kapandı
 *     V  hacim       — 3dk mum hacmi önceki 20 mumun ≥ 2 katı
 *     SE seans       — Asya (03–09 TSİ) ya da Avrupa (10–15 TSİ)
 *     skor 0 → %7 · 1 → %13 · 2 → %21 · 3 → %32 · 4 → %39 gerçek tepe (tüm adaylar %16)
 *   Bildirim : skor ≥ peakAlertMin, pompa ≥ peakAlertPumpPct, coin başına peakAlertGapMin dk'da bir; kart biçimine dokunmaz,
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

/** EMA21 fiyatı: ema21_<tf> = fiyatın EMA21'e uzaklığı % (üstündeyse +) */
function emaPrice(price, sepPct) {
  return price > 0 && Number.isFinite(sepPct) ? price / (1 + sepPct / 100) : null;
}

/**
 * @param {object} o { sym, e: aday (t, price=tepe, feat), sc: peakScore, level, followed, id }
 * @returns {{text, keyboard, details}}
 */
function formatPeakAlert({ sym, e, sc, level = null, followed = false, id }) {
  const f = e.feat || {};
  const close = f.price ?? e.price;
  const mark = b => (b ? '✅' : '▫️');
  const sess = f.session ? ` (${f.session})` : '';
  const emas = [['3dk', f.ema21_3m], ['5dk', f.ema21_5m], ['15dk', f.ema21_15m]]
    .map(([n, sep]) => { const v = emaPrice(close, sep); return v ? `${n} ${px(v)} (${sep >= 0 ? '−' : '+'}${pa(sep)})` : null; }).filter(Boolean);
  const L = [
    `🔻 <b>#${esc(sym)} — Tepe reddi ${sc.score}/4</b>`,
    `${mark(sc.R)} Mum reddi · ${mark(sc.K)} Kırmızı mum · ${mark(sc.V)} Hacim${Number.isFinite(f.volx_3m) ? ` ${f.volx_3m.toFixed(1)} kat` : ''} · ${mark(sc.SE)} Seans${sess}`,
    `Pompa: +${pa(f.pumpPct)} (4s dipten${Number.isFinite(f.pumpMin) ? ` · ${Math.round(f.pumpMin)} dk` : ''})${f.rsiOk ? ' · RSI şartı ✅' : ''}`,
    `Tepe: ${px(e.price)} · Fiyat: ${px(close)}`,
    ...(emas.length ? [`EMA21 ${emas.join(' · ')}`] : []),
    `⏱: ${dayTime(e.t)}`,
  ];
  const r1 = v => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
  const D = [
    `📋 <b>#${esc(sym)} — Tepe reddi ${sc.score}/4</b> · ${dayTime(e.t)}`,
    '',
    '🕯 <b>Tepe mumu</b>',
    `5dk üst fitil: ${Number.isFinite(f.wick_5m) ? `%${Math.round(f.wick_5m * 100)}` : '—'} · 1dk kapanış konumu: ${Number.isFinite(f.clv_1m) ? f.clv_1m.toFixed(2) : '—'} (0 = dip, 1 = tepe)`,
    `1dk gövde: ${Number.isFinite(f.body_1m) ? `${f.body_1m >= 0 ? '+' : '−'}%${Math.abs(f.body_1m).toFixed(2)}` : '—'} · 3dk hacim: ${r1(f.volx_3m)} kat · 1dk alış: ${Number.isFinite(f.buy_1m) ? `%${Math.round(f.buy_1m)}` : '—'}`,
    '',
    '📊 <b>Durum</b>',
    `RSI 3dk/5dk/15dk/1s: ${r1(f.rsi3)} / ${r1(f.rsi5)} / ${r1(f.rsi15)} / ${r1(f.rsi1h)}`,
    `Günlük VWAP: ${Number.isFinite(f.vwD_sig) ? `${f.vwD_sig >= 0 ? '+' : '−'}${Math.abs(f.vwD_sig).toFixed(1)}σ` : '—'} · ATR 5dk: ${pa(f.atr5Pct, 2)}`,
    `Tepki seviyesi: ${f.pkLv ? esc(f.pkLv) : 'yok (%0.3 içinde)'}`,
    `Direnç: ${level ? `${esc(level.name)} ${px(level.value)}` : '—'}`,
    '',
    '<blockquote expandable>ℹ️ <b>Nasıl okunur</b>',
    '• Aday: 1dk mum son 60 dk\'nın en yükseği, 4 saatlik dipten ≥ %3 yukarıda',
    '• Mum reddi: 5dk mumda üst fitil ≥ %35 ya da 1dk mum alt yarısında kapandı · Kırmızı: tepe 1dk mumu açılışın altında · Hacim: 3dk ≥ 2 kat · Seans: Asya 03–09 / Avrupa 10–15 TSİ',
    '• H42 verisi (22.572 aday): skor 3 → %32, skor 4 → %39 "gerçek tepe" (60 dk tepe aşılmadı + kapanıştan ≥ 2 ATR düşüş); tüm adaylarda %16',
    '• Aynı veride skor ≥ 3 adayların %61\'inde tepe 60 dk içinde yine aşıldı (medyan +%0.9) · 60 dk içinde 3dk EMA21\'e %61, 5dk EMA21\'e %51 indi',
    '• Bilgi amaçlıdır, al/sat sinyali değildir</blockquote>',
    '',
    `#${esc(sym)} #TEPERED`,
  ];
  return { text: L.join('\n'), keyboard: cardKeyboard(id, sym, followed), details: D.join('\n') };
}

module.exports = { peakScore, formatPeakAlert, emaPrice };
