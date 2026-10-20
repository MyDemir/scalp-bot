'use strict';
// Spot/futures akış takibi (src/spotFlow.js): pencere zamanları, sınıflandırma, ilk yükleme + kapanış güncellemesi,
// spotu olmayan coin, etiket değişikliği kaydı, /akis metni ve CSV dışa aktarma.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createSpotFlow, classify, windowStart, lastClosedStart, flowText, changesText, HISTORY } = require('../src/spotFlow');
const { buildExports } = require('../src/exportData');

const HOUR = 3_600_000, DAY = 86_400_000;
const R = []; const ok = s => R.push('✅ ' + s);

// ── Pencere zamanları ──
const t0 = Date.UTC(2026, 9, 21, 13, 17);                       // Çarşamba
assert.strictEqual(windowStart('4h', t0), Date.UTC(2026, 9, 21, 12));
assert.strictEqual(lastClosedStart('4h', t0), Date.UTC(2026, 9, 21, 8));
assert.strictEqual(windowStart('1w', t0), Date.UTC(2026, 9, 19));     // Pazartesi
assert.strictEqual(lastClosedStart('1w', t0), Date.UTC(2026, 9, 12));
assert.strictEqual(windowStart('1M', t0), Date.UTC(2026, 9, 1));
assert.strictEqual(lastClosedStart('1M', t0), Date.UTC(2026, 8, 1));
assert.strictEqual(lastClosedStart('1M', Date.UTC(2026, 0, 3)), Date.UTC(2025, 11, 1));
ok('Pencere zamanları: 4s, Pazartesi haftası, ay başı (yıl dönümü dahil)');

// ── Sınıflandırma ──
const rows = (n, { buy = 0.5, step = 0, vol = 1000, lastVol = null } = {}) => Array.from({ length: n }, (_, i) => {
  const open = 100 * (1 + step) ** i, close = open * (1 + step);
  const v = i === n - 1 && lastVol != null ? lastVol : vol;
  return { t: i * 4 * HOUR, vol: v, buy: v * buy, open, close };
});
assert.strictEqual(classify(rows(20, { buy: 0.56, step: 0 }), '4h').key, 'birikim');          // fiyat yatay, CVD +%12
assert.strictEqual(classify(rows(20, { buy: 0.56, step: -0.01 }), '4h').key, 'birikim');      // fiyat düşerken net alış
assert.strictEqual(classify(rows(20, { buy: 0.56, step: 0.01 }), '4h').key, 'trendUp');
assert.strictEqual(classify(rows(20, { buy: 0.44, step: 0.01 }), '4h').key, 'dagitim');       // fiyat yükselirken net satış
assert.strictEqual(classify(rows(20, { buy: 0.44, step: 0 }), '4h').key, 'dagitim');
assert.strictEqual(classify(rows(20, { buy: 0.44, step: -0.01 }), '4h').key, 'trendDown');
assert.strictEqual(classify(rows(20, { buy: 0.505, step: 0.01 }), '4h').key, 'notr');         // CVD +%1 < %3
const few = classify(rows(3, { buy: 0.6 }), '4h');
assert(!few.enough && few.key === null && few.label === 'Veri az');
const strong = classify(rows(25, { buy: 0.6, lastVol: 2000 }), '4h');
assert.strictEqual(strong.volX, 2); assert.strictEqual(strong.strength, 'güçlü'); assert.strictEqual(strong.buyPct, 60);
assert.strictEqual(classify(rows(25, { buy: 0.6, lastVol: 500 }), '4h').strength, 'zayıf hacim');
assert.strictEqual(classify(rows(20, { buy: 0.52 }), '4h', { flowCvdPct: 3 }).key, 'birikim');  // CVD +%4
assert.strictEqual(classify(rows(20, { buy: 0.52 }), '4h', { flowCvdPct: 5 }).key, 'notr');     // ayar eşiği
ok('Sınıflandırma: Toplanıyor / Dağıtım / Trend teyitli (alım·satış) / Nötr, veri az, hacim katı (güçlü / zayıf), ayar eşiği');

