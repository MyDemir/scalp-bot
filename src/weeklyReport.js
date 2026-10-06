'use strict';

/**
 * Haftalık istatistik dosyası — her Pazartesi 03:01 (TSİ) gruba gönderilir, sonra veritabanından silinir.
 *
 *   Dosyalar : haftalik-<yıl>-H<hafta>.md  — okunur özet + olay listesi (kartlar, düşüşler, seviye temasları)
 *              dususler-….csv · kartlar-….csv · temaslar-….csv — tüm sayılar (Sheets / Excel / Python)
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
const { rowToStat } = require('./cardStore');
const { toCsv, flatDrop, dropCols, dropText } = require('./eventLog');
const { touchText } = require('./infoStats');
const { flatten } = require('./exportData');

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
    + ` · 60dk ${pS(r.out?.[60]?.low)} / 240dk ${pS(r.out?.[240]?.low)}`;
}

function cardLine(r) {
  const rsi = r.rsi ? ['3m', '5m', '15m'].map(tf => n0(r.rsi[tf])).join('/') : '—';
  const lv = r.level ? `${r.level.name} ${pS(r.level.dist, 2)}${r.level.touches != null ? ` (${r.level.touches} temas)` : ''}` : 'seviye yok';
  const f60 = r.fwd?.[60];
  return `- ${fmt(r.t)} **${r.symbol}** #${r.seq ?? '—'} derece ${r.grade ?? '—'} · RSI 3/5/15dk ${rsi} · ${lv}`
    + `${r.sfp ? ` · sahte kırılım (${r.sfp.level})` : ''}${r.discovery ? ` · fiyat keşfi (${r.discovery.broken})` : ''}`
    + ` · 60dk en düşük ${pS(f60?.low)} / en yüksek ${pS(f60?.high)}${r.partial ? ' · (takip eksik)' : ''}`;
}

/**
 * @param {object} store  cardStore
 * @returns {{label, md, files:{name, buf}[], counts, cutoff}}
 */
