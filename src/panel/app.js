'use strict';
/*
 * Scalp Bilgi Botu: salt okunur web paneli (istemci).
 *
 * - Satır içi betik ve olay özniteliği yok (CSP script-src 'self'); olaylar addEventListener ile bağlanır.
 * - Oturum yalnız HttpOnly çerezde: istekler credentials 'same-origin', ayrıca belirteç başlığı gönderilmez. 401 → '/'.
 * - Dışarıdan gelen her metin escapeHtml'den geçer; Telegram rapor metni tgHtml beyaz listesiyle gösterilir.
 * - Saatler TSİ (Europe/Istanbul). Kart sonrası değerler yalnız fiyat değişimidir (kazanç/kayıp yok).
 * - Polling: sekme gizliyken istek yok; yalnız açık sayfanın ucu çekilir.
 * - Saf render fonksiyonları Node'da da çalışır (test/test-panel-render.js).
 */

const TZ = 'Europe/Istanbul';
const FWD_WINDOWS = [5, 15, 30, 60, 240];
const PATH_MIN = 15;
const EMPTY_NOTE = 'Haftalık rapordan sonra kayıtlar silinir; yeni veri birikiyor.';

// ── Kaçış ──────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Telegram HTML'i (yalnızca b/i/u/code/pre) güvenle gösterir: önce her şey kaçışlanır, sonra bu etiketler geri açılır.
function tgHtml(str) {
  return escapeHtml(str)
    .replace(/&lt;a\s[\s\S]*?&gt;|&lt;\/a&gt;/g, '')
    .replace(/&lt;(\/?)(b|i|u|code|pre)&gt;/g, '<$1$2>');
}

// ── Biçim ──────────────────────────────────────────────────────────────────

const isNum = v => v !== null && v !== undefined && v !== '' && typeof v !== 'boolean' && Number.isFinite(Number(v));
const fmtNum = (v, d = 1) => (isNum(v) ? Number(v).toFixed(d) : '—');
const fmtPx = v => (isNum(v) ? String(+Number(v).toPrecision(6)) : '—');
/** İşaretli yüzde, Telegram kartıyla aynı yazım: +%1.20 / −%0.40 */
function fmtPct(v, d = 2) {
  if (!isNum(v)) return '—';
  const n = Number(v);
  return (n > 0 ? '+' : n < 0 ? '−' : '') + '%' + Math.abs(n).toFixed(d);
}
const fmtAbsPct = (v, d = 2) => (isNum(v) ? '%' + Math.abs(Number(v)).toFixed(d) : '—');
function fmtUsd(v) {
  if (!isNum(v)) return '—';
  const n = Number(v), a = Math.abs(n), s = n < 0 ? '−' : '';
  return s + (a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e3 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0));
}

