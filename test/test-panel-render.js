'use strict';
// Panel veri eşlemesi: src/panel/app.js'teki saf render fonksiyonları örnek kayıtlarla.
// Kart alanları infoStats.compact + cardStore.rowToStat biçiminde (RSI "—" olmamalı), temas etiketi held anlamına uygun,
// yarım takip "eksik", emir / kazanç-kayıp dili yok, derece daireleri Telegram'la aynı, saatler TSİ, rol görünürlüğü.

const assert = require('assert');
const P = require('../src/panel/app.js');
const { circles: tgCircles } = require('../src/infoEngine');

const T0 = Date.UTC(2026, 10, 25, 11, 5);   // 25.11.2026 14:05 TSİ
const strip = s => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const ORDER_WORDS = /SATIŞ \/ DİRENÇ|ALIM PATLAMASI|\bLONG\b|\bSHORT\b|\bAL\b|\bSAT\b/;
const PNL_WORDS = /kâr|kar\b|zarar|kazanç|kayıp|pozisyon|giriş yap|stop loss/i;

// ── Örnek kart (infoStats.compact + rowToStat) ──
const card = {
  kind: 'card', symbol: 'ABCUSDT', t: T0, time: '2026-11-25 11:05', seq: 2, grade: 3, price: 1.2345, silent: false, inSeries: false,
  news: ['🔴 Hacimli düşen mum: −%1.2 · hacim 3.1 kat · satış %62'], tags: [],
  rsi: { '3m': 91.23, '5m': 88.4, '15m': 86.1 }, hits: 3,
  level: { name: '7g tepe', value: 1.24, dist: -0.444, zone: 'dip', touches: 3 },
  burst: { grade: 2, dir: 'sell', body: -1.2, volX: 3.1, taker: 38 }, trigTFs: ['3m', '5m'], move: null, sfp: null, discovery: null,
  levelKind: 'swing', sepOk: true, conf: 2, checkScore: 5, checkOk: ['rsi15'], neg1m: 1, neg3m: 2, rsi1h: 82.5, rsi4h: 71.2,
  sep3: 3.4, sep5: 2.1, atr5Pct: 1.31, funding: 0.0123, oiChg60: 4.2, btc1h: -0.35, trend_1h: null,
  gradeOld: 2, g_sep: 1, g_h1: 1, g_r15: 1, g_atr: 0, g_macd: 0, g_stoch: 0, g_rsi3hi: 1, g_runaway: 0,
  cfgGradeRsi15m: 85, cfgGradeAtr5Pct: 1.2, cfgGradeMacd5m: 1, cfgGradeStoch5m: 1, cfgSepPct2: 3, cfgGradeRsi3m: 90, gradeVer: 2,
  fwd: { 5: { low: -0.6, high: 0.2, close: -0.42 }, 15: { low: -1.8, high: 0.2, close: -1.1 } },
  partial: false, done: false,
};

