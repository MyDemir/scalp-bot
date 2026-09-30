'use strict';

/**
 * Kart sınıfları ve "kart sonrası fiyat" özetleri — backtest raporu ve canlı /istatistik ORTAK kullanır.
 * Kazanç/kayıp hesabı yoktur: yalnızca karttan sonraki 15/60 dk'da fiyatın en düşük / en yüksek /
 * kapanış değişimi (kart anındaki fiyata göre, medyan).
 */

const { RSI_TFS } = require('./infoEngine');

const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const pctS = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
const fmtDate = t => new Date(t).toISOString().slice(0, 16).replace('T', ' ');

function compact(c) {
  const sn = c.snap;
  return {
    symbol: c.symbol, t: c.t, time: fmtDate(c.t), seq: c.seq, grade: c.grade ?? sn.grade ?? null, price: c.price, silent: c.silent, inSeries: Boolean(c.inSeries),
    news: c.news, tags: c.tags,
    rsi: Object.fromEntries(RSI_TFS.map(tf => [tf, +sn.rsi[tf].v.toFixed(2)])), hits: sn.hits,
    level: sn.level ? { name: sn.level.name, value: sn.level.value, dist: +sn.level.dist.toFixed(3), zone: sn.level.zone } : null,
    burst: c.trig.burst ? { grade: c.trig.burst.grade ?? null, dir: c.trig.burst.dir, body: +c.trig.burst.body.toFixed(2), volX: +c.trig.burst.volX.toFixed(1), taker: Math.round(c.trig.burst.taker) } : null,
    trigTFs: c.trig.tfs,
    move: c.trig.move ? { pct: +c.trig.move.pct.toFixed(2), grade: c.trig.move.grade } : null,
    sfp: c.trig.sfp ? { type: c.trig.sfp.type, level: c.trig.sfp.name } : null,
    discovery: sn.discovery ? { broken: sn.discovery.broken.name } : null,
    levelKind: sn.level?.kind ?? null,
    sepOk: sn.sepOk, conf: sn.conf.score, checkScore: sn.check?.score ?? null,
    checkOk: sn.check ? sn.check.items.filter(x => x.ok).map(x => x.key) : [],
    neg1m: sn.neg?.['1m']?.count ?? 0, neg3m: sn.neg?.['3m']?.count ?? 0, rsi1h: sn.conf.h1 != null ? +sn.conf.h1.toFixed(1) : null, rsi4h: sn.conf.h4 != null ? +sn.conf.h4.toFixed(1) : null,
    macd5m: sn.macd['5m']?.text ?? null, macd15m: sn.macd['15m']?.text ?? null,
    stoch5m: sn.stoch ? { k: +sn.stoch.k.toFixed(1), d: +sn.stoch.d.toFixed(1), cross: sn.stoch.cross } : null,
    vwapSigma: sn.vwap ? +sn.vwap.pos.toFixed(2) : null,
    bursts: sn.bursts, btc1h: sn.btc1h != null ? +sn.btc1h.toFixed(2) : null,
    fwd: c.fwd,
  };
}

const CLASSES = [
  ['Tüm kartlar',          () => true],
  ['İlk kart (#1)',        c => c.seq === 1],
  ['Derece 🔴',            c => c.grade === 1],
  ['Derece 🔴🔴',          c => c.grade === 2],
  ['Derece 🔴🔴🔴 (sesli)', c => c.grade === 3],
  ['Kontrol: 15m RSI ≥ 95',  c => (c.checkOk || []).includes('rsi15')],
  ['Kontrol: 5m+15m ≥ 95',   c => (c.checkOk || []).includes('rsi5_15')],
  ['Kontrol: çakışan direnç', c => (c.checkOk || []).includes('confluence')],
  ['RSI 2/3',              c => c.hits === 2],
  ['RSI 3/3',              c => c.hits === 3],
  ['Dirençte',             c => c.level?.zone === 'dip'],
  ['Yaklaşıyor',           c => c.level?.zone === 'near'],
  ['Hacim tetikli',        c => c.burst != null],
  ['  ↳ satış patlaması',  c => c.burst?.dir === 'sell'],
  ['  ↳ alım patlaması',   c => c.burst?.dir === 'buy'],
  ['  ↳ seri içi (şartsız)', c => c.inSeries],
  ['    ↳ satış',          c => c.inSeries && c.burst?.dir === 'sell'],
  ['Ayrışma ✓',            c => c.sepOk],
  ['Destek 2/2',           c => c.conf === 2],
  ['Negatif tepe ≥2',      c => Math.max(c.neg1m || 0, c.neg3m || 0) >= 2],
  ['3/3 + Dirençte',       c => c.hits === 3 && c.level?.zone === 'dip'],
  ['⚡ 1 dk hareket içeren', c => c.move != null],
  ['Sahte kırılım (SFP)',  c => c.sfp != null],
  ['  ↳ fitil',            c => c.sfp?.type === 'wick'],
  ['Fiyat keşfi',          c => c.discovery != null],
  ['Seviye: 1h/4h tepe',   c => c.levelKind === 'swing'],
  ['Seviye: Fib',          c => c.levelKind === 'fib'],
];