function buildWeekly(store, { now = Date.now(), s = {}, E = {}, cutoff = now - LAG_MS } = {}) {
  const label = weekLabel(cutoff);
  const cards = store.since(0).filter(r => r.t < cutoff).map(rowToStat).filter(r => r.kind === 'card');
  const touches = (store.touchesSince ? store.touchesSince(0) : []).filter(r => r.t < cutoff);
  const drops = (store.eventsSince ? store.eventsSince(0) : []).filter(r => r.t < cutoff);
  const all = [...cards, ...touches, ...drops].map(r => r.t);
  const from = all.length ? Math.min(...all) : cutoff;
  const counts = { cards: cards.length, touches: touches.length, drops: drops.length };
  const grade = g => cards.filter(c => c.grade === g).length;
  const md = [
    `# Haftalık istatistik — ${label}`,
    '',
    `Kapsam: ${fmt(from)} → ${fmt(cutoff)} (TSİ) · ${counts.cards} kart · ${counts.drops} düşüş · ${counts.touches} seviye teması`,
    '',
    'Bu dosya botun kaydettiği olayların dökümüdür; kazanç/kayıp hesabı yoktur, "eşlik eden durum"dur. Sayısal analiz için aynı mesajdaki CSV dosyalarını kullan.',
    '',
    '## Kartlar',
    `Derece: 🔴 ${grade(1)} · 🔴🔴 ${grade(2)} · 🔴🔴🔴 ${grade(3)} · 🔴🔴🔴🔴 ${grade(4)}`,
    '',
    '## Düşüş defteri (özet)',
    '```',
    plain(dropText(drops, { title: `${counts.drops} düşüş`, s, E })),
    '```',
    '',
    '## Seviye tepkisi (özet)',
    '```',
    plain(touchText(touches, { title: `${counts.touches} temas`, s })),
    '```',
    '',
    `## Düşüşler (${counts.drops})`,
    'Her satır: tepe zamanı · coin · tepe fiyatı · pompa (4 saatlik dipten) · tepe anında RSI 1/3/5/15dk/1s/4s · tepkinin geldiği seviye (tepenin %0.3 içi) · tepede VWAP (σ) · tepeden sonraki 60 dk\'nın dibi ve orada en yakın destek · kart durumu · tepeye göre 60/240 dk en düşük',
    '',
    ...drops.map(dropLine),
    '',
    `## Kartlar (${counts.cards})`,
    ...cards.map(cardLine),
    '',
    '## Sütunlar (CSV)',
    '- dususler.csv: rsi_<tf> · ema21_<tf> (EMA21\'e uzaklık %) · macd_<tf> (down/up/zayıf/güçlü) · hist_<tf> (% fiyat) · stk_/std_<tf> (Stoch RSI) · atr_<tf> (%) · volx_<tf> (son mum hacmi / önceki 20 ortalama) · buy_<tf> (taker alış %) — tf: 1m 3m 5m 15m 1h 4h',
    '- VWAP: vwD/vwW/vwM_pct ve _sig (günlük/haftalık/aylık; % ve σ), vw90_pct/_sig (kayan 90 dk), vw24h_pct, vw7d_pct, avwLow_pct (pompa dibinden sabitlenmiş)',
    '- Tepe: pkLv / pkLvKind / pkLvDist / pkLvTouches (tepki seviyesi ve önceki ~100 günde kaç kez test edildiği), pkNear (%0.5 içindeki tüm seviyeler) · Dip: trPct, trMin, trLv, trLvDist, trLvTouches, trNear, trEma (3/5/15dk EMA21 merdiveni), trFalling',
    '- temaslar.csv: lvTouches = seviyenin önceki ~100 günde (4s mumlar) kaç ayrı kez test edildiği · kartlar.csv: level_touches',
    '- Kart şartı: rsiOk, hits, ok, fails (rsi|seviye…), score, checkOk · sonrası: low/high/close 5, 15, 60, 240 (tepeye göre %)',
    '',
  ].join('\n');

  const cardRows = cards.map(r => { const { bursts, text, kind, done, ...rest } = r; return flatten({ ...rest, time: new Date(r.t).toISOString(), partial: r.partial ? 1 : 0 }); });
  const touchRows = touches.map(r => flatten({ ...r, time: new Date(r.t).toISOString() }));
  const colsOf = rows => { const set = new Set(); for (const r of rows) for (const k of Object.keys(r)) set.add(k); return [...set]; };
  const files = [
    { name: `haftalik-${label}.md`, buf: Buffer.from(md, 'utf8'), type: 'text/markdown' },
    { name: `dususler-${label}.csv`, buf: Buffer.from(toCsv(drops.map(r => flatDrop(r)), dropCols()), 'utf8'), type: 'text/csv' },
    { name: `kartlar-${label}.csv`, buf: Buffer.from(toCsv(cardRows, colsOf(cardRows)), 'utf8'), type: 'text/csv' },
    { name: `temaslar-${label}.csv`, buf: Buffer.from(toCsv(touchRows, colsOf(touchRows)), 'utf8'), type: 'text/csv' },
  ];
  return { label, md, files, counts, cutoff, from };
}

/**
 * Zamanlayıcı. send(files, caption) → Promise<boolean> (hepsi gittiyse true). purge(cutoff) veritabanını temizler.
 * @returns {{tick(now?): Promise<string|null>, state}}
 */
function createWeeklyJob({ store, file, send, purge, getSettings = () => ({}), E = {}, logger = console }) {
  let state = null;
  let retryAt = 0, running = false;
  const load = () => {
    if (state) return state;
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch {
      state = { lastSlot: lastSlot() };                               // ilk kurulum: ilk rapor bir sonraki Pazartesi
      try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(state)); } catch { /* yok */ }
    }
    return state;
  };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(state)); } catch (err) { logger.error(`[HAFTALIK] durum yazılamadı: ${err.message}`); } };

  async function tick(now = Date.now()) {
    load();
    const slot = lastSlot(now);
    if (running || slot <= state.lastSlot || now < retryAt) return null;
    running = true;
    try {
      const w = buildWeekly(store, { now, s: getSettings(), E });
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
