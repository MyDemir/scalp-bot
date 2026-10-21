'use strict';

/**
 * Bilgi kartı metni (Telegram HTML) + satır içi butonlar.
 */

const TZ = process.env.DISPLAY_TZ || 'Europe/Istanbul';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

let hhmmFmt = null;
function hhmm(t) {
  try {
    hhmmFmt = hhmmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
    return hhmmFmt.format(new Date(t));
  } catch {
    return new Date(t).toISOString().slice(11, 16) + ' UTC';
  }
}

const px = v => (v == null || !Number.isFinite(v) ? '—' : String(+v.toPrecision(6)));
const pct = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(d)}%`);
const r1 = v => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));

function usd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v), sg = v > 0 ? '+' : v < 0 ? '−' : '';
  if (a >= 1e9) return `${sg}${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${sg}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sg}${(a / 1e3).toFixed(0)}K`;
  return `${sg}${a.toFixed(0)}`;
}

function dur(ms) {
  if (!(ms > 0)) return '—';
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}s ${m % 60}dk` : `${m}dk`;
}

const pa = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `%${Math.abs(v).toFixed(d)}`);
const ps = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}%${Math.abs(v).toFixed(d)}`);
const updown = (v, d = 1) => (v == null || !Number.isFinite(v) ? '—' : `${pa(v, d)} ${v >= 0 ? 'yukarıda' : 'aşağıda'}`);

const { circles, dirColor, gradeConds } = require('./infoEngine');

function levelLine(snap, s) {
  const lv = snap.level;
  if (!lv) return `Direnç: %${s.levelMaxPct} içinde yok`;
  return `Direnç: ${esc(lv.name)} ${px(lv.value)} (${lv.dist <= 0 ? `${pa(lv.dist)} kala` : `${pa(lv.dist)} üstünde`})`;
}

const TF_TR = { '3m': '3dk', '5m': '5dk', '15m': '15dk' };
function rsiLines(sn) {
  return [
    ...['3m', '5m', '15m'].map(tf => `RSI ${TF_TR[tf]}: ${r1(sn.rsi[tf].v)}`),
    `RSI 1s: ${r1(sn.conf?.h1)}`,
    `RSI 4s: ${r1(sn.conf?.h4)}`,
  ];
}

/**
 * Hedef satırı — snap.sepPct üzerinden
 */
function targetLine(snap, price) {
  const items = ['3m', '5m'].map(tf => {
    const p = snap.sepPct?.[tf];
    if (p == null || !Number.isFinite(p)) return null;
    return { tf, d: -p };
  }).filter(Boolean);
  if (!items.length) return null;
  const side = d => (d <= 0 ? 'aşağıda' : 'yukarıda');
  const same = items.every(x => side(x.d) === side(items[0].d));
  return `<b>Hedef:</b> ${items.map(x => `${x.tf.replace('m', 'dk')} EMA21 ${pa(x.d, 1)}${same ? '' : ` ${side(x.d)}`}`).join(' · ')}${same ? ` ${side(items[0].d)}` : ''}`;
}

function tgLinks(sym) {
  return [
    { text: '📈 TradingView', url: `https://www.tradingview.com/chart/?symbol=BINANCE:${encodeURIComponent(sym)}.P` },
    { text: '🟡 Binance', url: `https://www.binance.com/tr/futures/${encodeURIComponent(sym)}` },
  ];
}