function classTable(cards) {
  const rows = [];
  for (const [name, f] of CLASSES) {
    const sub = cards.filter(f);
    const ok = sub.filter(c => c.fwd?.[60]);
    rows.push({
      name, n: sub.length,
      low60: median(ok.map(c => c.fwd[60].low)), high60: median(ok.map(c => c.fwd[60].high)), close60: median(ok.map(c => c.fwd[60].close)),
      low15: median(sub.filter(c => c.fwd?.[15]).map(c => c.fwd[15].low)),
    });
  }
  return rows;
}

function load(cards) {
  const perMin = new Map(), perHour = new Map();
  for (const c of cards) {
    perMin.set(c.t, (perMin.get(c.t) || 0) + 1);
    const h = Math.floor(c.t / 3_600_000);
    perHour.set(h, (perHour.get(h) || 0) + 1);
  }
  const maxMin = Math.max(0, ...perMin.values()), maxHour = Math.max(0, ...perHour.values());
  const over20 = [...perMin.values()].filter(v => v > 20).length;
  const peakHour = [...perHour.entries()].sort((a, b) => b[1] - a[1])[0];
  return { maxMin, maxHour, over20, peakHour: peakHour ? { at: fmtDate(peakHour[0] * 3_600_000), n: peakHour[1] } : null };
}

// ── Seviye tepkisi (src/levelTouch.js) ─────────────────────────────────────

const TOUCH_ORDER = ['Fib 0.236', 'Fib 0.382', 'Fib 0.5', 'Fib 0.618', 'Fib 0.786', 'Günlük bölge', 'Günlük trend çizgisi',
  '30 günlük en yüksek', '7 günlük en yüksek', '30 günlük tepe', '1d MA200', '1d EMA200', '4h MA200', '4h EMA200', '4h tepe', '1h tepe'];
// Tabloda kısa ad (telefonda sığsın)
const SHORT = { 'Günlük bölge': 'G. bölge', 'Günlük trend çizgisi': 'G. trend', '30 günlük en yüksek': '30g yüks.',
  '7 günlük en yüksek': '7g yüks.', '30 günlük tepe': '30g tepe' };
const shortName = n => SHORT[n] || n.replace(/^Fib 0\./, 'Fib .');
const MIN_N = 5;             // bundan az örnek → * (yorumlanmaz)

/**
 * Bir olay grubunun özeti.
 *   ema: temas anında fiyatı 3dk EMA21'in ÜSTÜNDE olanlardan (emaMin !== 0) 60 dk içinde EMA21'e inenlerin oranı.
 *        Temas mumu zaten EMA21'e değiyorsa (emaMin === 0 — fiyat EMA21'e yapışık yükseliyordu) "geri çekilme" sayılmaz.
 */
function touchSum(a) {
  const sep = a.filter(e => e.emaMin !== 0);
  const back = sep.filter(e => e.emaMin != null);
  const broke = a.filter(e => e.brokeMin != null);
  return {
    n: a.length,
    pb: median(a.map(e => e.pb)),
    sepN: sep.length, ema: back.length, emaRate: sep.length ? back.length / sep.length * 100 : null, emaMin: median(back.map(e => e.emaMin)),
    broke: broke.length, brokeRate: a.length ? broke.length / a.length * 100 : null,
    held: a.filter(e => e.held).length, heldRate: a.length ? a.filter(e => e.held).length / a.length * 100 : null,
    brokeAfterEma: a.filter(e => e.brokeAfterEma).length,
    cards: a.filter(e => e.card).length,
  };
}

/** Seviye adına göre gruplar: tümü + RSI şartlı */
function touchGroups(rows) {
  const by = new Map();
  for (const e of rows) { if (!by.has(e.name)) by.set(e.name, []); by.get(e.name).push(e); }
  const names = [...TOUCH_ORDER.filter(n => by.has(n)), ...[...by.keys()].filter(n => !TOUCH_ORDER.includes(n)).sort()];
  return names.map(name => {
    const a = by.get(name);
    return { name, all: touchSum(a), rsi: touchSum(a.filter(e => e.rsiOk)), cards: a.filter(e => e.card).length };
  });
}

