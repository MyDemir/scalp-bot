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
  ['Derece 🔴🔴🔴',        c => c.grade === 3],
  ['Derece 🔴🔴🔴🔴',      c => c.grade === 4],
  // ...
  ['  ↳ seri içi',         c => c.inSeries],  // "şartsız" kaldır
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
const MIN_N = 5;             // bundan az örnekli seviyeler ayrı satırda (yorumlanmaz)

/**
 * Bir olay grubunun özeti.
 *   ema : temas anında fiyatı 3dk EMA21'in ÜSTÜNDE olanlardan (emaMin !== 0) 60 dk içinde EMA21'e inenlerin oranı.
 *   ret / kırdı: hangisi önce oldu — kırdı = 5dk kapanış seviyenin üstünde, en derin çekilmenin dibinden ÖNCE (ya da hiç
 *        çekilmeden); ret = diğerleri (seviyeyi geçemeden geri çekildi). İkisi toplamı = temas.
 *   stops: ret yiyenlerde dibin indiği en alttaki ortalama → adet (eski kayıtlarda yok → sayılmaz)
 */
function touchSum(a) {
  const sep = a.filter(e => e.emaMin !== 0);
  const back = sep.filter(e => e.emaMin != null);
  const broke = a.filter(e => e.brokeMin != null);
  const first = a.filter(e => e.brokeMin != null && (!(e.pb > 0) || e.brokeMin <= e.pbMin));
  const rej = a.filter(e => !first.includes(e));
  const withStop = rej.filter(e => e.stop);
  const stops = new Map();
  for (const e of withStop) stops.set(e.stop, (stops.get(e.stop) || 0) + 1);
  return {
    n: a.length,
    pb: median(a.map(e => e.pb)),
    sepN: sep.length, ema: back.length, emaRate: sep.length ? back.length / sep.length * 100 : null, emaMin: median(back.map(e => e.emaMin)),
    broke: broke.length, brokeRate: a.length ? broke.length / a.length * 100 : null,
    first: first.length, firstHeld: first.filter(e => e.held).length,
    held: a.filter(e => e.held).length, heldRate: a.length ? a.filter(e => e.held).length / a.length * 100 : null,
    brokeAfterEma: a.filter(e => e.brokeAfterEma).length,
    cards: a.filter(e => e.card).length,
    rej: rej.length, rejPb: median(rej.map(e => e.pb)), rejMin: median(rej.map(e => e.pbMin)),
    stopN: withStop.length,
    stops: [...stops.entries()].sort((x, y) => (x[0] === 'yok') - (y[0] === 'yok') || y[1] - x[1]),
    falling: rej.filter(e => e.falling).length,
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
const stopName = k => (k === 'yok' ? 'Ortalamaya inmedi' : k);
const ofN = (k, n) => `${pc(n ? k / n * 100 : null)} (${k})`;

/** Ret sonrası nerede durdu — dağılım satırları */
function stopLines(x, max = 8, prefix = '▫️ ') {
  if (!x.rej) return [`${prefix}ret yok`];
  if (!x.stopN) return [`${prefix}veri yok (yeni kayıtlarla birikecek)`];
  return x.stops.slice(0, max).map(([k, n]) => `${prefix}${stopName(k)} — ${ofN(n, x.stopN)}`);
}

function mainBlock(title, x) {
  if (!x.n) return `${title}\nkayıt yok`;
  const out = [
    title,
    `📍 ${x.n} temas · kart çıkan ${x.cards}`,
    `🔻 Ret yedi: ${ofN(x.rej, x.n)}`,
    `🚀 Kırdı: ${ofN(x.first, x.n)}`,
    ...(x.rej ? [`📉 Ret çekilmesi: ${pc1(x.rejPb)}`, `⏱ Dibe: ${Math.round(x.rejMin)} dk (medyan)`] : []),
    '',
    '🛑 <b>Ret sonrası nerede durdu</b>',
    ...stopLines(x),
  ];
  if (x.stopN && x.rej > x.stopN) out.push(`▫️ Ortalama verisi yok (eski kayıt): ${x.rej - x.stopN}`);
  if (x.falling) out.push(`⏳ 60 dk'da hâlâ düşüyor: ${x.falling}`);
  if (x.first) out.push('', `🚀 Kırıp üstte kalan: ${x.firstHeld}/${x.first}`);
  return out.join('\n');
}

function shortBlock(title, x) {
  if (!x.n) return `${title}\nkayıt yok`;
  const top = x.stops.slice(0, 2).map(([k, n]) => `🛑 ${stopName(k)} ${pc(n / x.stopN * 100)}`);
  return [
    title,
    `🔻 Ret ${pc(x.rej / x.n * 100)} · 📉 ${pc1(x.rejPb)}`,
    ...(top.length ? top : ['🛑 —']),
    `🚀 Kırıp üstte kalan: ${x.first ? pc(x.firstHeld / x.first * 100) : '—'}`,
  ].join('\n');
}

function levelBlock(name, x) {
  const top = x.stops.slice(0, 2).map(([k, n]) => `   🛑 ${stopName(k)} ${pc(n / x.stopN * 100)}`);
  return [
    `▪️ <b>${name}</b> — ${x.n} temas`,
    `   🔻 Ret ${x.rej} · 📉 ${pc1(x.rejPb)}`,
    ...(top.length ? top : ['   🛑 —']),
    `   🚀 Kırıp kalan ${x.first ? `${x.firstHeld}/${x.first}` : "—"}`,
  ].join('\n');
}

/**
 * Telegram metni (HTML) — telefonda dar ekran: kısa satırlar, emoji başlıklar, tanımlar açılır blokta.
 * @param {object[]} rows  levelTouch olayları
 * @param {object} o  { title, filter: seviye adında aranan metin (ör. "fib"), s: ayarlar }
 */
function touchText(rows, { title = '', filter = '', s = {} } = {}) {
  const f = filter.trim().toLocaleLowerCase('tr');
  const sel = f ? rows.filter(e => e.name.toLocaleLowerCase('tr').includes(f)) : rows;
  const head = `📐 <b>Seviye tepkisi</b>${f ? ` · “${filter.trim()}”` : ''}${title ? `\n🗓 ${title}` : ''}
<i>Dirence alttan temas → sonraki 60 dk</i>`;
  if (!sel.length) return `${head}\n\nKayıt yok.`;
  const rsiMin = s.rsiMin ?? 85, minTFs = s.minTFs ?? 2;
  const pump = sel.filter(e => e.rsiOk), calm = sel.filter(e => !e.rsiOk);
  const groups = touchGroups(sel).filter(g => g.rsi.n > 0).sort((a, b) => b.rsi.n - a.rsi.n);
  const big = groups.filter(g => g.rsi.n >= MIN_N), small = groups.filter(g => g.rsi.n < MIN_N);
  const levels = big.length || small.length ? [
    `📊 <b>Seviyelere göre (pompa)</b>`,
    ...big.map(g => levelBlock(shortName(g.name), g.rsi)),
    ...(small.length ? [`▫️ Az örnek (&lt;${MIN_N}): ${small.map(g => `${shortName(g.name)} (${g.rsi.n})`).join(', ')}`] : []),
  ].join('\n\n') : '';
  const how = `<blockquote expandable>ℹ️ <b>Nasıl ölçülür</b>
• Temas: önceki 1 dk kapanışı seviyenin %0.3'ten fazla altında, mumun tepesi seviyeye %0.3 yaklaştı (aynı seviye 60 dk'da bir)
• Pompa: temas anında 3dk/5dk/15dk RSI(${s.rsiPeriod ?? 14})'ten en az ${minTFs}'si ≥ ${rsiMin}
• Kırdı: en derin çekilmeden önce 5 dk kapanışı seviyenin %${s.dipAbovePct ?? 0.3} üstünde · Ret: kıramadan geri çekildi
• Çekilme: temastan sonraki tepeden en derin düşüş (medyan) · dibe: kaç dk sonra
• Nerede durdu: dip 3dk / 5dk / 15dk EMA21 ile kıyaslanır (grafikte görünen, canlı mum dahil). Bir ortalamanın ±%0.5'inde durduysa o ortalama; birini %0.5'ten fazla delip alttakine inmediyse "arası"; 15dk EMA21'i de deldiyse "15dk EMA21 altı"; hiçbirine inmediyse "ortalamaya inmedi"
• Kırıp üstte kalan: 60. dk kapanışı seviyenin üstünde
• Seviye: kartlardaki dirençler (MA200/EMA200, 7/30g en yüksek, günlük bölge/trend, 1h/4h tepe, 1 saatlik Fib)
• Kazanç/kayıp hesabı değildir</blockquote>`;
  const parts = [head, mainBlock(`🔥 <b>Pompa: RSI ${rsiMin}+ iken</b>`, touchSum(pump)), shortBlock(`💤 <b>RSI şartı yokken</b> (${calm.length} temas)`, touchSum(calm)), levels, how].filter(Boolean);
  let out = parts.join('\n\n');
  while (out.length > 4000 && big.length > 1) {
    big.pop();
    const lv = [`📊 <b>Seviyelere göre (pompa)</b>`, ...big.map(g => levelBlock(shortName(g.name), g.rsi)), `▫️ … diğerleri: /seviye 7 &lt;ad&gt;`].join('\n\n');
    out = [head, parts[1], parts[2], lv, how].join('\n\n');
  }
  return out.slice(0, 4096);
}

module.exports = { median, pctS, fmtDate, compact, CLASSES, classTable, load, touchGroups, touchSum, touchText, TOUCH_ORDER };