const fmtCache = {};
function tzParts(t, opts) {
  const key = JSON.stringify(opts);
  fmtCache[key] = fmtCache[key] || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour12: false, ...opts });
  const o = {};
  for (const p of fmtCache[key].formatToParts(new Date(t))) o[p.type] = p.value;
  return o;
}
/** dd.mm HH:MM (TSİ) */
function fmtTime(t) {
  if (!isNum(t) || Number(t) <= 0) return '—';
  const p = tzParts(Number(t), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  return `${p.day}.${p.month} ${p.hour}:${p.minute}`;
}
/** HH:MM:SS (TSİ) */
function fmtClock(t) {
  if (!isNum(t) || Number(t) <= 0) return '—';
  const p = tzParts(Number(t), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${p.hour}:${p.minute}:${p.second}`;
}
function fmtDur(sec) {
  if (!isNum(sec)) return '—';
  const s = Math.max(0, Math.floor(Number(sec))), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d} g ${h} sa` : h > 0 ? `${h} sa ${m} dk` : `${m} dk`;
}

// ── Derece daireleri (Telegram kartıyla aynı: src/infoEngine.js circles, src/infoCard.js) ──
// sart3 (varsayılan) derecede daireler hep 🔴; derece 0 → ⚪. Hacimli mumda yön rengi (🟢 yükselen / 🔴 düşen).
const DOT = { red: '🔴', green: '🟢', white: '⚪' };
function circles(n, color = 'red') {
  const k = Math.max(0, Math.min(4, Math.floor(Number(n) || 0)));
  return k > 0 ? (DOT[color] || DOT.red).repeat(k) : DOT.white;
}

// ── Kart ───────────────────────────────────────────────────────────────────

/**
 * Kart sonrası pencere: kapanış değişimi (kart fiyatına göre %), title'da en düşük / en yüksek.
 * Kayıt yoksa: takip yarım kaldıysa "eksik", süre dolmadıysa "bekliyor", aksi halde "—".
 */
function fmtFwd(fwd, w, partial = false, t = null, now = Date.now()) {
  const x = fwd && fwd[w];
  if (x && isNum(x.close)) {
    const c = Number(x.close);
    return { text: fmtPct(c), cls: c < 0 ? 'dn' : c > 0 ? 'up' : 'flat', title: `${w} dk: kapanış ${fmtPct(c)} · en düşük ${fmtPct(x.low)} · en yüksek ${fmtPct(x.high)}` };
  }
  if (partial) return { text: 'eksik', cls: 'miss', title: `${w} dk penceresi kaydedilemedi (takip yarım kaldı; veri uydurulmaz)` };
  if (isNum(t) && Number(now) < Number(t) + w * 60000) return { text: 'bekliyor', cls: 'wait', title: `${w} dk henüz dolmadı` };
  return { text: '—', cls: 'wait', title: 'kayıt yok' };
}

const GRADE_FLAGS = [
  ['g_sep', c => `EMA21 ayrışma ≥ %${c.cfgSepPct2 ?? 3}`],
  ['g_h1', () => '1s RSI bandında'],
  ['g_r15', c => `15dk RSI ≥ ${c.cfgGradeRsi15m ?? 85}`],
  ['g_atr', c => `5dk ATR ≥ %${c.cfgGradeAtr5Pct ?? 1.2}`],
  ['g_macd', () => '5dk MACD zayıflıyor'],
  ['g_stoch', () => '5dk Stoch RSI aşağı kesişim'],
  ['g_rsi3hi', c => `3dk RSI ≥ ${c.cfgGradeRsi3m ?? 90}`],
];
/** Derece v2 şart bayrakları (gradeAudit): [{ key, label, ok }]; kayıtta yoksa boş. */
function gradeFlags(c) {
  if (!c || !GRADE_FLAGS.some(([k]) => k in c)) return [];
  return GRADE_FLAGS.filter(([k]) => k in c).map(([k, label]) => ({ key: k, label: label(c), ok: Number(c[k]) === 1 || c[k] === true }));
}
function gradeFlagsHtml(c) {
  const flags = gradeFlags(c);
  if (!flags.length) return '';
  const chips = flags.map(f => `<span class="flag ${f.ok ? 'on' : 'off'}" title="${f.ok ? 'sağlandı' : 'sağlanmadı'}">${f.ok ? '✓' : '·'} ${escapeHtml(f.label)}</span>`).join('');
  const run = Number(c.g_runaway) === 1 ? '<span class="flag warn" title="1s ya da 4s RSI tavanın üstünde: derece en fazla 2">Kaçak pompa: derece tavanı</span>' : '';
  const ver = isNum(c.gradeVer) ? `<span class="muted small">derece v${escapeHtml(c.gradeVer)}${isNum(c.gradeOld) ? ' · eski formül ' + escapeHtml(c.gradeOld) : ''}</span>` : '';
  return `<div class="flags">${chips}${run}${ver}</div>`;
}

function levelHtml(c) {
  const lv = c.level;
  if (lv && isNum(lv.value)) {
    const d = Number(lv.dist);
    const dist = isNum(lv.dist) ? (d <= 0 ? `${fmtAbsPct(d)} kala` : `${fmtAbsPct(d)} üstünde`) : '';
    const tch = isNum(lv.touches) ? ` · ${escapeHtml(lv.touches)} test` : '';
    return `Seviye: <b>${escapeHtml(lv.name)}</b> ${fmtPx(lv.value)}${dist ? ' (' + dist + ')' : ''}${tch}`;
  }
  if (c.discovery && c.discovery.broken) return `Fiyat keşfi: ${escapeHtml(c.discovery.broken)} kırıldı`;
  return 'Seviye: yakında direnç yok';
}

/** Tek kart (cardStore.rowToStat / infoStats.compact). Bellek kaydında (SQLite kapalı) Telegram metni gösterilir. */
function renderCard(c, now = Date.now()) {
  if (!c || typeof c !== 'object') return '';
  if (c.rsi == null && typeof c.text === 'string') {
    return `<article class="card mem"><div class="card-h"><span class="muted small">Bellek kaydı · ${escapeHtml(fmtTime(c.t))} TSİ</span></div><div class="tg">${tgHtml(c.text)}</div></article>`;
  }
  if (c.kind && c.kind !== 'card') return renderOtherCard(c, now);
  const g = isNum(c.grade) ? Number(c.grade) : 0;
  const r = c.rsi || {};
  const zone = c.level?.zone;
  const badges = [
    zone === 'dip' ? '<span class="badge accent">⭐ Dirençte</span>' : zone === 'near' ? '<span class="badge">Yaklaşıyor</span>' : '',
    c.sfp ? `<span class="badge">${c.sfp.type === 'wick' ? 'Sahte kırılım (fitil)' : 'Sahte kırılım'}</span>` : '',
    c.inSeries ? '<span class="badge">seri içi</span>' : '',
    c.silent === true ? '<span class="badge muted">🔕 sessiz</span>' : c.silent === false ? '<span class="badge">🔔 sesli</span>' : '',
    c.filterBypass ? `<span class="badge warn" title="${escapeHtml(['filtre dışı', c.bypassBy, Array.isArray(c.snapFails) ? c.snapFails.join(', ') : c.snapFails].filter(Boolean).join(' · '))}">filtre dışı</span>` : '',
    c.partial ? '<span class="badge miss" title="Takip yarım kaldı (yeniden başlatma); eksik pencereler uydurulmaz">eksik</span>' : '',
  ].join('');
  const rsiCell = (label, v) => `<div><dt>${label}</dt><dd>${escapeHtml(fmtNum(v, 1))}</dd></div>`;
  const news = Array.isArray(c.news) ? c.news.filter(x => typeof x === 'string').slice(0, 4) : [];
  const fwd = FWD_WINDOWS.map(w => {
    const f = fmtFwd(c.fwd, w, c.partial, c.t, now);
    return `<div class="fwd-c ${f.cls}" title="${escapeHtml(f.title)}"><span class="fwd-w">${w} dk</span><span class="fwd-v">${escapeHtml(f.text)}</span></div>`;
  }).join('');
  const extra = [
    isNum(c.sep3) || isNum(c.sep5) ? `EMA21 ayrışma: 3dk ${fmtPct(c.sep3, 1)} · 5dk ${fmtPct(c.sep5, 1)}` : '',
    isNum(c.atr5Pct) ? `5dk ATR ${fmtAbsPct(c.atr5Pct)}` : '',
  ].filter(Boolean).join(' · ');
  const market = [
    isNum(c.funding) ? `Funding ${fmtPct(c.funding, 4)}` : '',
    isNum(c.oiChg60) ? `OI 1s ${fmtPct(c.oiChg60)}` : '',
    isNum(c.btc1h) ? `BTC 1s ${fmtPct(c.btc1h)}` : '',
  ].filter(Boolean).join(' · ');
  return `<article class="card">
<div class="card-h"><div class="card-title"><span class="dots" title="Derece ${g}/4">${circles(g, 'red')}</span> ${coinLink(c.symbol, '#' + c.symbol)}${isNum(c.seq) ? ` <span class="muted">Kart ${escapeHtml(c.seq)}</span>` : ''}</div>
<div class="card-meta"><span class="px">${escapeHtml(fmtPx(c.price))}</span><time>${escapeHtml(fmtTime(c.t))}</time></div></div>
${badges ? `<div class="badges">${badges}</div>` : ''}
<dl class="rsi">${rsiCell('RSI 3dk', r['3m'])}${rsiCell('RSI 5dk', r['5m'])}${rsiCell('RSI 15dk', r['15m'])}${rsiCell('RSI 1s', c.rsi1h)}${rsiCell('RSI 4s', c.rsi4h)}</dl>
<div class="line">${levelHtml(c)}</div>
${extra ? `<div class="line muted">${escapeHtml(extra)}</div>` : ''}
${market ? `<div class="line muted">${escapeHtml(market)}</div>` : ''}
${news.length ? `<ul class="news">${news.map(n => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}
${gradeFlagsHtml(c)}
<div class="fwd"><div class="fwd-h">Kart sonrası fiyat (kapanış)</div><div class="fwd-grid">${fwd}</div></div>
${c.id ? `<div class="card-f"><button type="button" class="link" data-detail="${escapeHtml(c.id)}" aria-expanded="false">📋 Detay</button></div><div class="tg card-detail" data-detail-for="${escapeHtml(c.id)}" hidden></div>` : ''}
</article>`;
}

/** Sembol → coin ayrıntısı bağlantısı (#coin/SEMBOL). Metin kaçışlanır. */
function coinLink(sym, label) {
  if (!sym) return '<b>—</b>';
  return `<button type="button" class="link coin-link" data-coin="${escapeHtml(sym)}" title="Coin ayrıntısı"><b>${escapeHtml(label ?? sym)}</b></button>`;
}

/** Kart dışı kayıt (eski ⚡ uyarısı vb., kind != 'card'): yalnız zaman, fiyat ve sonrası. */
function renderOtherCard(c, now = Date.now()) {
  const fwd = FWD_WINDOWS.map(w => {
    const f = fmtFwd(c.fwd, w, c.partial, c.t, now);
    return `<div class="fwd-c ${f.cls}" title="${escapeHtml(f.title)}"><span class="fwd-w">${w} dk</span><span class="fwd-v">${escapeHtml(f.text)}</span></div>`;
  }).join('');
  const label = c.kind === 'move' ? '⚡ 1 dk hareket uyarısı (eski kayıt)' : 'Kayıt türü: ' + c.kind;
  const mv = isNum(c.movePct) ? ` · 1 dk ${fmtPct(c.movePct)}` : (c.move && isNum(c.move.pct) ? ` · 1 dk ${fmtPct(c.move.pct)}` : '');
  return `<article class="card other">
<div class="card-h"><div class="card-title">${coinLink(c.symbol, '#' + c.symbol)} <span class="badge">${escapeHtml(label)}</span></div>
<div class="card-meta"><span class="px">${escapeHtml(fmtPx(c.price))}</span><time>${escapeHtml(fmtTime(c.t))}</time></div></div>
${mv ? `<div class="line muted">${escapeHtml(mv.slice(3))}</div>` : ''}
<div class="fwd"><div class="fwd-h">Sonrası fiyat (kapanış)</div><div class="fwd-grid">${fwd}</div></div>
</article>`;
}

// Kart türü süzgeci (panel içi, kayıttaki alanlardan): ⚡ hareket, hacimli mum, sahte kırılım, fiyat keşfi, seri, dirençte, filtre dışı
const CARD_TYPES = [
  ['move', '⚡ 1 dk hareket içeren', c => c.move != null],
  ['burst', 'Hacimli mum içeren', c => c.burst != null],
  ['sfp', 'Sahte kırılım', c => c.sfp != null],
  ['disc', 'Fiyat keşfi', c => c.discovery != null],
  ['series', 'Seri içi', c => Boolean(c.inSeries)],
  ['dip', '⭐ Dirençte', c => c.level?.zone === 'dip'],
  ['bypass', 'Filtre dışı', c => Boolean(c.filterBypass)],
];
/** Kartın türleri (anahtar listesi). Bellek kaydında (SQLite kapalı) alan yok → boş. */
function cardTypes(c) {
  return c && typeof c === 'object' ? CARD_TYPES.filter(([, , f]) => f(c)).map(([k]) => k) : [];
}

// ── Tablo hücresi: data-l = dar ekranda satır kartının etiketi (app.css .tbl.mstack) ──
const td = (label, inner, cls = '') => `<td${cls ? ` class="${cls}"` : ''} data-l="${escapeHtml(label)}">${inner}</td>`;

// ── Seviye temasları ───────────────────────────────────────────────────────

/**
 * held = 60. dk kapanışı seviyenin ÜSTÜNDE (src/levelTouch.js: held = c > v).
 * Renk: ret short bakışında aranan tepkidir ama "kazanç" değildir → yeşil değil, vurgu (mavi).
 * Kırılım short bakışına ters → uyarı (amber). Kırmızı/yeşil kâr-zarar çağrışımı kullanılmaz.
 */
function touchLabel(held) {
  return held === true ? { text: 'Kırıp üstte kaldı', cls: 'warn' } : { text: 'Altında kaldı (ret)', cls: 'accent' };
}

function renderTouchRow(t) {
  const lb = touchLabel(t.held);
  return '<tr>' +
    td('Zaman', escapeHtml(fmtTime(t.t)), 'nowrap') +
    td('Parite', `<b>${escapeHtml(t.symbol)}</b>`, 'head') +
    td('Seviye', `${escapeHtml(t.name)}${t.kind ? ` <span class="muted small">${escapeHtml(t.kind)}</span>` : ''}`) +
    td('Değer', escapeHtml(fmtPx(t.value)), 'r num') +
    td('Seviye gücü', isNum(t.lvTouches) ? escapeHtml(t.lvTouches) + ' test' : '—', 'r num') +
    td('RSI', `${isNum(t.hits) ? escapeHtml(t.hits) + '/3' : '—'}${t.rsiOk ? ' ✓' : ''}`, 'r num') +
    td('Kart', t.card ? 'kart var' : '—') +
    td('En derin çekilme', `${fmtAbsPct(t.pb)}${isNum(t.pbMin) ? ` <span class="muted">${escapeHtml(t.pbMin)} dk</span>` : ''}`, 'r num') +
    td('60 dk tepe / dip', `${fmtPct(t.up)} / ${fmtPct(t.dn)}`, 'r num') +
    td('60. dk', fmtPct(t.c60), 'r num') +
    td('Sonuç', `<span class="pill ${lb.cls}">${lb.text}</span>`) +
    '</tr>';
}

// ── Tepe defteri ───────────────────────────────────────────────────────────

const OUTCOMES = { 'düştü': ['Düştü', 'accent'], devam: ['Devam etti', 'warn'], yatay: ['Yatay', 'muted'] };
function outcomeLabel(o) {
  const x = OUTCOMES[o];
  return x ? { text: x[0], cls: x[1] } : { text: String(o ?? '—'), cls: 'muted' };
}

const isShadowKey = k => /^v3/i.test(k);
function v3Summary(feat) {
  const keys = Object.keys(feat || {}).filter(isShadowKey);
  if (!keys.length) return '—';
  const pick = ['v3S', 'v3B'].filter(k => k in feat);
  const shown = (pick.length ? pick : keys.slice(0, 2)).map(k => `${k} ${fmtVal(feat[k])}`);
  return shown.join(' · ');
}

function fmtVal(v) {
  if (v === true) return 'evet';
  if (v === false) return 'hayır';
  if (v === null || v === undefined || v === '') return '—';
  if (isNum(v)) { const n = Number(v); return Number.isInteger(n) ? String(n) : String(+n.toFixed(3)); }
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  return String(v).slice(0, 80);
}

function renderEventRow(e, open = false) {
  const f = e.feat || {};
  const oc = outcomeLabel(e.outcome);
  const out = e.out || {};
  return `<tr class="click${open ? ' open' : ''}" data-id="${escapeHtml(e.id)}" tabindex="0" aria-expanded="${open ? 'true' : 'false'}">` +
    td('Zaman', escapeHtml(fmtTime(e.t)), 'nowrap') +
    td('Parite', `<b>${escapeHtml(e.symbol)}</b>`, 'head') +
    td('Sonuç', `<span class="pill ${oc.cls}">${escapeHtml(oc.text)}</span>`) +
    td('Düşüşe dk', isNum(e.dropMin) ? escapeHtml(e.dropMin) : '—', 'r num') +
    td('Kart', e.card ? `<span class="dots" title="Kart derecesi ${escapeHtml(e.cardGrade ?? '—')}/4">${circles(e.cardGrade, 'red')}</span>` : '<span class="muted">yok</span>', 'nowrap') +
    td('Tepe derecesi', isNum(f.grade) ? `<span class="dots" title="Tepe anındaki derece${isNum(f.gradeVer) ? ' (v' + escapeHtml(f.gradeVer) + ')' : ''}">${circles(f.grade, 'red')}</span>` : '—', 'nowrap') +
    td('Pompa', `${isNum(f.pumpPct) ? fmtAbsPct(f.pumpPct, 1) : '—'}${isNum(f.pumpMin) ? ` <span class="muted">${escapeHtml(f.pumpMin)} dk</span>` : ''}`, 'r num') +
    td('RSI 3/5/15', `${fmtNum(f.rsi3, 0)}/${fmtNum(f.rsi5, 0)}/${fmtNum(f.rsi15, 0)}`, 'r num') +
    td('15 dk dip', fmtPct(out[15]?.low), 'r num') +
    td('60 dk son', fmtPct(out[60]?.close), 'r num') +
    td('v3 (gölge)', escapeHtml(v3Summary(f)), 'nowrap muted') +
    '</tr>';
}

const FEAT_LABELS = {
  price: 'Tepe fiyatı', rsi3: 'RSI 3dk', rsi5: 'RSI 5dk', rsi15: 'RSI 15dk', rsi1h: 'RSI 1s', rsi4h: 'RSI 4s', hits: 'RSI dilim',
  rsiOk: 'RSI şartı', ok: 'Kart şartı', grade: 'Derece', gradeOld: 'Derece (eski formül)', gradeVer: 'Derece sürümü', score: 'Kontrol skoru',
  lvName: 'Seviye', lvKind: 'Seviye türü', lvDist: 'Seviyeye uzaklık %', lvZone: 'Seviye bölgesi', sep3: 'EMA21 ayrışma 3dk %', sep5: 'EMA21 ayrışma 5dk %',
  sep15: 'EMA21 ayrışma 15dk %', atr5Pct: '5dk ATR %', pumpPct: 'Pompa %', pumpMin: 'Pompa süresi dk', funding: 'Funding %', btc1h: 'BTC 1s %',
  chg15: '15 dk değişim %', upBeforeDrop: 'Düşüşten önce yükseliş %', lowC15: '15 dk dip (kapanışa göre) %', closeC60: '60 dk kapanış %',
  trPct: 'Dip %', trMin: 'Dibe dk', outcome: 'Sonuç',
};

/** Tepe adayı ayrıntısı: derece bayrakları, göstergeler, gölge (v3) alanları ve yol grafiği yeri. */
function renderEventDetail(e) {
  const f = e.feat || {};
  const keys = Object.keys(f).filter(k => !/^g_/.test(k) && !/^cfg/.test(k));
  const main = keys.filter(k => !isShadowKey(k));
  const shadow = keys.filter(isShadowKey);
  const kv = list => list.map(k => `<div><dt>${escapeHtml(FEAT_LABELS[k] || k)}</dt><dd>${escapeHtml(fmtVal(f[k]))}</dd></div>`).join('');
  const outs = FWD_WINDOWS.map(w => {
    const x = (e.out || {})[w];
    return `<div class="fwd-c ${x && isNum(x.close) ? (x.close < 0 ? 'dn' : 'up') : 'wait'}" title="${x ? escapeHtml(`en düşük ${fmtPct(x.low)} · en yüksek ${fmtPct(x.high)}`) : 'kayıt yok'}"><span class="fwd-w">${w} dk</span><span class="fwd-v">${x ? fmtPct(x.close) : '—'}</span></div>`;
  }).join('');
  return `<div class="ev-detail">
<div class="ev-path" data-path-for="${escapeHtml(e.id)}">${e.hasPath ? '<div class="muted">Yol yükleniyor…</div>' : '<div class="muted">Bu aday için 15 dk yol kaydı yok.</div>'}</div>
<div class="ev-info">
<div class="fwd"><div class="fwd-h">Tepe sonrası fiyat (tepe fiyatına göre, kapanış)</div><div class="fwd-grid">${outs}</div></div>
${gradeFlagsHtml(f)}
${main.length ? `<dl class="kvgrid">${kv(main)}</dl>` : ''}
${shadow.length ? `<h4>v3 skoru <span class="shadow-tag">gölge</span></h4><p class="note small">Gölge alanlar karta ve dereceye girmez; yalnız kayıt ve kıyas içindir.</p><dl class="kvgrid shadow">${kv(shadow)}</dl>` : ''}
</div></div>`;
}

/**
 * 15 dk 1m yolu, inline SVG (CSP'ye uygun: betik yok, renkler app.css sınıflarından).
 * bars: [{h,l,c}] ham fiyat; çizim tepe fiyatına (entry) göre %.
 */
function pathSvg(path, { width = 600, height = 190, dropMin = null } = {}) {
  const entry = Number(path && path.entry);
  const bars = Array.isArray(path && path.bars) ? path.bars : [];
  if (!(entry > 0) || !bars.length) return '<div class="muted">Yol verisi yok.</div>';
  const pc = v => (isNum(v) ? (Number(v) - entry) / entry * 100 : null);
  const pts = bars.map(b => ({ h: pc(b.h), l: pc(b.l), c: pc(b.c) }));
  const vals = pts.flatMap(p => [p.h, p.l, p.c]).filter(v => v !== null).concat([0]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max(0.2, (hi - lo) * 0.08);
  lo -= pad; hi += pad;
  const W = Math.max(260, Math.floor(width)), H = height, L = 46, R = 10, T = 12, B = 24;
  const slots = Math.max(PATH_MIN, bars.length);
  const x = i => L + (i + 0.5) / slots * (W - L - R);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  const f1 = v => v.toFixed(1);
  const parts = [];
  // yatay kılavuzlar ve etiketler
  // Kenar etiketi sıfır çizgisine 14 pikselden yakınsa yazılmaz (üst üste binmesin)
  for (const v of [0, hi - pad, lo + pad]) {
    if (v !== 0 && Math.abs(y(v) - y(0)) < 14) continue;
    parts.push(`<line class="${v === 0 ? 'pc-zero' : 'pc-grid'}" x1="${L}" x2="${W - R}" y1="${f1(y(v))}" y2="${f1(y(v))}"/>`);
    parts.push(`<text class="pc-lbl" x="${L - 6}" y="${f1(y(v) + 4)}" text-anchor="end">${v === 0 ? '0' : fmtPct(v, 1)}</text>`);
  }
  for (const m of [1, 5, 10, 15]) if (m <= slots) parts.push(`<text class="pc-lbl" x="${f1(x(m - 1))}" y="${H - 6}" text-anchor="middle">${m}</text>`);
  if (isNum(dropMin) && dropMin >= 1 && dropMin <= slots) {
    const dx = f1(x(Number(dropMin) - 1));
    parts.push(`<line class="pc-drop" x1="${dx}" x2="${dx}" y1="${T}" y2="${H - B}"/><text class="pc-lbl pc-drop-t" x="${f1(x(Number(dropMin) - 1) + 4)}" y="${H - B - 4}" text-anchor="start">düşüş ${escapeHtml(dropMin)}. dk</text>`);
  }
  pts.forEach((p, i) => { if (p.h !== null && p.l !== null) parts.push(`<line class="pc-wick" x1="${f1(x(i))}" x2="${f1(x(i))}" y1="${f1(y(p.h))}" y2="${f1(y(p.l))}"/>`); });
  const line = pts.map((p, i) => (p.c === null ? null : `${f1(x(i))},${f1(y(p.c))}`)).filter(Boolean).join(' ');
  if (line) parts.push(`<polyline class="pc-close" points="${line}"/>`);
  pts.forEach((p, i) => { if (p.c !== null) parts.push(`<circle class="pc-dot" cx="${f1(x(i))}" cy="${f1(y(p.c))}" r="2.6"/>`); });
  const n = bars.length;
  return `<svg class="pathchart" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tepe sonrası ${n} dakikalık yol">${parts.join('')}</svg>` +
    `<div class="muted small">Tepe fiyatı ${escapeHtml(fmtPx(entry))} · ${n}/${PATH_MIN} dk kayıtlı · çizgi 1m kapanış, dikey çubuk 1m tepe–dip, yatay kesikli çizgi tepe fiyatı (0).${n < PATH_MIN ? ' Kalan dakikalar kaydedilmedi; uydurulmaz.' : ''}</div>`;
}

// ── Kapsam şeridi ──────────────────────────────────────────────────────────

const COVER_KEY = { simdi: 'oldestCard', tepe: 'oldestEvent', seviye: 'oldestTouch' };
/** "Kayıtlar dd.mm HH:MM TSİ'den beri · son haftalık rapor … · sonraki …" */
function coverageText(cov, page) {
  if (!cov || typeof cov !== 'object') return 'Kayıt kapsamı bilinmiyor (sunucu kapsam bilgisi göndermedi).';
  const weekly = `son haftalık rapor ${isNum(cov.lastWeeklySlot) ? fmtTime(cov.lastWeeklySlot) : '—'} · sonraki ${isNum(cov.nextWeeklySlot) ? fmtTime(cov.nextWeeklySlot) : '—'} TSİ`;
  if (page === 'akis') return `Akış kayıtları haftalık silmeye girmez (1 saatlik 30 gün, 4 saatlik 180 gün, büyük işlem 400 gün) · ${weekly}`;
  let oldest;
  if (COVER_KEY[page]) oldest = cov[COVER_KEY[page]];
  else oldest = ['oldestCard', 'oldestEvent', 'oldestTouch'].map(k => cov[k]).filter(isNum).reduce((a, b) => Math.min(a, b), Infinity);
  const head = isNum(oldest) && Number.isFinite(Number(oldest)) ? `Kayıtlar ${fmtTime(oldest)} TSİ'den beri` : 'Kayıt yok';
  return `${head} · ${weekly}`;
}

// ── Sistem: botlar, ayarlar, sağlık ────────────────────────────────────────

function renderBots(bots) {
  if (!bots.length) return '<div class="empty">Kayıtlı bot yok.</div>';
  return bots.map(b => {
    const local = b.type === 'local';
    const statusBadge = b.isOnline ? '<span class="pill ok">Çevrimiçi</span>' : (b.status === 'starting' ? '<span class="pill muted">Başlıyor</span>' : '<span class="pill bad">Çevrimdışı</span>');
    const seen = isNum(b.lastSeenSecondsAgo) ? (b.lastSeenSecondsAgo < 60 ? b.lastSeenSecondsAgo + ' sn önce' : Math.floor(b.lastSeenSecondsAgo / 60) + ' dk önce') : '—';
    const metricsHtml = Object.entries(b.metrics || {}).map(([k, v]) => `<div class="row"><span class="muted">${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('');
    return '<div class="box bot">' +
      `<div class="bot-h"><div><b>${escapeHtml(b.name)}</b>${local ? ' <span class="tag">bu süreç</span>' : ''}<div class="muted small">${escapeHtml(b.telegram || '—')}</div></div>${statusBadge}</div>` +
      // Yerel motorun "son sinyal" alanı sabit bir metindir ve nabzı her istekte "şimdi"dir: gösterilmez.
      (local ? '' : `<div class="row"><span class="muted">Son durum</span><span class="trunc">${escapeHtml(b.lastSignal || '—')}</span></div>`) +
      (b.lastError ? `<div class="err-box">Hata: ${escapeHtml(b.lastError)}</div>` : '') +
      (metricsHtml ? `<div class="rows">${metricsHtml}</div>` : '') +
      `<div class="muted small">${local ? 'Panel ile aynı süreçte çalışır' : 'Son nabız: ' + escapeHtml(seen)}</div>` +
      '</div>';
  }).join('');
}

function renderSettings(s, defs) {
  const known = new Set(defs.map(d => d.key));
  const rows = defs.filter(d => d.key in s).map(d => [d.label, s[d.key], d.type])
    .concat(Object.keys(s).filter(k => !known.has(k)).map(k => [k, s[k], typeof s[k]]));
  if (!rows.length) return '<div class="empty">Ayar yok.</div>';
  return rows.map(([label, v, type]) => {
    const shown = type === 'bool' || typeof v === 'boolean' ? (v ? 'açık' : 'kapalı') : (v && typeof v === 'object' ? JSON.stringify(v) : v);
    return `<div class="row"><span class="muted">${escapeHtml(label)}</span><span class="r">${escapeHtml(shown)}</span></div>`;
  }).join('');
}

const healthRow = (label, value, cls) => `<div class="row"><span class="muted">${escapeHtml(label)}</span><span class="r num ${cls || ''}">${escapeHtml(value)}</span></div>`;

function renderHealth(st) {
  const h = st && st.health;
  if (!h) return { html: '<div class="muted">Motor henüz başlamadı.</div>', bad: false };
  const ws = st.websocket || {};
  const sec = ms => (ms == null ? '—' : (ms / 1000).toFixed(1) + ' sn');
  const lat = (h.latency?.last5m && h.latency.last5m.candles) ? h.latency.last5m : (h.latency?.current || {});
  const g = h.gapFill || {}, sd = h.seed || {}, stale = h.stale || { count: 0, sample: [] }, rec = h.recovery || { blocked: 0 };
  const wsBad = ws.connections && ws.open < ws.connections;
  const bad = stale.count > 0 || rec.blocked > 0 || Boolean(wsBad);
  const html =
    healthRow('WebSocket', (ws.open ?? 0) + '/' + (ws.connections ?? 0) + ' bağlı · ' + (ws.streams ?? 0) + ' akış', wsBad ? 'bad' : '') +
    healthRow('Yeniden bağlanma', String(ws.reconnects ?? 0), ws.reconnects ? 'warn' : '') +
    healthRow('1m mum gecikmesi (ort / en çok)', sec(lat.lagAvgMs) + ' / ' + sec(lat.lagMaxMs), lat.lagMaxMs > 60000 ? 'bad' : lat.lagMaxMs > 20000 ? 'warn' : '') +
    (lat.localAvgMs != null ? healthRow('  Binance / yerel (ort)', sec(lat.binanceAvgMs) + ' / ' + sec(lat.localAvgMs), lat.localAvgMs > 5000 ? 'warn' : '') : '') +
    healthRow('Hazır / izlenen coin', (h.ready ?? '—') + ' / ' + (h.coins ?? '—') + (h.loading ? ' · ' + h.loading + ' yükleniyor' : '')) +
    healthRow('Geride (3 dk mum yok)', stale.count + (stale.count ? ' · ' + (stale.sample || []).slice(0, 4).join(', ') : ''), stale.count ? 'warn' : '') +
    healthRow('Kurtarmada (sinyal kilidi)', String(rec.blocked), rec.blocked ? 'warn' : '') +
    healthRow('Son boşluk doldurma', g.runs ? (g.lastRecoveredCandles + ' mum · ' + (g.lastIncomplete || 0) + ' eksik · ' + (g.lastStale || 0) + ' eski · ' + (g.lastFailures || 0) + ' hata') : 'yok', (g.lastIncomplete || g.lastStale || g.lastFailures) ? 'warn' : '') +
    healthRow('Son tohumlama', sd.runs ? (sd.lastSymbols + ' coin · ' + Math.round((sd.lastDurationMs || 0) / 1000) + ' sn · ' + (sd.lastFailures || 0) + ' hata') : 'yok', sd.lastFailures ? 'warn' : '');
  return { html, bad };
}

function renderTelegram(st) {
  const tg = (st && st.telegram) || {}, s = tg.stats || {};
  return healthRow('Bot', tg.username ? '@' + tg.username : 'bağlı değil') +
    healthRow('Komut dinleme', tg.polling ? 'açık' : 'kapalı') +
    healthRow('Kuyrukta bekleyen', String(s.queued ?? 0) + (s.pendingReplies ? ' · ' + s.pendingReplies + ' yanıt' : '')) +
    healthRow('İletilen', String(s.sent ?? 0)) +
    healthRow('Başarısız', String(s.failed ?? 0), s.failed ? 'warn' : '') +
    healthRow('429 sonrası tekrar', String(s.retried429 ?? 0), s.retried429 ? 'warn' : '') +
    healthRow('Birleştirilen', String(s.merged ?? 0)) +
    healthRow('Düşen: kuyruk dolu', String(s.droppedOverflow ?? 0), s.droppedOverflow ? 'warn' : '') +
    healthRow('Düşen: bayat', String(s.droppedExpired ?? 0), s.droppedExpired ? 'warn' : '') +
    (isNum(s.maxWaitMs) ? healthRow('En uzun bekleme', (s.maxWaitMs / 1000).toFixed(1) + ' sn') : '');
}

const DISPATCH_STATUS = { sent: 'gönderildi', failed: 'başarısız', dropped_overflow: 'düştü (kuyruk dolu)', dropped_expired: 'düştü (bayat)' };
const DISPATCH_KIND = { card: 'kart', reply: 'yanıt', alert: 'uyarı' };
function renderDispatches(list) {
  if (!Array.isArray(list) || !list.length) return '<div class="muted">Henüz gönderim yok.</div>';
  // chatId gösterilmez (kullanıcı/grup kimliği).
  return list.slice(0, 15).map(d => {
    const preview = String(d.text || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').slice(0, 90);
    return `<div class="li"><span class="muted nowrap">${escapeHtml(fmtTime(d.t))}</span> <span class="tag">${escapeHtml(DISPATCH_KIND[d.kind] || d.kind || '—')}</span> <span class="${d.status === 'sent' ? '' : 'warn'}">${escapeHtml(DISPATCH_STATUS[d.status] || d.status || '')}</span>${d.note ? ` <span class="muted">${escapeHtml(d.note)}</span>` : ''} <span class="muted trunc">${escapeHtml(preview)}</span></div>`;
  }).join('');
}

function renderLogLine(l) {
  const lvl = l.level === 'error' ? ['HATA', 'bad'] : l.level === 'warn' ? ['UYARI', 'warn'] : ['BİLGİ', 'muted'];
  return `<div class="log"><span class="muted nowrap">${escapeHtml(fmtClock(l.t))}</span><span class="lvl ${lvl[1]}">${lvl[0]}</span><span class="ltag">[${escapeHtml(l.tag)}]</span><span class="lmsg">${escapeHtml(l.message)}</span></div>`;
}

function kpiHtml(st) {
  const k = (label, value, sub, cls) => `<div class="kpi"><div class="kpi-l">${escapeHtml(label)}</div><div class="kpi-v ${cls || ''}">${escapeHtml(value)}</div>${sub ? `<div class="kpi-s">${escapeHtml(sub)}</div>` : ''}</div>`;
  if (!st) return k('Durum', '—', 'yükleniyor');
  const tg = st.telegram?.stats || {};
  const d = st.diagnostics || {};
  const hl = renderHealth(st);
  return k('İzlenen parite', String(st.market?.totalPairs ?? '—'), (st.market?.readyPairs ?? 0) + ' hazır') +
    k('Bugünkü kart', String(st.stats?.cardsToday ?? 0), 'işlenen 1m mum ' + Number(st.stats?.closes || 0).toLocaleString('tr-TR')) +
    k('Veri akışı', st.health ? (hl.bad ? 'Dikkat' : 'Sağlıklı') : 'başlamadı', st.websocket ? (st.websocket.open ?? 0) + '/' + (st.websocket.connections ?? 0) + ' WS' : '', hl.bad ? 'warn' : '') +
    k('Telegram kuyruğu', (tg.queued ?? 0) + ' bekleyen', ((tg.droppedOverflow || 0) + (tg.droppedExpired || 0)) + ' düşen') +
    k('Hata / uyarı', (d.errorCount ?? 0) + ' / ' + (d.warnCount ?? 0), 'süreç açılışından beri', d.errorCount ? 'bad' : '') +
    k('Bellek', (st.memory?.rssMb ?? '—') + ' MB', 'heap ' + (st.memory?.heapUsedMb ?? '—') + ' MB · açık ' + fmtDur(st.uptimeSeconds));
}

// ── Akış ───────────────────────────────────────────────────────────────────

const FLOW_LABEL = { birikim: ['Toplanıyor', 'f-acc'], dagitim: ['Dağıtım', 'f-dist'], trendUp: ['Trend ↑', 'f-up'], trendDown: ['Trend ↓', 'f-down'], notr: ['Nötr', 'f-neutral'] };
const FLOW_TF = { '1h': '1s', '4h': '4s', '1d': 'Günlük', '1w': 'Haftalık', '1M': 'Aylık' };
const FLOW_TFS = ['1h', '4h', '1d', '1w', '1M'];
function flowBadge(w) {
  if (!w || !w.key) return '<span class="muted">—</span>';
  const [txt, cls] = FLOW_LABEL[w.key] || [w.key, 'f-neutral'];
  const extra = w.strength === 'güçlü' ? ' ●' : w.strength ? ' ○' : '';
  return `<span class="fbadge ${cls}" title="${escapeHtml((w.market || '') + ' · CVD ' + fmtPct(w.cvdPct) + (w.strength ? ' · ' + w.strength : ''))}">${escapeHtml(txt + extra)}</span>`;
}
function renderFlowRow(r, selected) {
  const sell = r.buyPct == null ? null : 100 - r.buyPct;
  const bp = r.buyPct == null ? '—' : `%${Number(r.buyPct).toFixed(2)} − ${Number(sell).toFixed(2)}`;
  const b = r.bigToday;
  return `<tr class="click${selected ? ' open' : ''}" data-s="${escapeHtml(r.symbol)}" tabindex="0">` +
    td('Parite', `<b>${escapeHtml(r.symbol)}</b>`, 'head') + td('Hacim (gün)', fmtUsd(r.vol), 'r num') + td('Alış − satış %', escapeHtml(bp), 'r num') + td('Değişim %', fmtPct(r.chg), 'r num') +
    FLOW_TFS.map(tf => td(FLOW_TF[tf], flowBadge((r.windows || {})[tf]), 'tf')).join('') +
    td('🐋 bugün alım / satım', b ? `${escapeHtml(b.buyN)} (${fmtUsd(b.buyUsd)}) / ${escapeHtml(b.sellN)} (${fmtUsd(b.sellUsd)})` : '<span class="muted">—</span>', 'r num wide') + '</tr>';
}

/** /api/flow?symbol= yanıtı → pencere tablosu + 4 saatlik geçmiş (Akış ayrıntısı ve coin sayfası) */
function flowDetailHtml(r) {
  if (!r || !r.windows) return '<div class="muted">Bu parite için akış verisi yok.</div>';
  const row = (tf, m, x) => {
    const c = x && x[m]; if (!c) return '';
    return `<tr>${td('Pencere', escapeHtml(FLOW_TF[tf] || tf), 'head')}${td('Piyasa', escapeHtml(m), 'muted')}<td data-l="Etiket">${flowBadge({ key: c.key, strength: c.strength, market: m, cvdPct: c.cvdPct })}${x.diverge && m === 'spot' ? ' <span class="warn" title="spot/futures ayrışması">⚠</span>' : ''}</td>` +
      td('Hacim', fmtUsd(c.vol), 'r num') + td('Alış', isNum(c.buyPct) ? '%' + escapeHtml(c.buyPct) : '—', 'r num') + td('Net', fmtUsd(c.net), 'r num') +
      td('Fiyat', fmtPct(c.priceChg), 'r num') + td('CVD', fmtPct(c.cvdPct), 'r num') +
      td('🐋 A/S', m === 'spot' && x.big ? escapeHtml(x.big.buyN + ' / ' + x.big.sellN) : '—', 'r num') + '</tr>';
  };
  const head = '<thead><tr><th>Pencere</th><th>Piyasa</th><th>Etiket</th><th class="r">Hacim</th><th class="r">Alış</th><th class="r">Net</th><th class="r">Fiyat</th><th class="r">CVD</th><th class="r">🐋 A/S</th></tr></thead>';
  const win = FLOW_TFS.map(tf => row(tf, 'spot', r.windows[tf]) + row(tf, 'futures', r.windows[tf])).join('');
  const hist = (r.history || []).map(h => `<tr>${td('Zaman', escapeHtml(fmtTime(h.t)), 'nowrap head')}${td('Hacim', fmtUsd(h.vol), 'r num')}${td('Alış', isNum(h.buyPct) ? '%' + escapeHtml(h.buyPct) : '—', 'r num')}${td('Fiyat', fmtPx(h.close), 'r num')}${td('🐋 A/S', h.big ? escapeHtml(h.big.buyN + ' / ' + h.big.sellN) : '—', 'r num')}</tr>`).join('');
  return `<div class="table-wrap"><table class="tbl small mstack">${head}<tbody>${win}</tbody></table></div>` +
    `<p class="note">🐋 eşiği bu parite için ${fmtUsd(r.bigThreshold)} $ (tek market emri) · sayım botun açılışından beri.</p>` +
    (hist ? `<h4>Spot 4 saatlik geçmiş</h4><div class="table-wrap"><table class="tbl small mstack"><thead><tr><th>Zaman</th><th class="r">Hacim</th><th class="r">Alış</th><th class="r">Fiyat</th><th class="r">🐋 A/S</th></tr></thead><tbody>${hist}</tbody></table></div>` : '');
}

// ── Takip ──────────────────────────────────────────────────────────────────

/**
 * Sonrası izlenen kart (cardStore.openTracks): dolan pencereler ✓, sıradaki pencereye kalan süre.
 * chg/low/high kart fiyatına göre yalnız fiyat değişimidir.
 */
function renderOpenTrack(o, now = Date.now()) {
  const done = new Set(Array.isArray(o.done) ? o.done.map(Number) : []);
  const next = FWD_WINDOWS.find(w => !done.has(w));
  const chips = FWD_WINDOWS.map(w => {
    if (done.has(w)) return `<span class="flag on" title="${w} dk penceresi kaydedildi">${w} dk ✓</span>`;
    if (w === next && isNum(o.t)) {
      const left = Math.max(0, Math.ceil((Number(o.t) + w * 60000 - now) / 60000));
      return `<span class="flag" title="${w} dk penceresine kalan süre">${w} dk · ${left} dk kaldı</span>`;
    }
    return `<span class="flag off">${w} dk</span>`;
  }).join('');
  const age = isNum(o.t) ? Math.max(0, Math.floor((now - Number(o.t)) / 60000)) : null;
  return '<tr>' +
    td('Parite', coinLink(o.symbol), 'head') +
    td('Kart', `${escapeHtml(fmtTime(o.t))}${age != null ? ` <span class="muted">(${age} dk önce)</span>` : ''}`, 'nowrap') +
    td('Kart fiyatı', escapeHtml(fmtPx(o.price)), 'r num') +
    td('Şimdiye kadar (son kapanış)', fmtPct(o.chg), 'r num') +
    td('En düşük / en yüksek', `${fmtPct(o.low)} / ${fmtPct(o.high)}`, 'r num') +
    td('Pencereler', `<div class="flags">${chips}</div>`, 'wide') +
    '</tr>';
}

/** Süren kart serisi (tracker): seri 15m RSI sıfırlama eşiğinin altına inince biter. */
function renderSeriesItem(x) {
  return `<div class="li">${coinLink(x.symbol)} <span class="dots" title="Serideki en yüksek derece ${escapeHtml(x.maxGrade ?? '—')}/4">${circles(x.maxGrade, 'red')}</span>` +
    `<span>${isNum(x.seq) ? 'Kart ' + escapeHtml(x.seq) : '—'}</span><span class="muted">· 24 s: ${escapeHtml(x.cards24h ?? 0)} kart</span>` +
    `<span class="muted nowrap">· son ${escapeHtml(fmtTime(x.lastT))} · ${escapeHtml(fmtPx(x.lastPrice))}</span></div>`;
}

/** Bugünkü ⚡ 1 dk hareket sayıları: ▲ yükselen / ▼ düşen (Telegram 📋 Detay ile aynı sayaç) */
function renderMoveItem(m) {
  return `<div class="li">${coinLink(m.symbol)} <span class="num" title="1 dk yükseliş">▲ ${escapeHtml(m.up ?? 0)}</span> <span class="num" title="1 dk düşüş">▼ ${escapeHtml(m.down ?? 0)}</span></div>`;
}

function renderWatch(follows, muted) {
  const f = Array.isArray(follows) ? follows : [], m = Array.isArray(muted) ? muted : [];
  return '<h4>⭐ Takip listesi</h4>' +
    (f.length ? `<div class="chips">${f.map(s => coinLink(s)).join('')}</div>` : '<div class="muted small">Takipte coin yok. Telegram’da /takip ETH ile eklenir.</div>') +
    '<h4>🔕 Susturulanlar</h4>' +
    (m.length ? m.map(x => `<div class="li">${coinLink(x.symbol)} <span class="muted">bitiş ${escapeHtml(fmtTime(x.until))} TSİ</span></div>`).join('') : '<div class="muted small">Susturulan coin yok.</div>');
}

// ── Piyasa ─────────────────────────────────────────────────────────────────

/** Piyasa geneli (infoBot marketState, dakikada bir): veri yoksa "—" (0 uydurulmaz) */
function marketKpiHtml(st) {
  const k = (label, value, sub) => `<div class="kpi"><div class="kpi-l">${escapeHtml(label)}</div><div class="kpi-v">${escapeHtml(value)}</div>${sub ? `<div class="kpi-s">${escapeHtml(sub)}</div>` : ''}</div>`;
  const s = st || {};
  return k('15m RSI ≥ 80 olan coin', isNum(s.breadth80) ? '%' + Number(s.breadth80).toFixed(1) : '—', 'hazır coinler içinde') +
    k('60 dk’da ≥ %3 yükselen', isNum(s.pumping) ? String(s.pumping) + ' coin' : '—', '1m kapanışlarına göre') +
    k('BTC 5 dk / 15 dk', `${fmtPct(s.btc5)} / ${fmtPct(s.btc15)}`, 'fiyat değişimi') +
    k('BTC 15m RSI', isNum(s.btcRsi15) ? Number(s.btcRsi15).toFixed(1) : '—', '');
}

/** Spot büyük işlem toplamı (spotFlow.bigTop): adet ve $ — alım/satım taker yönüdür, emir önerisi değildir. */
function renderBigRow(b) {
  return '<tr>' +
    td('Parite', coinLink(b.symbol), 'head') +
    td('Alım (adet · $)', `${escapeHtml(b.buyN ?? 0)} · ${fmtUsd(b.buyUsd)}`, 'r num') +
    td('Satım (adet · $)', `${escapeHtml(b.sellN ?? 0)} · ${fmtUsd(b.sellUsd)}`, 'r num') +
    td('Net $', fmtUsd(b.netUsd), 'r num') +
    td('Toplam $', fmtUsd(b.totalUsd), 'r num') +
    '</tr>';
}

/**
 * Likidasyon (marketData.liq, USDT): short tasfiyesi = zorla alım, long tasfiyesi = zorla satış.
 * Bellekte yalnız son 61 dk tutulur.
 */
function renderLiqRow(l) {
  return '<tr>' +
    td('Parite', coinLink(l.symbol), 'head') +
    td('Short tasfiyesi 15 / 60 dk', `${fmtUsd(l.liqShort15)} / ${fmtUsd(l.liqShort60)}`, 'r num') +
    td('Long tasfiyesi 15 / 60 dk', `${fmtUsd(l.liqLong15)} / ${fmtUsd(l.liqLong60)}`, 'r num') +
    '</tr>';
}

/** Funding satırı (premium Map'i, oran %); veri yoksa "—" */
function renderFundingRow(f) {
  const r = f && f.ratePct;
  return '<tr>' +
    td('Parite', coinLink(f.symbol), 'head') +
    td('Funding', isNum(r) ? (Number(r) > 0 ? '+' : Number(r) < 0 ? '−' : '') + '%' + Math.abs(Number(r)).toFixed(4) : '—', 'r num') +
    td('Sonraki', fmtTime(f.next), 'r num') +
    '</tr>';
}

// ── Coin sayfası ───────────────────────────────────────────────────────────

/** "eth" → "ETHUSDT"; boş ya da geçersizse null (sunucudaki panelSymbol ile aynı kural) */
function normSym(q) {
  const raw = String(q ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  if (!raw) return null;
  const s = raw.endsWith('USDT') ? raw : raw + 'USDT';
  return /^[A-Z0-9]{2,30}$/.test(s) ? s : null;
}

/** /api/coin/:symbol özeti: izleme, takip/susturma, seri, ⚡ bugün, likidasyon, izlenen kartlar, 🐋 24 s */
function coinSummaryHtml(c, now = Date.now()) {
  if (!c) return '<div class="muted">Yükleniyor…</div>';
  const liq = c.liq || {};
  const big = c.big && c.big.day;
  return healthRow('İzleniyor', c.watched ? 'evet' : 'hayır (hacim filtresi dışında ya da yok)', c.watched ? '' : 'warn') +
    healthRow('Takip', c.followed ? '⭐ takipte (kartlar sesli)' : '—') +
    healthRow('Susturma', isNum(c.mutedUntil) && Number(c.mutedUntil) > now ? '🔕 ' + fmtTime(c.mutedUntil) + ' TSİ’ye kadar' : '—') +
    healthRow('Kart serisi', c.series ? `sürüyor · kart ${c.series.seq ?? '—'} · 24 s ${c.series.cards24h ?? 0} kart · en yüksek derece ${c.series.maxGrade ?? '—'}/4` : 'yok') +
    healthRow('Bugün ⚡ 1 dk hareket', c.moves ? `▲ ${c.moves.up ?? 0} · ▼ ${c.moves.down ?? 0}` : '—') +
    healthRow('Likidasyon 60 dk (short / long)', `${fmtUsd(liq.liqShort60)} / ${fmtUsd(liq.liqLong60)}`) +
    healthRow('Sonrası izlenen kart', String((c.open || []).length)) +
    healthRow('🐋 24 s alım / satım', big ? `${big.buyN} (${fmtUsd(big.buyUsd)}) / ${big.sellN} (${fmtUsd(big.sellUsd)})` : '—');
}

/** Coin sayfasında tepe adayı: tek satır özet (ayrıntı Tepe defteri sekmesinde) */
function renderMiniEvent(e) {
  const oc = outcomeLabel(e.outcome), out = e.out || {}, f = e.feat || {};
  return `<div class="li"><span class="muted nowrap">${escapeHtml(fmtTime(e.t))}</span> <span class="pill ${oc.cls}">${escapeHtml(oc.text)}</span>` +
    ` <span title="Kart derecesi">${e.card ? `<span class="dots">${circles(e.cardGrade, 'red')}</span>` : '<span class="muted">kartsız</span>'}</span>` +
    ` <span class="num">pompa ${isNum(f.pumpPct) ? fmtAbsPct(f.pumpPct, 1) : '—'}</span> <span class="num muted">15 dk dip ${fmtPct(out[15]?.low)} · 60 dk ${fmtPct(out[60]?.close)}</span></div>`;
}

/** Coin sayfası: saatlik büyük işlem sayaçları */
function renderBigHours(list) {
  if (!Array.isArray(list) || !list.length) return '<div class="muted">Son 24 saatte büyük işlem kaydı yok.</div>';
  return list.map(h => `<div class="li"><span class="muted nowrap">${escapeHtml(fmtTime(h.t))}</span> <span class="num">alım ${escapeHtml(h.buyN)} (${fmtUsd(h.buyUsd)})</span> <span class="num">satım ${escapeHtml(h.sellN)} (${fmtUsd(h.sellUsd)})</span></div>`).join('');
}

/** Sistem → Sağlık: ek veri akışlarının sayaçları (/api/feeds) */
function renderFeeds(f) {
  if (!f) return '<div class="muted">Yükleniyor…</div>';
  const n = v => (isNum(v) ? Number(v).toLocaleString('tr-TR') : '—');
  return healthRow('Likidasyon akışı', f.liq ? `${n(f.liq.messages)} mesaj · ${n(f.liq.symbols)} coin · ${n(f.liq.reconnects)} yeniden bağlanma` : 'kapalı', f.liq && f.liq.reconnects ? 'warn' : '') +
    healthRow('Spot büyük işlem akışı', f.bigTrades ? `${n(f.bigTrades.messages)} işlem · ${n(f.bigTrades.big)} büyük · ${n(f.bigTrades.reconnects)} yeniden bağlanma` : 'kapalı', f.bigTrades && f.bigTrades.reconnects ? 'warn' : '') +
    healthRow('Akış (spot/futures pencereleri)', f.flow ? `${n(f.flow.universe)} parite · ${n(f.flow.requests)} istek · ${n(f.flow.errors)} hata` : 'kapalı', f.flow && f.flow.errors ? 'warn' : '') +
    healthRow('Tepe ek verisi (OI, emir defteri, spot)', f.enricher ? `${n(f.enricher.ok)} başarılı · ${n(f.enricher.skipped)} atlandı · ${n(f.enricher.errors)} hata` : '—', f.enricher && f.enricher.errors ? 'warn' : '') +
    healthRow('Sonrası izlenen kart', n(f.openTracks)) +
    healthRow('Bellekteki 📋 Detay', f.details != null ? n(f.details) + ' / 3000' : '—');
}

// ── Sayfalar, roller ───────────────────────────────────────────────────────

const TABS = ['simdi', 'takip', 'piyasa', 'tepe', 'seviye', 'akis', 'rapor', 'sistem'];
const PAGES = TABS.concat(['coin']);   // coin: sekme değil, başlıktaki aramadan ya da sembol bağlantısından (#coin/ETHUSDT)
const SUBS = ['saglik', 'loglar', 'botlar', 'ayarlar', 'webhook'];
// Yenileme aralıkları (ms): KPI/status 15 sn; kart, temas, tepe defteri, akış 60 sn; loglar 10 sn; log günleri 5 dk
const INTERVALS = { status: 15000, cards: 60000, events: 60000, touches: 60000, flow: 60000, logs: 10000, logDays: 300000, bots: 30000, settings: 300000,
  tracking: 30000, market: 60000, coin: 60000, feeds: 30000 };
// Yalnız yöneticiye açık Sistem bölümleri ve uçları (/api/logs*, /api/external-bots, /api/settings → üyeye 403)
const ADMIN_SUBS = ['loglar', 'botlar', 'ayarlar', 'webhook'];
const ADMIN_KEYS = ['logs', 'logDays', 'bots', 'settings'];
const ROLE_LABEL = { admin: 'Yönetici', member: 'Üye' };

/**
 * Role göre görünen sekme / Sistem bölümü / çekilecek uç anahtarları.
 * Yalnız açıkça 'admin' olan yönetici sayılır; bilinmeyen rol üye gibi davranır (yönetici uçları hiç çağrılmaz).
 */
function visibleSections(role) {
  const admin = role === 'admin';
  return {
    role: admin ? 'admin' : 'member',
    label: ROLE_LABEL[admin ? 'admin' : 'member'],
    tabs: TABS.slice(),
    subs: admin ? SUBS.slice() : SUBS.filter(s => !ADMIN_SUBS.includes(s)),
    keys: Object.keys(INTERVALS).filter(k => admin || !ADMIN_KEYS.includes(k)),
  };
}

// ── Webhook örneği (nötr: emir/kâr dili yok) ──────────────────────────────

function webhookExample(origin) {
  return [
    'import requests',
    '',
    `HUB_URL = "${origin}/api/external-bots/heartbeat"`,
    'BOT_KEY = "EXTERNAL_BOT_KEY değeri"',
    '',
    'def report_status(error_msg=None):',
    '    payload = {',
    '        "id": "ornek-bot",',
    '        "name": "Örnek Bilgi Botu",',
    '        "telegram": "@OrnekBot",',
    '        "status": "error" if error_msg else "online",',
    '        "error": error_msg,',
    '        "lastSignal": "Son bildirim 14:05",',
    '        "metrics": {"İzlenen coin": "120", "Bugünkü mesaj": "8"}',
    '    }',
    '    try:',
    '        requests.post(HUB_URL, json=payload, headers={"X-Bot-Key": BOT_KEY}, timeout=5)',
    '    except Exception as e:',
    '        print("Nabız gönderilemedi:", e)',
    '',
    '# Hata yakalandığında:',
    '# report_status(error_msg="Binance bağlantısı koptu")',
  ].join('\n');
}

const REPORT_ARGS = {
  istatistik: ['Gün', '7'], seviye: ['Gün ve seviye adı', '7 fib'], kacan: ['Gün', '7'], teyit: ['Gün', '7'],
  gecmis: ['Coin ve adet', 'ETH 10'], coin: ['Coin', 'ETH'], akis: ['Coin (boş = son değişiklikler)', 'ETH'], takip: null, sessiz: null, durum: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// Tarayıcı tarafı (DOM, polling)
// ═══════════════════════════════════════════════════════════════════════════


function initPanel() {
  const $ = id => document.getElementById(id);
  const S = {
    tab: 'simdi', sub: 'saglik', last: {}, busy: {}, data: {}, err: {},
    openEvent: null, paths: new Map(), flowSel: null, logLevel: 'all', logDay: '', logs: [],
    view: visibleSections(null), forbidden: new Set(),
    coin: null, coinNow: new Map(), bigHours: 24, flowShow: 100, openDetails: new Set(),
  };

  // Giriş sonrası adres çubuğunda belirteç kalmasın (oturum yalnız çerezde).
  if (/[?&](token|_token)=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);

  async function api(url) {
    const r = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } });
    if (r.status === 401) { location.href = '/'; throw new Error('Oturum gerekli'); }
    let body;
    try { body = await r.json(); } catch { body = null; }
    if (!r.ok || !body || body.ok === false) {
      const err = new Error((body && body.error) || (body ? 'HTTP ' + r.status : 'Yanıt okunamadı (HTTP ' + r.status + ')'));
      err.status = r.status;
      throw err;
    }
    return body;
  }

  // ── Rol: üye yönetici bölümlerini görmez, o uçlar hiç çağrılmaz ──
  function applyRole() {
    const v = S.view;
    $('role-badge').textContent = v.label;
    $('role-badge').hidden = false;
    $('err-btn').hidden = v.role !== 'admin';
    for (const b of document.querySelectorAll('.subtab')) b.hidden = !v.subs.includes(b.dataset.sub);
  }
  function hideKey(key) {
    // 403: bölüm sessizce gizlenir (sunucu yetkiyi reddetti)
    S.forbidden.add(key);
    const subOf = { logs: 'loglar', logDays: 'loglar', bots: 'botlar', settings: 'ayarlar' }[key];
    if (subOf) {
      S.view = { ...S.view, subs: S.view.subs.filter(x => x !== subOf) };
      applyRole();
      if (S.tab === 'sistem' && S.sub === subOf) go('sistem', 'saglik');
    }
  }

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ── Tema (yalnız görünüm tercihi saklanır) ──
  try { const th = localStorage.getItem('panel-theme'); if (th === 'dark' || th === 'light') document.documentElement.dataset.theme = th; } catch { /* yok */ }
  $('theme-btn').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('panel-theme', next); } catch { /* yok */ }
    if (S.openEvent) drawPath(S.openEvent);
  });

  $('logout-btn').addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch { /* yok */ }
    location.href = '/';
  });
  $('err-btn').addEventListener('click', () => go('sistem', S.view.subs.includes('loglar') ? 'loglar' : 'saglik'));

  // ── Gezinme (#sekme ya da #sistem/alt) ──
  function go(tab, sub) {
    location.hash = (tab === 'sistem' || tab === 'coin') && sub ? `#${tab}/${sub}` : `#${tab}`;
  }
  function openCoin(sym) {
    const c = normSym(sym);
    if (!c) { toast('Geçersiz coin adı.', 'bad'); return; }
    go('coin', c);
  }
  function route() {
    const [t, s] = location.hash.replace(/^#/, '').split('/');
    S.tab = PAGES.includes(t) ? t : 'simdi';
    if (S.tab === 'coin') {
      const c = normSym(decodeURIComponent(s || ''));
      if (!c) S.tab = 'simdi';
      else if (c !== S.coin) { S.coin = c; S.data.coin = null; S.err.coin = null; S.last.coin = 0; }
    }
    if (S.tab === 'sistem') S.sub = S.view.subs.includes(s) ? s : (S.view.subs.includes(S.sub) ? S.sub : 'saglik');
    for (const id of PAGES) $('page-' + id).hidden = id !== S.tab;
    for (const b of document.querySelectorAll('.tab')) {
      const on = b.dataset.tab === S.tab;
      b.classList.toggle('active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
      // Dar ekranda sekme şeridi kayar: etkin sekme görünür alana gelsin
      if (on && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (S.tab === 'coin') { $('coin-q').value = S.coin.replace(/USDT$/, ''); loadCoinNow(false); }
    for (const id of SUBS) $('sub-' + id).hidden = id !== S.sub || !S.view.subs.includes(id);
    for (const b of document.querySelectorAll('.subtab')) b.classList.toggle('active', b.dataset.sub === S.sub);
    renderCoverage();
    renderAll();
    tick(false);
  }
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => go(b.dataset.tab));
  for (const b of document.querySelectorAll('.subtab')) b.addEventListener('click', () => go('sistem', b.dataset.sub));
  window.addEventListener('hashchange', route);

  // ── Polling ──
  function neededKeys() {
    const k = ['status'];
    if (S.tab === 'simdi') k.push('cards');
    else if (S.tab === 'takip') k.push('tracking');
    else if (S.tab === 'piyasa') k.push('market');
    else if (S.tab === 'coin') k.push('coin');
    else if (S.tab === 'tepe') k.push('events');
    else if (S.tab === 'seviye') k.push('touches');
    else if (S.tab === 'akis') k.push('flow');
    else if (S.tab === 'sistem') {
      if (S.sub === 'saglik') k.push('feeds');
      else if (S.sub === 'loglar') { k.push('logDays'); if (!S.logDay) k.push('logs'); }
      else if (S.sub === 'botlar') k.push('bots');
      else if (S.sub === 'ayarlar') k.push('settings');
    }
    return k.filter(x => S.view.keys.includes(x) && !S.forbidden.has(x));
  }
  const LOADERS = {
    status: async () => { S.data.status = await api('/api/status'); },
    cards: async () => { S.data.cards = await api('/api/cards?limit=' + ($('cards-type').value === 'old-move' ? '50&kind=move' : '50')); },
    tracking: async () => { S.data.tracking = await api('/api/tracking?limit=50'); },
    market: async () => { S.data.market = await api('/api/market?limit=30&hours=' + S.bigHours); },
    feeds: async () => { S.data.feeds = await api('/api/feeds'); },
    coin: async () => {
      const sym = S.coin;
      if (!sym) return;
      const [c, f] = await Promise.all([api('/api/coin/' + encodeURIComponent(sym)), api('/api/flow?symbol=' + encodeURIComponent(sym)).catch(() => null)]);
      if (sym === S.coin) S.data.coin = { ...c, flow: f };
    },
    events: async () => { S.data.events = await api('/api/events?limit=100' + ($('events-outcome').value ? '&outcome=' + encodeURIComponent($('events-outcome').value) : '')); },
    touches: async () => { S.data.touches = await api('/api/touches?limit=50'); },
    flow: async () => {
      const [t, c] = await Promise.all([api('/api/flow/table'), api('/api/flow?limit=60')]);
      S.data.flow = { table: t, changes: c };
    },
    logs: async () => { const r = await api('/api/logs'); if (!S.logDay) { S.data.logs = r; S.logs = r.logs || []; } },
    logDays: async () => { S.data.logDays = await api('/api/logs/days'); },
    bots: async () => { S.data.bots = await api('/api/external-bots'); },
    settings: async () => { S.data.settings = await api('/api/settings'); },
  };
  async function load(key) {
    if (S.busy[key]) return;
    S.busy[key] = true;
    S.last[key] = Date.now();
    try { await LOADERS[key](); S.err[key] = null; } catch (e) {
      if (e.status === 403 && ADMIN_KEYS.includes(key)) { S.busy[key] = false; hideKey(key); return; }
      S.err[key] = e.message || String(e);
    }
    S.busy[key] = false;
    render(key);
  }
  function tick(force) {
    if (document.hidden) return;   // sekme gizliyken hiçbir istek yok
    const now = Date.now();
    for (const key of neededKeys()) if (force || !S.last[key] || now - S.last[key] >= INTERVALS[key]) load(key);
  }
  setInterval(() => tick(false), 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(true); });

  // ── Çizim ──
  function errBox(key) { return S.err[key] ? `<div class="err-box">Okunamadı: ${escapeHtml(S.err[key])}</div>` : ''; }
  function renderCoverage() {
    $('coverage').textContent = coverageText(S.data.status && S.data.status.coverage, S.tab);
  }
  function render(key) {
    if (key === 'status') {
      const st = S.data.status;
      const errs = st?.diagnostics?.errorCount || 0;
      $('err-text').textContent = errs + ' hata';
      $('err-dot').className = 'dot ' + (errs ? 'bad' : 'ok');
      $('log-err-badge').hidden = !errs;
      $('log-err-badge').textContent = String(errs);
      renderCoverage();
      $('kpis').innerHTML = S.err.status && !st ? errBox('status') : kpiHtml(st);
      const hl = renderHealth(st);
      $('health-rows').innerHTML = hl.html;
      $('health-badge').innerHTML = st?.health ? `<span class="pill ${hl.bad ? 'warn' : 'ok'}">${hl.bad ? 'Dikkat' : 'Sağlıklı'}</span>` : '';
      $('tg-rows').innerHTML = renderTelegram(st);
      $('tg-recent').innerHTML = renderDispatches(st?.telegram?.recentDispatches);
    } else if (key === 'cards') renderCards();
    else if (key === 'tracking') renderTracking();
    else if (key === 'market') renderMarket();
    else if (key === 'coin') renderCoin();
    else if (key === 'feeds') $('feeds-rows').innerHTML = errBox('feeds') + renderFeeds(S.data.feeds);
    else if (key === 'events') renderEvents();
    else if (key === 'touches') renderTouches();
    else if (key === 'flow') renderFlow();
    else if (key === 'logs') renderLogs();
    else if (key === 'logDays') renderLogDays();
    else if (key === 'bots') $('bots').innerHTML = errBox('bots') + (S.data.bots ? renderBots(S.data.bots.bots || []) : '');
    else if (key === 'settings') $('settings').innerHTML = errBox('settings') + (S.data.settings ? renderSettings(S.data.settings.settings || {}, S.data.settings.defs || []) : '');
  }
  function renderAll() { for (const k of Object.keys(LOADERS)) if (S.data[k] || S.err[k]) render(k); }

  function renderCards() {
    const d = S.data.cards;
    const q = $('cards-filter').value.trim().toUpperCase();
    const type = $('cards-type').value;
    const old = type === 'old-move';
    const all = ((d && d.cards) || []).filter(c => (old ? c.kind === 'move' : !c.kind || c.kind === 'card'));
    const list = all.filter(c => (!q || String(c.symbol || '').toUpperCase().includes(q)) && (!type || old || cardTypes(c).includes(type)));
    $('cards-count').textContent = d ? `(${list.length}${d.source === 'memory' ? ' · bellekten' : ''})` : '';
    if (!d) { $('cards').innerHTML = errBox('cards') || '<div class="empty">Yükleniyor…</div>'; return; }
    const now = Date.now();
    $('cards').innerHTML = errBox('cards') + (list.length ? list.map(c => renderCard(c, now)).join('')
      : `<div class="empty">${q || type ? 'Eşleşen kart yok.' : 'Henüz kart yok. ' + EMPTY_NOTE}</div>`);
    restoreDetails($('cards'));
  }

  function renderEvents() {
    const d = S.data.events;
    const body = $('events-body');
    if (!d) { body.innerHTML = `<tr><td colspan="11" class="empty">${S.err.events ? 'Tepe defteri okunamadı: ' + escapeHtml(S.err.events) : 'Yükleniyor…'}</td></tr>`; return; }
    const list = d.events || [];
    $('events-count').textContent = `(${list.length})`;
    if (!list.length) { body.innerHTML = `<tr><td colspan="11" class="empty">Kayıtlı tepe adayı yok. ${EMPTY_NOTE}</td></tr>`; return; }
    body.innerHTML = list.map(e => renderEventRow(e, e.id === S.openEvent) +
      (e.id === S.openEvent ? `<tr class="detail"><td colspan="11">${renderEventDetail(e)}</td></tr>` : '')).join('');
    if (S.openEvent) drawPath(S.openEvent);
  }
  async function drawPath(id) {
    const ev = ((S.data.events && S.data.events.events) || []).find(e => e.id === id);
    const box = document.querySelector('.ev-path');
    if (!ev || !box || !ev.hasPath) return;
    let p = S.paths.get(id);
    if (!p) {
      try { p = (await api('/api/paths/' + encodeURIComponent(id))).path; S.paths.set(id, p); } catch (e) { box.innerHTML = `<div class="muted">Yol okunamadı: ${escapeHtml(e.message)}</div>`; return; }
    }
    const cur = document.querySelector('.ev-path');
    if (!cur || S.openEvent !== id) return;
    cur.innerHTML = pathSvg(p, { width: Math.min(720, cur.clientWidth || 600), dropMin: ev.dropMin });
  }
  function toggleEvent(id) { S.openEvent = S.openEvent === id ? null : id; renderEvents(); }
  $('events-body').addEventListener('click', ev => { const tr = ev.target.closest('tr.click'); if (tr) toggleEvent(tr.dataset.id); });
  $('events-body').addEventListener('keydown', ev => { const tr = ev.target.closest('tr.click'); if (tr && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); toggleEvent(tr.dataset.id); } });
  $('events-outcome').addEventListener('change', () => { S.openEvent = null; load('events'); });

  function renderTouches() {
    const d = S.data.touches;
    const body = $('touches-body');
    if (!d) { body.innerHTML = `<tr><td colspan="11" class="empty">${S.err.touches ? 'Temaslar okunamadı: ' + escapeHtml(S.err.touches) : 'Yükleniyor…'}</td></tr>`; return; }
    const list = d.touches || [];
    $('touches-count').textContent = `(${list.length})`;
    body.innerHTML = list.length ? list.map(renderTouchRow).join('') : `<tr><td colspan="11" class="empty">Kayıtlı temas yok. ${EMPTY_NOTE}</td></tr>`;
  }

  // ── Akış ──
  function renderFlow() {
    const d = S.data.flow;
    const body = $('flow-body');
    if (!d) { body.innerHTML = `<tr><td colspan="10" class="empty">${S.err.flow ? 'Akış verisi alınamadı: ' + escapeHtml(S.err.flow) : 'Yükleniyor…'}</td></tr>`; return; }
    if (d.table.enabled === false) { body.innerHTML = '<tr><td colspan="10" class="empty">Akış takibi kapalı.</td></tr>'; $('flow-count').textContent = ''; }
    else {
      const rows = d.table.rows || [];
      const q = $('flow-filter').value.trim().toUpperCase();
      const lb = $('flow-label').value;
      const list = rows.filter(r => (!q || String(r.symbol).includes(q)) && (!lb || (r.windows && r.windows['1d'] && r.windows['1d'].key === lb)));
      $('flow-count').textContent = `(${list.length} parite)`;
      body.innerHTML = list.length ? list.slice(0, S.flowShow).map(r => renderFlowRow(r, r.symbol === S.flowSel)).join('')
        : `<tr><td colspan="10" class="empty">${rows.length ? 'Eşleşen parite yok.' : 'Akış verisi henüz yok (ilk açılışta birkaç dakika sürer).'}</td></tr>`;
      const more = list.length - S.flowShow;
      $('flow-more').hidden = more <= 0;
      $('flow-more').textContent = `Daha fazla göster (${more > 0 ? more : 0} parite kaldı)`;
    }
    const ch = (d.changes && d.changes.changes) || [];
    $('flow-changes').innerHTML = ch.length ? ch.map(x => {
      const o = FLOW_LABEL[x.old] || [x.old || '—'];
      return `<div class="li"><span class="muted nowrap">${escapeHtml(fmtTime(x.at))}</span> <button type="button" class="link" data-s="${escapeHtml(x.symbol)}">${escapeHtml(x.symbol)}</button> <span class="muted">${escapeHtml(FLOW_TF[x.tf] || x.tf)}:</span> <span class="muted">${escapeHtml(o[0])}</span> → ${flowBadge({ key: x.new })}</div>`;
    }).join('') : '<span class="muted">Henüz etiket değişikliği yok.</span>';
  }
  async function showFlow(sym) {
    S.flowSel = sym; renderFlow();
    $('flow-detail-title').textContent = 'Ayrıntı: ' + sym;
    const el = $('flow-detail');
    el.textContent = 'Yükleniyor…';
    try {
      const r = await api('/api/flow?symbol=' + encodeURIComponent(sym));
      if (!r.windows) throw new Error('veri yok');
      el.innerHTML = flowDetailHtml(r) + `<p><button type="button" class="link" data-coin="${escapeHtml(sym)}">Coin ayrıntısına git →</button></p>`;
      if (matchMedia('(max-width: 959px)').matches && el.scrollIntoView) el.closest('.box').scrollIntoView({ block: 'start' });
    } catch (e) {
      el.textContent = 'Ayrıntı alınamadı: ' + e.message;
    }
  }
  $('flow-body').addEventListener('click', ev => { const tr = ev.target.closest('tr.click'); if (tr) showFlow(tr.dataset.s); });
  $('flow-body').addEventListener('keydown', ev => { const tr = ev.target.closest('tr.click'); if (tr && ev.key === 'Enter') showFlow(tr.dataset.s); });
  $('flow-changes').addEventListener('click', ev => { const b = ev.target.closest('button[data-s]'); if (b) showFlow(b.dataset.s); });
  $('flow-filter').addEventListener('input', () => { S.flowShow = 100; renderFlow(); });
  $('flow-label').addEventListener('change', () => { S.flowShow = 100; renderFlow(); });
  $('flow-more').addEventListener('click', () => { S.flowShow += 100; renderFlow(); });
  $('cards-filter').addEventListener('input', renderCards);
  $('cards-type').addEventListener('change', () => {
    // Eski ⚡ kayıtları sunucudan ayrı çekilir (kind=move); diğer türler eldeki kartlardan süzülür
    const wantOld = $('cards-type').value === 'old-move';
    const haveOld = Boolean(S.data.cards && (S.data.cards.cards || []).some(c => c.kind === 'move'));
    if (wantOld !== haveOld) { S.data.cards = null; load('cards'); }
    renderCards();
  });

  // ── 📋 Detay (kartın Telegram ayrıntı metni; bellekte son 3000 kart) ──
  const detailCache = new Map();
  async function toggleDetail(btn) {
    const id = btn.dataset.detail;
    const box = btn.closest('.card').querySelector('.card-detail');
    if (!box) return;
    if (!box.hidden) { box.hidden = true; btn.setAttribute('aria-expanded', 'false'); S.openDetails.delete(id); return; }
    box.hidden = false; btn.setAttribute('aria-expanded', 'true'); S.openDetails.add(id);
    if (!detailCache.has(id)) {
      box.textContent = 'Yükleniyor…';
      try { detailCache.set(id, (await api('/api/cards/' + encodeURIComponent(id) + '/detail')).text || '—'); } catch (e) { box.textContent = e.message; return; }
    }
    box.innerHTML = tgHtml(detailCache.get(id));
  }
  // Yenilemede açık ayrıntılar kapanmasın
  function restoreDetails(root) {
    for (const id of S.openDetails) {
      const btn = [...root.querySelectorAll('button[data-detail]')].find(b => b.dataset.detail === id);
      if (btn && detailCache.has(id)) {
        const box = btn.closest('.card').querySelector('.card-detail');
        box.hidden = false; box.innerHTML = tgHtml(detailCache.get(id)); btn.setAttribute('aria-expanded', 'true');
      }
    }
  }
  // Tüm sayfalarda: sembol bağlantısı → coin sayfası, 📋 Detay düğmesi
  $('main').addEventListener('click', ev => {
    const d = ev.target.closest('button[data-detail]');
    if (d) { toggleDetail(d); return; }
    const c = ev.target.closest('[data-coin]');
    if (c) { ev.preventDefault(); ev.stopPropagation(); openCoin(c.dataset.coin); }
  });
  $('coin-form').addEventListener('submit', ev => {
    ev.preventDefault();
    const q = $('coin-q').value.trim();
    if (q) openCoin(q);
  });

  // ── Takip ──
  function renderTracking() {
    const d = S.data.tracking;
    if (!d) { $('open-tracks').innerHTML = `<tr><td colspan="6" class="empty">${S.err.tracking ? 'Takip bilgisi okunamadı: ' + escapeHtml(S.err.tracking) : 'Yükleniyor…'}</td></tr>`; return; }
    const now = Date.now();
    const open = d.open || [];
    $('open-count').textContent = `(${open.length})`;
    $('open-tracks').innerHTML = open.length ? open.map(o => renderOpenTrack(o, now)).join('') : '<tr><td colspan="6" class="empty">Şu an sonrası izlenen kart yok (kart sonrası 240 dk izlenir).</td></tr>';
    $('series-list').innerHTML = errBox('tracking') + ((d.series || []).length ? d.series.map(renderSeriesItem).join('') : '<div class="muted">Süren kart serisi yok.</div>');
    $('moves-list').innerHTML = (d.moves || []).length ? d.moves.map(renderMoveItem).join('') : '<div class="muted">Bugün ⚡ 1 dk hareket sayılmadı.</div>';
    $('watch-list').innerHTML = renderWatch(d.follows, d.muted);
  }

  // ── Piyasa ──
  function renderMarket() {
    const d = S.data.market;
    $('market-kpis').innerHTML = errBox('market') + marketKpiHtml(d && d.state);
    if (!d) return;
    $('big-body').innerHTML = !d.bigEnabled ? '<tr><td colspan="5" class="empty">Akış takibi kapalı.</td></tr>'
      : (d.big || []).length ? d.big.map(renderBigRow).join('') : `<tr><td colspan="5" class="empty">Son ${d.hours} saatte büyük işlem kaydı yok.</td></tr>`;
    $('liq-body').innerHTML = (d.liq || []).length ? d.liq.map(renderLiqRow).join('') : '<tr><td colspan="3" class="empty">Son 60 dakikada likidasyon yok (ya da akış yeni başladı).</td></tr>';
    const fd = d.funding || {};
    const fRows = a => (a || []).length ? a.map(renderFundingRow).join('') : '<tr><td colspan="3" class="empty">Funding verisi henüz yok.</td></tr>';
    $('fund-top-body').innerHTML = fRows(fd.top);
    $('fund-bot-body').innerHTML = fRows(fd.bottom);
    for (const b of document.querySelectorAll('#big-hours .seg-btn')) b.classList.toggle('active', Number(b.dataset.h) === S.bigHours);
  }
  for (const b of document.querySelectorAll('#big-hours .seg-btn')) {
    b.addEventListener('click', () => { S.bigHours = Number(b.dataset.h); renderMarket(); load('market'); });
  }

  // ── Coin sayfası ──
  async function loadCoinNow(force) {
    const sym = S.coin;
    if (!sym) return;
    const box = $('coin-now'), img = $('coin-now-img');
    if (!force && S.coinNow.has(sym)) return showCoinNow(sym);
    box.textContent = 'Hazırlanıyor…'; img.hidden = true; img.textContent = '';
    try {
      const r = await api('/api/reports/coin?args=' + encodeURIComponent(sym));
      S.coinNow.set(sym, { text: r.text || '—', image: r.image, at: Date.now() });
      if (S.coinNow.size > 10) S.coinNow.delete(S.coinNow.keys().next().value);
    } catch (e) { if (sym === S.coin) box.textContent = 'Anlık durum alınamadı: ' + e.message; return; }
    if (sym === S.coin) showCoinNow(sym);
  }
  function showCoinNow(sym) {
    const x = S.coinNow.get(sym), img = $('coin-now-img');
    $('coin-now').innerHTML = tgHtml(x.text);
    $('coin-now-at').textContent = 'hazırlandı ' + fmtClock(x.at);
    img.textContent = '';
    if (typeof x.image === 'string' && x.image.startsWith('data:image/png;base64,')) {
      const el = document.createElement('img');
      el.src = x.image; el.alt = sym + ' grafiği'; el.className = 'report-img';
      img.appendChild(el); img.hidden = false;
    } else img.hidden = true;
  }
  $('coin-now-refresh').addEventListener('click', () => loadCoinNow(true));
  function renderCoin() {
    const c = S.data.coin, sym = S.coin;
    $('coin-title').textContent = sym ? '#' + sym : 'Coin';
    if (!c) {
      $('coin-summary').innerHTML = errBox('coin') || '<div class="muted">Yükleniyor…</div>';
      for (const id of ['coin-cards', 'coin-events', 'coin-touches-body', 'coin-flow', 'coin-big']) $(id).innerHTML = '';
      return;
    }
    const now = Date.now();
    $('coin-badges').innerHTML = [c.watched ? '<span class="badge">izleniyor</span>' : '<span class="badge warn">izlenmiyor</span>',
      c.followed ? '<span class="badge accent">⭐ takipte</span>' : '', isNum(c.mutedUntil) ? '<span class="badge muted">🔕 susturuldu</span>' : '',
      c.series ? '<span class="badge">seri sürüyor</span>' : ''].join('');
    $('coin-summary').innerHTML = errBox('coin') + coinSummaryHtml(c, now);
    $('coin-cards').innerHTML = (c.cards || []).length ? c.cards.map(x => renderCard(x, now)).join('') : `<div class="empty">Bu coin için kayıtlı kart yok. ${EMPTY_NOTE}</div>`;
    restoreDetails($('coin-cards'));
    $('coin-events').innerHTML = (c.events || []).length ? c.events.map(renderMiniEvent).join('') : '<div class="muted">Son 7 günde tepe adayı yok.</div>';
    $('coin-touches-body').innerHTML = (c.touches || []).length ? c.touches.map(renderTouchRow).join('') : '<tr><td colspan="11" class="empty">Son 7 günde seviye teması yok.</td></tr>';
    $('coin-flow').innerHTML = c.flow && c.flow.enabled !== false ? flowDetailHtml(c.flow) : '<div class="muted">Akış takibi kapalı.</div>';
    $('coin-big').innerHTML = c.big ? `<p class="note">Eşik ${fmtUsd(c.big.threshold)} $ (tek market emri).</p>` + renderBigHours(c.big.hours) : '<div class="muted">Akış takibi kapalı.</div>';
  }

  // ── Raporlar ──
  function reportArgsHint() {
    const a = REPORT_ARGS[$('report-name').value];
    const input = $('report-args');
    $('report-args-label').textContent = a ? a[0] : '—';
    input.placeholder = a ? a[1] : '';
    input.disabled = !a;
    if (!a) input.value = '';
  }
  async function runReport() {
    const name = $('report-name').value;
    const args = $('report-args').value.trim();
    const out = $('report-output'), img = $('report-image'), btn = $('report-run');
    btn.disabled = true;
    out.textContent = 'Hazırlanıyor…';
    img.hidden = true; img.textContent = '';
    try {
      const r = await api('/api/reports/' + encodeURIComponent(name) + '?args=' + encodeURIComponent(args));
      out.innerHTML = tgHtml(r.text || '—');
      if (typeof r.image === 'string' && r.image.startsWith('data:image/png;base64,')) {
        const el = document.createElement('img');
        el.src = r.image; el.alt = name + ' grafiği'; el.className = 'report-img';
        img.appendChild(el); img.hidden = false;
      }
    } catch (e) {
      out.textContent = 'Hata: ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }
  $('report-name').addEventListener('change', reportArgsHint);
  $('report-run').addEventListener('click', runReport);
  $('report-args').addEventListener('keydown', ev => { if (ev.key === 'Enter') runReport(); });

  // ── Loglar ──
  function renderLogs() {
    const q = $('log-search').value.trim().toLowerCase();
    let list = S.logs;
    if (S.logLevel !== 'all') list = list.filter(l => l.level === S.logLevel);
    if (q) list = list.filter(l => String(l.message || '').toLowerCase().includes(q) || String(l.tag || '').toLowerCase().includes(q));
    if (!S.logDay && S.data.logs) $('log-count').textContent = (S.data.logs.total ?? S.logs.length) + ' kayıt';
    $('logs').innerHTML = errBox('logs') + (list.length ? list.map(renderLogLine).join('') : '<div class="empty">Filtreye uyan kayıt yok.</div>');
  }
  function renderLogDays() {
    const r = S.data.logDays;
    const sel = $('log-day');
    if (!r) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">Canlı (son kayıtlar)</option>' + (r.days || []).map(d =>
      `<option value="${escapeHtml(d.day)}">${escapeHtml(d.day + ' · ' + d.errors + ' hata · ' + d.warnings + ' uyarı')}</option>`).join('');
    sel.value = keep;
    sel.title = r.persistent ? '' : 'Kalıcı kayıt kapalı (disk yazılamıyor)';
  }
  async function selectLogDay(day) {
    S.logDay = day;
    if (!day) { $('log-mode').textContent = 'Canlı akış'; load('logs'); return; }
    $('log-mode').textContent = 'Kayıtlı gün ' + day + ' (UTC)';
    try {
      const r = await api('/api/logs/history?limit=5000&day=' + encodeURIComponent(day));
      S.logs = r.entries || [];
      $('log-count').textContent = (r.total || 0) + ' kayıt';
      renderLogs();
    } catch (e) { toast('Günlük okunamadı: ' + e.message, 'bad'); }
  }
  async function downloadLogDay() {
    const day = S.logDay || new Date().toISOString().slice(0, 10);
    try {
      const res = await fetch('/api/logs/export?day=' + encodeURIComponent(day), { credentials: 'same-origin' });
      if (res.status === 401) { location.href = '/'; return; }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'İndirilemedi');
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url; a.download = 'scalp-log-' + day + '.jsonl';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { toast('Günlük indirilemedi: ' + e.message, 'bad'); }
  }
  for (const b of document.querySelectorAll('.seg-btn')) {
    b.addEventListener('click', () => {
      S.logLevel = b.dataset.level;
      for (const x of document.querySelectorAll('.seg-btn')) x.classList.toggle('active', x === b);
      renderLogs();
    });
  }
  document.querySelector('.seg-btn[data-level="all"]').classList.add('active');
  $('log-search').addEventListener('input', renderLogs);
  $('log-day').addEventListener('change', ev => selectLogDay(ev.target.value));
  $('log-download').addEventListener('click', downloadLogDay);
  async function copyText(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg, 'ok'); } catch { toast('Panoya kopyalanamadı.', 'bad'); }
  }
  $('log-copy').addEventListener('click', () => copyText(S.logs.map(l => `[${fmtClock(l.t)}] [${String(l.level).toUpperCase()}] [${l.tag}] ${l.message}`).join('\n'), 'Loglar panoya kopyalandı.'));

  // ── Webhook ──
  $('webhook-url').textContent = 'POST ' + location.origin + '/api/external-bots/heartbeat';
  $('code-python').textContent = webhookExample(location.origin);
  $('code-copy').addEventListener('click', () => copyText($('code-python').textContent, 'Örnek panoya kopyalandı.'));

  reportArgsHint();
  applyRole();
  // Rol önce okunur; yönetici uçları ancak rol 'admin' ise çağrılır.
  fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' })
    // 429: /api/auth/* IP sınırı (10 dk'da 20) sık yenilemede dolar; oturum geçerlidir, girişe atılmaz (üye görünümü kalır)
    .then(r => { if (r.status === 429) throw new Error('hız sınırı'); return r.json(); })
    .then(sess => {
      if (!sess || sess.ok === false) { location.href = '/'; return; }
      S.view = visibleSections(sess.role);
      applyRole();
    })
    .catch(() => { /* rol okunamadı: üye görünümü kalır */ })
    .finally(route);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPanel);
  else initPanel();
}

if (typeof module !== 'undefined') {
  module.exports = {
    escapeHtml, tgHtml, fmtPct, fmtPx, fmtTime, fmtClock, fmtFwd, circles, gradeFlags, renderCard, touchLabel, renderTouchRow,
    outcomeLabel, renderEventRow, renderEventDetail, pathSvg, coverageText, renderBots, renderSettings, renderHealth, renderTelegram,
    renderDispatches, renderLogLine, kpiHtml, flowBadge, renderFlowRow, webhookExample, visibleSections, EMPTY_NOTE, INTERVALS,
    coinLink, renderOtherCard, cardTypes, CARD_TYPES, flowDetailHtml, renderOpenTrack, renderSeriesItem, renderMoveItem, renderWatch,
    marketKpiHtml, renderFundingRow, renderBigRow, renderLiqRow, normSym, coinSummaryHtml, renderMiniEvent, renderBigHours, renderFeeds, TABS, PAGES,
  };
}