const now = T0 + 20 * 60_000;
const html = P.renderCard(card, now);
const text = strip(html);
// RSI alanları kayıttan okunur (eski panel d.rsi.val okuyup hep "—" gösteriyordu)
for (const v of ['91.2', '88.4', '86.1', '82.5', '71.2']) assert(text.includes(v), `RSI ${v} shown: ${text}`);
assert(!/RSI 3dk\s+—/.test(text), 'RSI 3dk must not be "—"');
// Derece: Telegram'daki circles() ile birebir (sart3 → 🔴)
assert(html.includes(tgCircles(3, 'red')), 'grade 3 → 🔴🔴🔴 as in Telegram');
assert.strictEqual(P.circles(3), tgCircles(3, 'red'));
assert.strictEqual(P.circles(0), tgCircles(0, 'red'), 'grade 0 → ⚪');
assert.strictEqual(P.circles(2, 'green'), tgCircles(2, 'green'));
// Nötr dil
assert(text.includes('⭐ Dirençte'), 'zone dip → "⭐ Dirençte"');
assert(text.includes('Seviye: 7g tepe 1.24 (%0.44 kala)'), 'level line is neutral "Seviye: …": ' + text);
assert(!ORDER_WORDS.test(text), 'no order-like labels: ' + text);
assert(!PNL_WORDS.test(text), 'no profit/loss language: ' + text);
// Ayrışma, ATR, sesli, şart bayrakları
assert(text.includes('3dk +%3.4') && text.includes('5dk +%2.1'), 'EMA21 separation from sep3/sep5');
assert(text.includes('5dk ATR %1.31'), 'ATR from atr5Pct');
assert(text.includes('🔔 sesli'), 'silent=false → sesli');
assert(html.includes('flag on') && text.includes('15dk RSI ≥ 85') && text.includes('derece v2 · eski formül 2'), 'grade v2 flags shown');
assert.deepStrictEqual(P.gradeFlags(card).filter(f => f.ok).map(f => f.key), ['g_sep', 'g_h1', 'g_r15', 'g_rsi3hi']);
// Kart sonrası: yalnız fiyat değişimi, %; dolmayan pencere "bekliyor"
assert(text.includes('−%0.42') && text.includes('−%1.10'), 'fwd 5/15 close change shown as %');
assert.strictEqual(P.fmtFwd(card.fwd, 30, false, T0, now).text, 'bekliyor', '30 dk not elapsed yet');
assert.strictEqual(P.fmtFwd(card.fwd, 30, false, T0, T0 + 300 * 60_000).text, '—', 'elapsed but missing (not partial) → —');
assert.strictEqual(P.fmtFwd(card.fwd, 5, false, T0, now).cls, 'dn', 'down move class');
assert(!/kâr|zarar/i.test(P.fmtFwd(card.fwd, 5).title));
// Saat TSİ
assert(text.includes('25.11 14:05'), 'time shown in TSİ: ' + text);
assert.strictEqual(P.fmtTime(T0), '25.11 14:05');
assert.strictEqual(P.fmtClock(T0 + 7000), '14:05:07');

// partial → "eksik"
const part = { ...card, partial: true, fwd: { 5: { low: -0.1, high: 0.1, close: 0 } } };
const ph = strip(P.renderCard(part, T0 + 600 * 60_000));
assert(/\beksik\b/.test(ph), 'partial card shows "eksik"');
assert.strictEqual(P.fmtFwd(part.fwd, 60, true, T0, now).text, 'eksik', 'missing window of partial card → eksik');
assert.strictEqual(P.fmtFwd(part.fwd, 5, true, T0, now).text, '%0.00', 'recorded window stays even if partial');

// Eski panelin emir etiketi (alım patlaması dışında "SATIŞ / DİRENÇ") yok; alım patlamasında da yok
const buy = P.renderCard({ ...card, burst: { ...card.burst, dir: 'buy' }, news: [] }, now);
assert(!ORDER_WORDS.test(strip(buy)), 'buy burst card has no order label');
// PR #24 alanları varsa "filtre dışı"
assert(strip(P.renderCard({ ...card, snapOk: false, filterBypass: true, bypassBy: 'grade4' }, now)).includes('filtre dışı'));
assert(!strip(html).includes('filtre dışı'), 'no bypass badge without the field');
// Seviye yok / fiyat keşfi
assert(strip(P.renderCard({ ...card, level: null, discovery: { broken: '30g tepe' } }, now)).includes('Fiyat keşfi: 30g tepe kırıldı'));
// Eksik alanlar çökertmez, uydurulmaz
const bare = strip(P.renderCard({ symbol: 'XUSDT', t: T0, price: 2, rsi: {}, fwd: {} }, now));
assert(bare.includes('RSI 3dk —') && bare.includes('⚪'), 'missing values render as —, grade 0 as ⚪');
// XSS: sembol ve haber satırı kaçışlanır
const xss = P.renderCard({ ...card, symbol: '<img src=x onerror=alert(1)>', news: ['<script>x</script>'] }, now);
assert(!/<img|<script/.test(xss), 'card fields are escaped');
// Bellek kaydı (SQLite kapalı): Telegram metni beyaz listeyle
const mem = P.renderCard({ kind: 'card', text: '<b>#ABC</b><img src=x>', t: T0 }, now);
assert(mem.includes('<b>#ABC</b>') && !mem.includes('<img'), 'memory dispatch shown via tgHtml');