// ── Canlı akış: sahte spot + futures ──
const TF_MS = { '4h': 4 * HOUR, '1d': DAY, '1w': 7 * DAY };
const span = (tf, t) => (tf === '1M' ? Date.UTC(new Date(t).getUTCFullYear(), new Date(t).getUTCMonth() + 1, 1) - t : TF_MS[tf]);
let now = Date.UTC(2026, 9, 21, 12, 5);                          // 4s penceresi 12:00'de kapandı, 5 dk geçti
// Spot 4s: 21.10 00:00'dan itibaren satış ağırlıklı (%44), öncesi alış (%56); futures hep alış
const SELL_FROM = Date.UTC(2026, 9, 21);
const ratioAt = (market, tf, t) => (market === 'spot' && tf === '4h' && t >= SELL_FROM ? 0.44 : 0.56);
function klines(market, tf, limit) {
  const starts = [windowStart(tf, now)];                       // devam eden pencere de gelir (Binance gibi)
  while (starts.length < limit) starts.unshift(windowStart(tf, starts[0] - 1));
  return starts.map(t => {
    const vol = 1000, buy = vol * ratioAt(market, tf, t);
    return [t, '1', '1', '1', '1', '0', t + span(tf, t) - 1, String(vol), 10, '0', String(buy)];
  });
}
const reqs = { spot: [], futures: [] };
const fetchFn = async url => {
  const u = new URL(url);
  const sym = u.searchParams.get('symbol'), tf = u.searchParams.get('interval'), limit = Number(u.searchParams.get('limit'));
  reqs.spot.push(`${sym} ${tf} ${limit}`);
  if (sym === 'NOSPOTUSDT') return { ok: false, status: 400, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => klines('spot', tf, limit) };
};
const futuresKlines = async (sym, tf, limit) => { reqs.futures.push(`${sym} ${tf} ${limit}`); return klines('futures', tf, limit); };

const dir = path.join(__dirname, '.tmp', 'spot-flow');
fs.rmSync(dir, { recursive: true, force: true });
const quiet = { log() {}, warn() {}, error() {} };
let syms = ['ETHUSDT', 'NOSPOTUSDT', '1000PEPEUSDT'];
const flow = createSpotFlow({ file: path.join(dir, 'flow.db'), fetchFn, futuresKlines, getSymbols: () => syms, getSettings: () => ({}), spotGapMs: 0, now: () => now, logger: quiet });