function formatCard(card, s, opt = {}) {
  const { snap } = card;
  const sym = card.symbol;
  const sf = card.trig?.sfp;
  const shownLv = sf ? { name: sf.name, value: sf.value, dist: (card.price - sf.value) / sf.value * 100 } : snap.level;
  const dip = sf ? shownLv.dist >= -s.dipBelowPct && shownLv.dist <= s.dipAbovePct : snap.level?.zone === 'dip';
  const now = opt.now ?? card.t;
  const T = card.trig || {};

  const L = [];
  if (opt.header) L.push(opt.header);
  L.push(card.seq === '–'
    ? `📋 <b>#${esc(sym)} — Anlık durum</b>`
    : `${circles(snap.grade ?? 0, T.sfp || (s.gradeBy ?? 'sart3') !== 'liste' ? 'red' : dirColor(snap.chg))} <b>#${esc(sym)} — RSI</b>`);

  const why = card.seq === '–'
    ? `şart ${snap.ok ? 'sağlanıyor ✅' : `sağlanmıyor (${(snap.fails || []).join(', ') || '—'})`}`
    : T.sfp ? (T.sfp.type === 'wick' ? '⚠️ Sahte kırılım (fitil)' : '⚠️ Sahte kırılım')
      : snap.rsiOk ? `RSI ${s.rsiMin}+`
        : card.inSeries ? 'Seri sürüyor (şart dışı)' : `RSI ${s.rsiMin}+`;
  // sart3'te daireler hep 🔴 (short olgunluğu); "RSI 85+" tetiği, kaçak pompa, 3m/5m RSI ≥ strongRsi ve 15 dk yön yazılmaz (Detay'da)
  const s3 = (s.gradeBy ?? 'sart3') !== 'liste';
  const plain = s3 && card.seq !== '–' && !T.sfp && snap.rsiOk;
  L.push(`🔔: ${[plain ? null : why, card.seq === '–' ? null : `Kart ${card.seq}`, dip ? '⭐ Dirençte' : null].filter(Boolean).join(' · ')}`);
  // Üstte (🔔 altında) yalnız sahte kırılım / fiyat keşfi; hacimli mum ve ⚡ 1 dk hareket kartın altında (saatten önce)
  const special = card.news.filter(n => /^(⚠️ Sahte kırılım|🚀 Fiyat keşfi)/.test(n));
  for (const n of special.slice(0, 2)) L.push(esc(n.replace(/^⚠️ Sahte kırılım(?: \(fitil\))?: /, '')));
  const volLines = card.news.filter(n => /^(⚡|🟢|🔴|⚪)/.test(n)).slice(0, 2);
  L.push(...rsiLines(snap));
  L.push('');
  L.push(levelLine({ level: shownLv, discovery: snap.discovery }, s));
  L.push(`Fiyat: ${px(card.price)}`);
  const fd = snap.funding;
  if (fd && Number.isFinite(fd.rate)) L.push(`Funding: ${ps(fd.rate * 100, 4)}${fd.next ? ` · ${dur(fd.next - (opt.now ?? card.t))} sonra` : ''}`);
  for (const n of volLines) L.push(esc(n));
  L.push(`⏱: ${dayTime(card.t)}`);

  // Detay: başlık → ne değişti → derece → momentum → direnç → hacim → piyasa → short'a karşı → kontrol listesi
  const D = [`📋 <b>#${esc(sym)} — ${card.seq === '–' ? 'Anlık durum' : `Kart ${card.seq}`}</b> · ${dayTime(card.t)} · ${px(card.price)}`];
  const sec = (title, lines) => { const x = lines.filter(Boolean); if (x.length) D.push('', title, ...x); };
  const f1 = v => (Number.isFinite(v) ? v.toFixed(1) : '—');

  // 🆕 Son karttan beri — kartta görünmeyen yenilikler (seri içinde atlanan kapanışların değişiklikleri de burada birikir)
  const shownNews = new Set([...special, ...volLines]);
  sec(card.seq === 1 || card.seq === '–' ? '🆕 <b>Durum</b>' : '🆕 <b>Son karttan beri</b>',
    card.news.filter(n => !shownNews.has(n)).map(n => `• ${esc(n)}`));

  if ((s.gradeBy ?? 'sart3') !== 'liste' && snap.grade > 0) {
    const gc = gradeConds(snap, s), m = b => (b ? '✅' : '▫️');
    const raw = Math.min(4, 1 + gc.sep + gc.h1 + gc.r15 + gc.atr);
    const cap = raw > snap.grade ? (gc.runaway ? 'kaçak pompa' : !snap.level && !T.sfp ? 'direnç yok' : null) : null;
    const sp = snap.sepPct || {};
    sec(`🏅 <b>Derece ${snap.grade}/4</b> ${circles(snap.grade, 'red')}${cap ? ` · ${cap} → en fazla ${snap.grade}` : ''}`, [
      `${m(gc.sep)} EMA21 ayrışma: 3dk ${ps(sp['3m'], 1)} · 5dk ${ps(sp['5m'], 1)} (≥ %${s.sepPct2 ?? 2})`,
      `${m(gc.h1)} 1s RSI ${f1(snap.conf?.h1)} (${s.gradeRsi1h ?? 80}–${s.gradeRsi1hMax ?? 88})`,
      `${m(gc.r15)} 15dk RSI ${f1(snap.rsi?.['15m']?.v)} (≥ ${s.gradeRsi15m ?? 85})`,
      `${m(gc.atr)} 5dk ATR ${pa(snap.atr5Pct)} (≥ %${s.gradeAtr5Pct ?? 1.2})`,
      gc.runaway ? `🚀 Kaçak pompa: 1s RSI ${f1(snap.conf?.h1)} · 4s RSI ${f1(snap.conf?.h4)} — bu durumda tepe çoğu zaman sürdü` : null,
    ]);
  }

  const hot = ['3m', '5m'].filter(tf => snap.rsi?.[tf]?.v >= s.strongRsi);
  const m3 = snap.macd?.['3m'], m5 = snap.macd?.['5m'], m15 = snap.macd?.['15m'];
  const rd = snap.ride, ng = snap.neg || {};
  const negTxt = ['1m', '3m'].filter(tf => ng[tf]?.count >= 1).map(tf => `${tf.replace('m', 'dk')} ${ng[tf].count}`);
  sec('📈 <b>Momentum</b>', [
    Number.isFinite(snap.chg) ? `${snap.chg >= 0 ? '▲' : '▼'} Son ${snap.chgMin ?? 15} dk: ${snap.chg >= 0 ? '+' : '−'}%${Math.abs(snap.chg).toFixed(1)}` : null,
    hot.length ? `🔥 RSI ${s.strongRsi}+: ${hot.map(tf => `${tf.replace('m', 'dk')} ${snap.rsi[tf].v.toFixed(1)}`).join(' · ')}` : null,
    m3 || m5 || m15 ? `MACD: ${[m3 ? `3dk ${esc(m3.text)}` : null, m5 ? `5dk ${esc(m5.text)}` : null, m15 ? `15dk ${esc(m15.text)}` : null].filter(Boolean).join(' · ')}` : null,
    snap.stoch ? `5dk Stoch RSI: ${snap.stoch.k.toFixed(0)}${snap.stoch.cross ? ` (${snap.stoch.cross === 'down' ? 'aşağı' : 'yukarı'} kesti)` : ''}` : null,
    negTxt.length ? `Negatif tepe (fiyat yükseldi, RSI düştü): ${negTxt.join(' · ')}` : null,
    rd ? `3dk EMA21: ${rd.state === 'break' ? `koptu (${rd.dist >= 0 ? '+' : '−'}${Math.abs(rd.dist).toFixed(1)} ATR, son 3 mumda değmedi)` : rd.state === 'ride' ? `izliyor — trend (son ${rd.win} mumun ${rd.recent}'${suffix(rd.recent)} değdi)` : `serbest (${rd.dist >= 0 ? '+' : '−'}${Math.abs(rd.dist).toFixed(1)} ATR)`}` : null,
    snap.vwap ? `Günlük VWAP: ${updown((card.price - snap.vwap.vwap) / snap.vwap.vwap * 100)}` : null,
  ]);

  const tgt = targetLine(snap, card.price), lvd = snap.level, lg = snap.fibLeg, dc = snap.discovery;
  const shownLvKey = lvd ? `${lvd.name}@${lvd.value}` : null;
  const others = (snap.levels || [])
    .filter(l => l.value > card.price && l.kind !== 'fib' && l.kind !== 'swing' && `${l.name}@${l.value}` !== shownLvKey && Math.abs(l.dist) <= 50)
    .sort((a, b) => a.value - b.value).slice(0, 3);
  sec('🎯 <b>Direnç ve hedef</b>', [
    lvd ? levelLine(snap, s) : null,
    lvd && lvd.touches != null ? `Test: ${lvd.touches} kez denendi (4s mumlar, ~100 gün)` : null,
    lvd?.also?.length ? `Çakışma: ${esc(lvd.name)} + ${esc([...new Set(lvd.also)].join(' + '))}` : null,
    lvd?.kind === 'zone' && lvd.zoneInfo ? `Bölge${lvd.zoneInfo.weekly ? ' (haftalık)' : ''}: ${px(lvd.zoneInfo.lo)}–${px(lvd.zoneInfo.hi)} · ${lvd.zoneInfo.touches} temas · son temas ${dmy(lvd.zoneInfo.last)}` : null,
    lvd?.kind === 'trend' && lvd.trend ? `Trend çizgisi: ${px(lvd.trend.a.v)} (${dmy(lvd.trend.a.t)}) → ${px(lvd.trend.b.v)} (${dmy(lvd.trend.b.t)}) · bugün ${px(lvd.trend.value)}` : null,
    lg ? `Fib (1s): ${lg.up ? `dip ${px(lg.lo)} (${dayTime(lg.loT)}) → tepe ${px(lg.hi)} (${dayTime(lg.hiT)})` : `tepe ${px(lg.hi)} (${dayTime(lg.hiT)}) → dip ${px(lg.lo)} (${dayTime(lg.loT)})`}` : null,
    dc ? `🚀 Kırılan: ${esc(dc.broken.name)} ${px(dc.broken.value)} (${pa((card.price - dc.broken.value) / dc.broken.value * 100)} aşağıda)` : null,
    dc ? (dc.above ? `Sonraki direnç: ${esc(dc.above.name)} ${px(dc.above.value)} (${pa((dc.above.value - card.price) / card.price * 100)} yukarıda)` : 'Sonraki direnç: yok') : null,
    dc?.ext.length ? `Fib uzantı: ${dc.ext.map(x => `${x.r} → ${px(x.value)} (+${pa((x.value - card.price) / card.price * 100, 1)})`).join(' · ')}` : null,
    others.length ? `Üstteki dirençler: ${others.map(l => `${esc(l.name)} ${px(l.value)} (${pa(l.dist, 1)})`).join(' · ')}` : null,
    tgt ? `📏 ${tgt}` : null,
  ]);

  const mv = T.move, [wl] = snap.windows || [], bc = snap.bursts?.[wl]?.p1, ms = card.moveStats;
  sec('📊 <b>Hacim ve alış–satış</b>', [
    mv ? `⚡ 1 dk ${ps(mv.pct)} (${px(mv.from)} → ${px(mv.to)})${mv.volX != null ? ` · hacim ${mv.volX.toFixed(1)} kat` : ''}${mv.taker != null ? ` · alış %${mv.taker.toFixed(0)} / satış %${(100 - mv.taker).toFixed(0)}` : ''}` : null,
    ...(snap.vol || []).map(r => `${r.label}: ${usd(r.q).replace('+', '')} $${r.x != null ? ` · ort. ${r.x.toFixed(1)} katı` : ''}${r.buy != null ? ` · alış %${r.buy.toFixed(0)} / satış %${(100 - r.buy).toFixed(0)}` : ''} · net ${usd(r.net)} $`),
    bc ? `Hacimli mum (${wl >= 60 ? `${wl / 60} saat` : `${wl} dk`}): ${bc.buy + bc.sell + bc.neutral ? `${bc.buy} alış · ${bc.sell} satış${bc.neutral ? ` · ${bc.neutral} nötr` : ''}` : 'yok'}` : null,
    ms ? `Bugün 1 dk ≥ %${s.moveAlertPct}: ▲ ${ms.up} · ▼ ${ms.down} · fark ${ms.up - ms.down > 0 ? '+' : ms.up - ms.down < 0 ? '−' : ''}${Math.abs(ms.up - ms.down)}` : null,
  ]);

  const fnd = snap.funding, oi = card.oi && Number.isFinite(card.oi.changePct) ? card.oi.changePct : null;
  sec('🧭 <b>Piyasa</b>', [
    oi != null ? `Açık pozisyon 1s: ${ps(oi, 2)}` : null,
    fnd && Number.isFinite(fnd.rate) ? `Funding: ${ps(fnd.rate * 100, 4)}` : null,
    Number.isFinite(snap.btc1h) ? `BTC 1s: ${ps(snap.btc1h, 2)}` : null,
  ]);

  const cs = snap.counter || {};
  sec("⚠️ <b>Short'a karşı:</b>", [
    cs.hpu ? `• 4s gizli PU — dip ${px(cs.hpu.low1)} → ${px(cs.hpu.low2)} (yükseldi), RSI ${cs.hpu.rsi1.toFixed(1)} → ${cs.hpu.rsi2.toFixed(1)} (düştü)` : null,
    cs.gc ? (cs.gc.state === 'crossed'
      ? `• Günlük golden cross oldu — ${cs.gc.ago === 0 ? 'bugün' : `${cs.gc.ago} gün önce`} (SMA50, SMA200'ün üstüne çıktı)`
      : `• Günlük golden cross yakın — SMA50, SMA200'ün %${cs.gc.gap.toFixed(1)} altında (5 gün önce %${cs.gc.prevGap.toFixed(1)})`) : null,
  ]);

  const ck = snap.check;
  if (ck) {
    const sh = CHECK_SHORT(s), miss = ck.items.filter(it => !it.ok).map(it => sh[it.key] || it.key);
    sec(`📝 <b>Kontrol listesi ${ck.score}/${ck.total}</b> (bilgi; dereceye girmez)`, [
      ...ck.items.filter(it => it.ok).map(it => `✅ ${esc(it.text)}`),
      miss.length ? `▫️ Eksik: ${esc(miss.join(' · '))}` : null,
      ck.warn ? esc(ck.warn) : null,
    ]);
  }

  return { text: L.join('\n'), keyboard: cardKeyboard(card.id, sym, card.followed), details: D.join('\n') };
}

const CHECK_SHORT = s => ({
  daily: 'günlük direnç', confluence: 'çakışan direnç', band: `RSI ${s.strongRsi}–${s.rsiEntryMax}`, rsi15: `15dk ≥ ${s.strongRsi}`,
  rsi5_15: `5dk+15dk ≥ ${s.strongRsi}`, htf: `1s/4s ≥ ${s.confRsi}`, sep: 'EMA21 ayrışma', neg: 'negatif tepe', macd: 'MACD sat kesişimi',
});

function suffix(n) {
  return { 0: 'ında', 1: 'inde', 2: 'sinde', 3: 'ünde', 4: 'ünde', 5: 'inde', 6: 'sında', 7: 'sinde', 8: 'inde', 9: 'unda', 10: 'unda' }[n] ?? 'inde';
}

function cardKeyboard(id, sym, followed) {
  return [
    tgLinks(sym),
    [
      { text: '📋 Detay', callback_data: `d:${id}`.slice(0, 64) },
      { text: '🔕 1s sustur', callback_data: `m:${sym}` },
      { text: followed ? '⭐ Takipte' : '☆ Takip', callback_data: `f:${sym}` },
    ],
  ];
}

function dmy(t) {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(t);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCFullYear()).slice(2)}`;
}

let dmFmt = null;
function dayTime(t) {
  try {
    dmFmt = dmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return dmFmt.format(new Date(t)).replace(',', '').replace(/\//g, '.');
  } catch {
    return new Date(t).toISOString().slice(5, 16).replace('T', ' ');
  }
}

function summaryText(sym, log, price, now = Date.now()) {
  const day = log.filter(x => x.t >= now - 86_400_000);
  if (!day.length) return `${sym}: son 24 saatte kart yok.`;
  let serie = [];
  for (const x of day) { if (x.seq === 1) serie = []; serie.push(x); }
  const first = serie[0] || day[day.length - 1];
  const chg = price && first.price ? (price - first.price) / first.price * 100 : null;
  const s = `${sym} · bu seride ${serie.length} kart (ilk ${hhmm(first.t)}, ${px(first.price)}) · şimdi ${px(price)} (${pct(chg)}) · 24 saatte ${day.length} kart`;
  return s.slice(0, 200);
}

function toPlain(html) {
  return html.replace(/<blockquote expandable>/g, '▸ (dokununca açılır)\n').replace(/<\/blockquote>/g, '')
    .replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

module.exports = { formatCard, summaryText, toPlain, esc, hhmm, dayTime, px, pct, usd, cardKeyboard };