// ── Temas etiketi: held = 60. dk kapanışı seviyenin üstünde ──
assert.deepStrictEqual(P.touchLabel(true), { text: 'Kırıp üstte kaldı', cls: 'warn' });
assert.deepStrictEqual(P.touchLabel(false), { text: 'Altında kaldı (ret)', cls: 'accent' });
const touch = { id: 't1', symbol: 'ABCUSDT', t: T0, name: '1h tepe', kind: 'swing', value: 1.5, hits: 2, rsiOk: false, card: false,
  pb: 1.234, pbMin: 12, held: true, up: 0.8, dn: -1.5, c60: 0.4, lvTouches: 4 };
const tr = strip(P.renderTouchRow(touch));
assert(tr.includes('Kırıp üstte kaldı') && !/TUTUNDU|KIRILDI/.test(tr), 'held=true → "Kırıp üstte kaldı": ' + tr);
assert(strip(P.renderTouchRow({ ...touch, held: false })).includes('Altında kaldı (ret)'));
assert(tr.includes('4 test') && tr.includes('2/3') && tr.includes('%1.23') && tr.includes('+%0.40'), 'touch columns: ' + tr);
assert(!/ok|green/.test(P.touchLabel(false).cls), 'rejection is not colored as a win');

// ── Tepe defteri ──
assert.deepStrictEqual(P.outcomeLabel('düştü'), { text: 'Düştü', cls: 'accent' });
assert.strictEqual(P.outcomeLabel('devam').text, 'Devam etti');
assert.strictEqual(P.outcomeLabel('<x>').text, '<x>', 'unknown outcome passes through (escaped at render)');
const ev = { id: 'ev1', symbol: 'ABCUSDT', t: T0, price: 1.3, outcome: 'düştü', dropT: T0 + 4 * 60_000, dropMin: 4, card: true, cardGrade: 3,
  out: { 15: { low: -3.2, high: 0.1, close: -2.4 }, 60: { low: -5, high: 0.1, close: -4.1 } },
  feat: { grade: 2, gradeVer: 2, rsi3: 93.1, rsi5: 90.2, rsi15: 85.7, pumpPct: 7.4, pumpMin: 38, g_sep: 1, g_h1: 0, v3S: 4, v3B: 1, v3_atr: 1, unknownKey: 'x<y' },
  hasPath: true };
const er = strip(P.renderEventRow(ev));
assert(er.includes('Düştü') && er.includes(tgCircles(3, 'red')) && er.includes('93/90/86') && er.includes('−%3.20') && er.includes('−%4.10'), 'event row: ' + er);
assert(er.includes('v3S 4 · v3B 1'), 'v3 summary');
const ed = P.renderEventDetail(ev);
assert(ed.includes('gölge') && strip(ed).includes('v3_atr'), 'v3 keys listed under "gölge"');
assert(ed.includes('x&lt;y') && !ed.includes('x<y'), 'unknown feat values escaped');
assert(!PNL_WORDS.test(strip(ed)) && !ORDER_WORDS.test(strip(ed)));
assert(strip(P.renderEventRow({ ...ev, card: false, feat: {} })).includes('yok'), 'no card → "yok"');

// Yol grafiği: ham fiyat → tepe fiyatına göre %
const svg = P.pathSvg({ id: 'ev1', symbol: 'ABCUSDT', t: T0, entry: 100, n: 3, bars: [{ h: 100.5, l: 99, c: 99.5 }, { h: 99.8, l: 97, c: 97.5 }, { h: 98, l: 96, c: 96.5 }] }, { width: 400, dropMin: 2 });
assert(/^<svg class="pathchart"/.test(svg) && svg.includes('<polyline') && (svg.match(/<circle/g) || []).length === 3, 'svg with 3 closes');
assert(svg.includes('3/15 dk kayıtlı') && svg.includes('uydurulmaz'), 'partial path noted');
assert(svg.includes('düşüş'), 'drop marker');
assert(!/<script|on[a-z]+=/i.test(svg), 'svg has no script / handlers (CSP)');
assert(P.pathSvg({ entry: 0, bars: [] }).includes('Yol verisi yok'));