const pc = v => (v == null ? '—' : `%${Math.round(v)}`);
const pc1 = v => (v == null ? '—' : `%${v.toFixed(1)}`);

function summaryBlock(title, x) {
  if (!x.n) return `<b>${title}</b>: kayıt yok`;
  return `<b>${title}</b> (${x.n} temas · kart çıkan ${x.cards})
• 3dk EMA21'e indi: <b>${pc(x.emaRate)}</b>${x.ema ? ` · medyan ${Math.round(x.emaMin)} dk sonra` : ''}
• En derin geri çekilme: <b>${pc1(x.pb)}</b> (medyan)
• Seviyeyi kırdı: ${pc(x.brokeRate)} · 60 dk sonra üstünde: <b>${pc(x.heldRate)}</b>`;
}

function levelTable(groups, pick) {
  const rows = groups.map(g => [g.name, pick(g)]).filter(([, x]) => x.n > 0);
  if (!rows.length) return '—';
  const line = (a, b, c, d, e, f) => `${a.padEnd(9)}${b.padStart(4)}${c.padStart(6)}${d.padStart(5)}${e.padStart(5)}${f.padStart(5)}`;
  return '<pre>' + [line('Seviye', 'Adet', 'Çekil', 'EMA', 'Kır', 'Üst'),
    ...rows.map(([n, x]) => line(shortName(n), String(x.n) + (x.n < MIN_N ? '*' : ''), pc1(x.pb), pc(x.emaRate), pc(x.brokeRate), pc(x.heldRate)))].join('\n') + '</pre>';
}

/**
 * Telegram metni (HTML).
 * @param {object[]} rows  levelTouch olayları
 * @param {object} o  { title, filter: seviye adında aranan metin (ör. "fib"), s: ayarlar (baz açıklaması) }
 */
function touchText(rows, { title = '', filter = '', s = {} } = {}) {
  const f = filter.trim().toLocaleLowerCase('tr');
  const sel = f ? rows.filter(e => e.name.toLocaleLowerCase('tr').includes(f)) : rows;
  const head = `📐 <b>Seviye tepkisi</b>${title ? ` · ${title}` : ''}${f ? ` · “${filter.trim()}”` : ''}
<i>Fiyat bir dirence alttan değdi → sonraki 60 dk</i>`;
  if (!sel.length) return `${head}\n\nKayıt yok.`;
  const rsiMin = s.rsiMin ?? 85, minTFs = s.minTFs ?? 2;
  const groups = touchGroups(sel);
  const rsiRows = sel.filter(e => e.rsiOk), other = sel.filter(e => !e.rsiOk);
  const baz = `<i>Nasıl ölçülür: temas = önceki 1 dk kapanışı seviyenin %0.3'ten fazla altında, mumun tepesi seviyeye %0.3 yaklaştı (aynı seviye 60 dk'da bir) · RSI ${rsiMin}+ = temas anında 3dk/5dk/15dk RSI(${s.rsiPeriod ?? 14})'ten en az ${minTFs}'si ≥ ${rsiMin} · EMA = temas anında 3dk EMA21'in üstündeyken 60 dk içinde EMA21'e inenler (zaten EMA21'e yapışık yükselenler hariç) · Kır = 5 dk kapanışı seviyenin %${s.dipAbovePct ?? 0.3} üstünde · Üst = 60. dk kapanışı seviyenin üstünde · Çekil = o ana kadarki tepeden en derin düşüş (medyan) · * ${MIN_N}'ten az örnek, yorumlanmaz · kazanç/kayıp değildir</i>`;
  const parts = [
    head,
    summaryBlock(`RSI ${rsiMin}+ iken`, touchSum(rsiRows)),
    summaryBlock('RSI şartı yokken', touchSum(other)),
    `<b>Seviyeye göre — RSI ${rsiMin}+ iken</b>\n${levelTable(groups, g => g.rsi)}`,
    `<b>Seviyeye göre — tüm temaslar</b>\n${levelTable(groups, g => g.all)}`,
    baz,
  ];
  let out = parts.join('\n\n');
  if (out.length > 4000) out = parts.slice(0, 4).join('\n\n') + '\n\n' + baz;
  return out.slice(0, 4000);
}

module.exports = { median, pctS, fmtDate, compact, CLASSES, classTable, load, touchGroups, touchSum, touchText, TOUCH_ORDER };