(async () => {
  assert(flow.enabled());
  let r = await flow.tick();
  assert.deepStrictEqual(r.changed, []);
  assert(reqs.spot.includes(`ETHUSDT 4h ${HISTORY['4h'] + 1}`) && reqs.spot.includes('ETHUSDT 1M 13'));
  assert(reqs.spot.includes('PEPEUSDT 1d 61'), '1000PEPE → spot PEPE');
  assert.strictEqual(reqs.futures.length, 3 * 4);
  // Devam eden pencere kaydedilmez: 4s'te 120 kapanmış satır
  assert.strictEqual(flow.rowsOf('ETHUSDT', 'spot', '4h', 500).length, HISTORY['4h']);
  assert.strictEqual(flow.rowsOf('ETHUSDT', 'spot', '1M', 500).length, HISTORY['1M']);
  assert(!flow.hasSpot('NOSPOTUSDT') && flow.hasSpot('ETHUSDT'));
  assert.strictEqual(flow.rowsOf('NOSPOTUSDT', 'spot', '4h').length, 0);
  let sm = flow.summary('ETHUSDT');
  assert.strictEqual(sm['4h'].main, 'spot'); assert.strictEqual(sm['4h'].spot.key, 'notr');   // son 6: 3 alış + 3 satış
  assert.strictEqual(sm['1d'].spot.key, 'birikim'); assert.strictEqual(sm['4h'].futures.key, 'birikim');
  assert.strictEqual(flow.summary('NOSPOTUSDT')['1d'].main, 'futures');
  ok(`İlk yükleme: coin başına 4 pencere geçmişi (spot ${reqs.spot.length} + futures ${reqs.futures.length} istek), devam eden pencere yok, 1000PEPE → PEPE spot, spotu olmayan coin hatırlanıyor`);

  // Aynı pencere içinde tekrar tur: istek yok
  const n0 = reqs.spot.length + reqs.futures.length;
  now += 10 * 60_000;
  r = await flow.tick();
  assert.deepStrictEqual(r.due, []); assert.strictEqual(reqs.spot.length + reqs.futures.length, n0);

  // 16:00 kapanışı: kesinleşme payı (90 sn) dolmadan çekilmez, sonra yalnız 4s güncellenir (son 3 mum)
  now = Date.UTC(2026, 9, 21, 16, 0, 30);
  r = await flow.tick();
  assert.deepStrictEqual(r.due, []);
  now = Date.UTC(2026, 9, 21, 16, 2);
  r = await flow.tick();
  assert.deepStrictEqual(r.due, ['4h']);
  assert(reqs.spot.slice(-2).every(x => x.endsWith(' 4h 3')));
  assert.strictEqual(flow.rowsOf('ETHUSDT', 'spot', '4h', 500).length, HISTORY['4h'] + 1);
  ok('Kapanış güncellemesi: aynı pencerede istek yok, kapanıştan 90 sn sonra yalnız biten pencere (son 3 mum, upsert)');

  // 12:00 penceresi de satışla kapandı → son 6: 2 alış + 4 satış → CVD −%4 → Dağıtım
  assert(r.changed.some(c => c.symbol === 'ETHUSDT' && c.tf === '4h' && c.old === 'notr' && c.new === 'dagitim'));
  now = Date.UTC(2026, 9, 21, 20, 2); await flow.tick();
  now = Date.UTC(2026, 9, 22, 0, 2); r = await flow.tick();
  assert(r.due.includes('4h') && r.due.includes('1d'));
  sm = flow.summary('ETHUSDT');
  assert.strictEqual(sm['4h'].spot.key, 'dagitim');
  assert(sm['4h'].diverge, 'spot satış + futures alış = ayrışma');
  const ch = flow.changes({ symbol: 'ETHUSDT' });
  assert.deepStrictEqual(ch.filter(c => c.tf === '4h').map(c => `${c.old}>${c.new}`), ['notr>dagitim']);
  assert(flow.changes({ since: 0 }).length >= 2);
  ok('Etiket değişikliği: Nötr → Dağıtım bir kez kaydedildi (aynı etiket tekrar yazılmıyor), spot/futures ayrışması');

  // Metinler
  const txt = flowText('ETHUSDT', sm, ch, {}, true);
  assert(txt.includes('<b>4s</b> · ⚠️ spot/futures ayrışması') && txt.includes('Spot: <b>🔴 Dağıtım</b>') && txt.includes('Güncellemeler') && txt.includes('Nötr → 🔴 Dağıtım'));
  const txt2 = flowText('NOSPOTUSDT', flow.summary('NOSPOTUSDT'), [], {}, false);
  assert(!txt2.includes('Spot:') && txt2.includes('spotu yok') && txt2.includes('Henüz etiket değişikliği yok'));
  assert(changesText(flow.changes({ since: 0 })).includes('<b>ETHUSDT</b> 4s:'));
  assert(changesText([]).includes('değişen coin yok'));
  ok('Metin: /akis ETH (4 pencere, spot/futures satırı, güncellemeler), spotsuz coin, argümansız değişiklik listesi');

  // Evrenden çıkan coin yeniden eklenince geçmişi tekrar yüklenir
  syms = ['ETHUSDT'];
  now = Date.UTC(2026, 9, 22, 4, 2); await flow.tick();
  syms = ['ETHUSDT', 'NOSPOTUSDT'];
  const before = reqs.futures.length;
  now = Date.UTC(2026, 9, 22, 4, 30); await flow.tick();
  assert(reqs.futures.slice(before).includes(`NOSPOTUSDT 4h ${HISTORY['4h'] + 1}`));
  ok('Evrene geri dönen coinin geçmişi yeniden yükleniyor');

  // CSV
  const fakeStore = { since: () => [], touchesSince: () => [] };
  const { files, counts } = await buildExports(fakeStore, 30, now, { flow });
  assert(counts.akis > 0 && files.length === 1);
  const rowsCsv = flow.rowsSince(now - 30 * DAY);
  const e = rowsCsv.find(x => x.symbol === 'ETHUSDT' && x.market === 'spot' && x.tf === '4h');
  assert(e && e.vol_usd === 1000 && Number.isFinite(e.buy_pct) && 'net_usd' in e && e.time.endsWith('Z'));
  const plain = await buildExports(fakeStore, 30, now);
  assert.strictEqual(plain.counts.akis, undefined);
  ok(`CSV: akis.csv ${counts.akis} satır (toplam/alış/satış/net $, alış %), flow verilmezse eklenmiyor`);

  flow.close();
  console.log(R.join('\n'));
})().catch(err => { console.error('❌ BAŞARISIZ', err); process.exit(1); });