// ── Kapsam şeridi ──
const cov = { oldestCard: T0, oldestEvent: T0 - 3600_000, oldestTouch: null, lastWeeklySlot: Date.UTC(2026, 10, 24, 0, 1), nextWeeklySlot: Date.UTC(2026, 11, 1, 0, 1) };
assert.strictEqual(P.coverageText(cov, 'simdi'), "Kayıtlar 25.11 14:05 TSİ'den beri · son haftalık rapor 24.11 03:01 · sonraki 01.12 03:01 TSİ");
assert(P.coverageText(cov, 'tepe').startsWith("Kayıtlar 25.11 13:05 TSİ'den beri"));
assert(P.coverageText(cov, 'seviye').startsWith('Kayıt yok'));
assert(P.coverageText(cov, 'sistem').startsWith("Kayıtlar 25.11 13:05"), 'other pages: oldest of all');
assert(P.coverageText(null, 'simdi').includes('bilinmiyor'));
assert(P.EMPTY_NOTE.includes('Haftalık rapordan sonra kayıtlar silinir'));

// ── Botlar: yerel motorun sabit "son sinyal" metni ve sahte nabzı gösterilmez ──
const bots = P.renderBots([
  { id: 'scalp-primary', type: 'local', name: 'Ana', telegram: '@x', isOnline: true, lastSignal: 'RSI ≥ 85 · SFP & Seviye Motoru', lastSeenSecondsAgo: 0, metrics: { a: '1' } },
  { id: 'r', type: 'remote', name: 'Uzak', isOnline: false, lastSignal: 'BTC durum', lastSeenSecondsAgo: 300, metrics: {} },
]);
assert(!bots.includes('RSI ≥ 85') && !bots.includes('0 sn önce'), 'local bot: no fixed signal text / fake heartbeat');
assert(bots.includes('5 dk önce') && bots.includes('BTC durum'));
// Webhook örneği nötr
const wh = P.webhookExample('https://ornek');
assert(!/LONG|Kâr|Açık İşlem|Pozisyon/.test(wh), 'webhook example uses neutral language');

// ── Rol görünürlüğü: üye yönetici bölümlerini görmez, o uçları çağırmaz ──
const mbr = P.visibleSections('member');
assert.deepStrictEqual(mbr.subs, ['saglik']);
for (const k of ['logs', 'logDays', 'bots', 'settings']) assert(!mbr.keys.includes(k), `member must not poll ${k}`);
assert(mbr.keys.includes('status') && mbr.keys.includes('cards') && mbr.keys.includes('events'));
assert.strictEqual(mbr.label, 'Üye');
const adm = P.visibleSections('admin');
assert.deepStrictEqual(adm.subs, ['saglik', 'loglar', 'botlar', 'ayarlar', 'webhook']);
assert(adm.keys.includes('logs') && adm.keys.includes('settings') && adm.label === 'Yönetici');
for (const r of [undefined, null, '', 'Admin', 'root']) assert.deepStrictEqual(P.visibleSections(r).subs, ['saglik'], `unknown role ${r} → member view`);

// ── Polling aralıkları (ARAYÜZ) ──
assert.deepStrictEqual([P.INTERVALS.status, P.INTERVALS.cards, P.INTERVALS.events, P.INTERVALS.touches, P.INTERVALS.flow, P.INTERVALS.logs, P.INTERVALS.logDays],
  [15000, 60000, 60000, 60000, 60000, 10000, 300000]);

// ── Panel ek bölümleri (25.11.2026): Takip, Piyasa, Coin, 📋 Detay, kart türü, dar ekran etiketleri ──
const neutral = (h, what) => { const t = strip(h); assert(!ORDER_WORDS.test(t) && !PNL_WORDS.test(t), what + ' neutral: ' + t); };
// Kart: coin bağlantısı ve 📋 Detay düğmesi (yalnız id varsa)
const withId = P.renderCard({ ...card, id: 'ABCUSDT-1764068700000' }, now);
assert(withId.includes('data-coin="ABCUSDT"') && withId.includes('data-detail="ABCUSDT-1764068700000"') && withId.includes('📋 Detay'), 'card links coin + detail');
assert(!html.includes('data-detail='), 'no detail button without id');
assert(P.renderCard({ ...card, id: '"><img src=x>' }, now).includes('&quot;&gt;&lt;img'), 'card id escaped in attributes');
// Eski ⚡ kaydı (kind=move) sade gösterilir, çökmez
const mv = strip(P.renderCard({ kind: 'move', symbol: 'XUSDT', t: T0, price: 2, movePct: -2.5, fwd: { 5: { low: -1, high: 0, close: -0.5 } } }, now));
assert(mv.includes('⚡ 1 dk hareket uyarısı (eski kayıt)') && mv.includes('−%2.50') && mv.includes('−%0.50'), 'old move record: ' + mv);
// Kart türleri
assert.deepStrictEqual(P.cardTypes(card), ['burst', 'dip']);
assert.deepStrictEqual(P.cardTypes({ move: { pct: 2 }, sfp: { type: 'wick' }, inSeries: true, filterBypass: true, discovery: { broken: 'x' } }), ['move', 'sfp', 'disc', 'series', 'bypass']);
assert.deepStrictEqual(P.cardTypes(null), []);
// Dar ekran: her hücrede data-l etiketi (tablo → satır kartı)
for (const [name, rowHtml, n] of [['touch', P.renderTouchRow(touch), 11], ['event', P.renderEventRow(ev), 11], ['flow', P.renderFlowRow({ symbol: 'ABCUSDT', vol: 1e6, buyPct: 52, chg: 1, windows: {} }), 10]]) {
  assert.strictEqual((rowHtml.match(/<td[^>]* data-l="/g) || []).length, n, name + ' cells carry data-l labels');
}
// Takipteki kart: dolan pencere ✓, sıradaki pencereye kalan süre, yalnız fiyat değişimi
const ot = P.renderOpenTrack({ id: 'a', symbol: 'ABCUSDT', t: T0, price: 2, chg: -1.2, low: -1.8, high: 0.4, done: [5, 15] }, T0 + 22 * 60_000);
const ots = strip(ot);
assert(ots.includes('5 dk ✓') && ots.includes('15 dk ✓') && ots.includes('30 dk · 8 dk kaldı') && ots.includes('−%1.20') && ots.includes('−%1.80 / +%0.40'), 'open track: ' + ots);
assert(ots.includes('22 dk önce'));
neutral(ot, 'open track');
// Seri, ⚡ sayacı, takip / susturma
const si = strip(P.renderSeriesItem({ symbol: 'ABCUSDT', seq: 2, cards24h: 3, lastT: T0, lastPrice: 1.5, maxGrade: 3 }));
assert(si.includes(tgCircles(3, 'red')) && si.includes('Kart 2') && si.includes('24 s: 3 kart') && si.includes('25.11 14:05'), 'series: ' + si);
assert(strip(P.renderMoveItem({ symbol: 'X', up: 2, down: 1 })).includes('▲ 2 ▼ 1'));
const wl = strip(P.renderWatch(['ABCUSDT'], [{ symbol: 'DEFUSDT', until: T0 }]));
assert(wl.includes('ABCUSDT') && wl.includes('DEFUSDT bitiş 25.11 14:05 TSİ'), 'watch: ' + wl);
assert(strip(P.renderWatch([], [])).includes('Takipte coin yok'));
assert(P.renderWatch(['<b>x'], []).includes('&lt;b&gt;x'), 'watch escapes');
// Piyasa: veri yoksa "—" (0 uydurulmaz)
const mk = strip(P.marketKpiHtml({ breadth80: 12.4, pumping: 7, btc5: -0.12, btc15: 0.34, btcRsi15: 55.2 }));
assert(mk.includes('%12.4') && mk.includes('7 coin') && mk.includes('−%0.12 / +%0.34') && mk.includes('55.2'), 'market kpis: ' + mk);
const mk0 = strip(P.marketKpiHtml({ breadth80: null, pumping: null, btc5: null, btc15: null, btcRsi15: null }));
assert(!/\b0 coin|%0\.0\b/.test(mk0) && mk0.includes('—'), 'missing market state shown as —: ' + mk0);
const big = P.renderBigRow({ symbol: 'ABCUSDT', buyN: 3, buyUsd: 90000, sellN: 1, sellUsd: 20000, netUsd: 70000, totalUsd: 110000 });
assert(strip(big).includes('3 · 90.0K') && strip(big).includes('70.0K') && strip(big).includes('110.0K'), 'big row');
neutral(big, 'big row');
const fr1 = strip(P.renderFundingRow({ symbol: 'ABCUSDT', ratePct: -0.0125, next: T0 }));
assert(fr1.includes('ABC') && fr1.includes('−%0.0125'), 'funding row: ' + fr1);
assert(strip(P.renderFundingRow({ symbol: 'XUSDT', ratePct: null, next: null })).includes('—'), 'missing funding shown as —');
const lq = strip(P.renderLiqRow({ symbol: 'ABCUSDT', liqShort15: 1000, liqShort60: 2000, liqLong15: 0, liqLong60: 500 }));
assert(lq.includes('1.0K / 2.0K') && lq.includes('0 / 500'), 'liq row: ' + lq);
// Coin: arama normalizasyonu (sunucu panelSymbol ile aynı), özet, mini tepe satırı, akış ayrıntısı
assert.strictEqual(P.normSym('eth'), 'ETHUSDT');
assert.strictEqual(P.normSym(' 1000pepe '), '1000PEPEUSDT');
assert.strictEqual(P.normSym('SOLUSDT'), 'SOLUSDT');
assert.strictEqual(P.normSym('<>!'), null);
assert.strictEqual(P.normSym(''), null);
const cs = strip(P.coinSummaryHtml({ watched: true, followed: true, mutedUntil: T0 + 3600_000, series: { seq: 2, cards24h: 2, maxGrade: 3 }, moves: { up: 1, down: 0 }, liq: { liqShort60: 2000, liqLong60: 0 }, open: [{}], big: { day: { buyN: 3, buyUsd: 9e4, sellN: 1, sellUsd: 2e4 } } }, T0));
assert(cs.includes('⭐ takipte') && cs.includes('🔕 25.11 15:05') && cs.includes('kart 2') && cs.includes('▲ 1 · ▼ 0') && cs.includes('2.0K / 0') && cs.includes('3 (90.0K) / 1 (20.0K)'), 'coin summary: ' + cs);
assert(strip(P.coinSummaryHtml({ watched: false })).includes('hayır'), 'unwatched coin');
const me = strip(P.renderMiniEvent(ev));
assert(me.includes('Düştü') && me.includes('15 dk dip −%3.20') && me.includes('60 dk −%4.10'), 'mini event: ' + me);
assert(P.flowDetailHtml(null).includes('akış verisi yok'));
const fdh = P.flowDetailHtml({ windows: { '1d': { spot: { key: 'birikim', strength: 'güçlü', vol: 1e6, buyPct: 55, net: 1e5, priceChg: 1.2, cvdPct: 3 }, futures: null, big: { buyN: 2, sellN: 1 } } }, bigThreshold: 5000, history: [] });
assert(strip(fdh).includes('Toplanıyor ●') && strip(fdh).includes('2 / 1') && fdh.includes('data-l="Pencere"'), 'flow detail');
assert(strip(P.renderBigHours([{ t: T0, buyN: 2, buyUsd: 3e4, sellN: 0, sellUsd: 0 }])).includes('alım 2 (30.0K)'));
// Ek veri akışları
const fd = strip(P.renderFeeds({ liq: { messages: 12, symbols: 3, reconnects: 0 }, bigTrades: null, flow: { universe: 2, requests: 5, errors: 1 }, enricher: { ok: 1, skipped: 0, errors: 0 }, openTracks: 4, details: 10 }));
assert(fd.includes('12 mesaj') && fd.includes('Spot büyük işlem akışı kapalı') && fd.includes('2 parite') && fd.includes('10 / 3000'), 'feeds: ' + fd);
// Sayfalar ve yeni uç anahtarları üyede de var (yönetici-özel değil)
assert.deepStrictEqual(P.TABS, ['simdi', 'takip', 'piyasa', 'tepe', 'seviye', 'akis', 'rapor', 'sistem']);
assert(P.PAGES.includes('coin') && !P.TABS.includes('coin'));
for (const k of ['tracking', 'market', 'coin', 'feeds']) assert(mbr.keys.includes(k), 'member polls ' + k);

console.log('PASS: panel render (card fields, grade circles, fwd/eksik, touch labels, events, path svg, coverage, roles, takip/piyasa/coin/detay)');
