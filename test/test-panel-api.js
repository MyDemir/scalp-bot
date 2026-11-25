'use strict';
// Panel ek uçları (src/server.js "Panel ek uçları"): oturum zorunlu, üye ve yönetici okur, yalnız GET (405),
// LIMIT sınırları, coin süzgeci, kart türü süzgeci, 📋 Detay, takip / piyasa / coin / akış sayaçları.
// Ağ gerekmez: Telegram yönetici/üye listesi taklit edilir; kart ve akış veritabanı geçici dosyadadır.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
process.env.NODE_ENV = 'test';
const TMP = path.join(__dirname, '.tmp', 'panel-api');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const telegram = require('../src/telegram');
const admins = ['12345678'];
const members = ['77777777'];
const dms = [];
telegram.getGroupAdminIds = async () => admins;
telegram.refreshGroupAdminIds = async () => admins;
telegram.isMember = async id => members.includes(String(id));
telegram.sendPrivate = async (id, text) => { dms.push({ id, text }); return true; };

const app = require('../src/server');
const infoBot = require('../src/infoBot');
const { createCardStore } = require('../src/cardStore');
const { createSpotFlow } = require('../src/spotFlow');
const { createSettings } = require('../src/infoSettings');

const NEW_GETS = ['/api/tracking', '/api/market', '/api/coin/ABC', '/api/feeds', '/api/cards/ABCUSDT-1700000000000/detail'];

async function main() {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (p, { method = 'GET', token, body } = {}) => fetch(base + p, {
    method, redirect: 'manual',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = async (p, token) => { const r = await req(p, { token }); assert.strictEqual(r.status, 200, `${p} → ${r.status}`); return r.json(); };
  async function login(userId) {
    assert.strictEqual((await req('/api/auth/request-code', { method: 'POST', body: { userId } })).status, 202);
    const code = /<code>(\d{6})<\/code>/.exec(dms.at(-1).text)[1];
    const v = await (await req('/api/auth/verify', { method: 'POST', body: { userId, code } })).json();
    assert(v.token, 'login ' + userId);
    return v;
  }

  const internal = infoBot._internal;
  const orig = { getPremium: internal.getPremium, getStore: internal.getStore, getFlow: internal.getFlow, tracker: internal.tracker, settings: internal.settings };
  const store = createCardStore({ file: path.join(TMP, 'cards.db'), logger: { log() {}, error() {} } });
  const flow = createSpotFlow({ file: path.join(TMP, 'flow.db'), futuresKlines: async () => [], fetchFn: null, logger: { log() {}, error() {}, warn() {} } });
  const settings = createSettings({ file: path.join(TMP, 'info-settings.json'), persist: false });
  const now = Date.now();
  const H = 3_600_000;
  const fakeSeries = { ready: () => false, lastT: () => null };
  try {
    // ── Oturumsuz: yeni uçların hiçbiri veri vermez ──
    for (const p of NEW_GETS.concat(['/api/cards?symbol=ABC'])) assert.strictEqual((await req(p)).status, 401, 'needs session: ' + p);

    const adm = await login('12345678');
    const mem = await login('77777777');
    assert.strictEqual(adm.role, 'admin');
    assert.strictEqual(mem.role, 'member');

    // ── Veri: geçici kart/akış veritabanı + bellekteki yapılar ──
    const cardRow = (sym, t, seq, extra = {}) => ({ id: `${sym}-${t}`, kind: 'card', symbol: sym, t, seq, price: 2,
      data: { symbol: sym, t, seq, grade: 2, price: 2, rsi: { '3m': 90, '5m': 88, '15m': 86 }, ...extra } });
    store.add(cardRow('ABCUSDT', now - 20 * 60_000, 1, { move: { pct: 2.1, grade: 2 } }));
    store.add(cardRow('ABCUSDT', now - 10 * 60_000, 2));
    store.add(cardRow('DEFUSDT', now - 5 * 60_000, 1));
    store.add({ id: `ABCUSDT-${now - 30 * 60_000}-m`, kind: 'move', symbol: 'ABCUSDT', t: now - 30 * 60_000, seq: null, price: 2, data: { movePct: 2.5 } });
    // ilk kartın 5 ve 15 dk penceresi dolsun (sonrası = yalnız fiyat değişimi)
    store.onCandle('ABCUSDT', { t: now - 5 * 60_000, o: 2, h: 2.1, l: 1.9, c: 1.95 });
    store.addEvent({ id: 'ABCUSDT-ev1', symbol: 'ABCUSDT', t: now - 2 * H, price: 2.2, dropT: now - 2 * H + 4 * 60_000, dropMin: 4, card: true, cardGrade: 2, outcome: 'düştü',
      feat: { grade: 2, rsi3: 92, secretBig: 'x'.repeat(10) }, out: { 15: { low: -2, high: 0.1, close: -1.5 } } });
    store.addEvent({ id: 'ABCUSDT-old', symbol: 'ABCUSDT', t: now - 9 * 24 * H, price: 2, card: false, outcome: 'yatay', feat: {}, out: {} });
    store.addTouch({ id: 'ABCUSDT-t1', symbol: 'ABCUSDT', t: now - 3 * H, name: '1h tepe', kind: 'swing', value: 2.3, hits: 2, rsiOk: true, card: false, pb: 1.1, pbMin: 9, held: false, up: 0.4, dn: -1.2, c60: -0.8 });
    flow.recordBig([
      { symbol: 'ABCUSDT', t: Math.floor(now / H) * H, buyN: 3, buyUsd: 90_000, sellN: 1, sellUsd: 20_000 },
      { symbol: 'DEFUSDT', t: Math.floor(now / H) * H - 6 * H, buyN: 1, buyUsd: 500_000, sellN: 0, sellUsd: 0 },
    ]);
    internal.details.set(`ABCUSDT-${now - 10 * 60_000}`, '<b>📋 Detay</b>\nRSI 3dk 90');
    internal.liqStream._onMsg(JSON.stringify({ data: { o: { s: 'ABCUSDT', S: 'BUY', ap: '2', z: '1000', T: now - 60_000 } } }));
    internal.liqStream._onMsg(JSON.stringify({ data: { o: { s: 'DEFUSDT', S: 'SELL', ap: '1', z: '500', T: now - 70 * 60_000 } } }));   // 60 dk dışı
    settings.toggleFollow('ABCUSDT');
    settings.mute('DEFUSDT', H);
    internal.getStore = () => store;
    internal.getFlow = () => ({ ...flow, universe: () => ['ABCUSDT', 'DEFUSDT'] });
    internal.settings = settings;
    internal.tracker = {
      active: s => s === 'ABCUSDT', maxGrade: () => 3,
      log: s => (s === 'ABCUSDT' ? [{ t: now - 20 * 60_000, price: 2, seq: 1 }, { t: now - 10 * 60_000, price: 2.05, seq: 2 }] : []),
      moveStats: s => (s === 'ABCUSDT' ? { up: 2, down: 1 } : { up: 0, down: 0 }),
    };
    internal.series.set('ABCUSDT', fakeSeries);
    internal.series.set('DEFUSDT', fakeSeries);

    // ── Üye ve yönetici okur; yalnız GET (405) ──
    for (const p of NEW_GETS.slice(0, 4)) {
      for (const tok of [mem.token, adm.token]) assert.strictEqual((await req(p, { token: tok })).status, 200, 'reads ' + p);
      for (const method of ['POST', 'PUT', 'DELETE']) assert.strictEqual((await req(p, { method, token: adm.token, body: {} })).status, 405, `${method} ${p} → 405`);
    }

    // ── /api/cards: symbol + kind süzgeci, id, LIMIT ──
    const all = (await json('/api/cards', mem.token)).cards;
    assert.strictEqual(all.length, 3, 'default kind=card (move row excluded)');
    assert(all.every(c => c.kind === 'card' && typeof c.id === 'string'), 'cards carry id for 📋 Detay');
    assert.strictEqual(all[0].symbol, 'DEFUSDT', 'newest first');
    const abc = (await json('/api/cards?symbol=abc', mem.token)).cards;
    assert.deepStrictEqual(abc.map(c => c.seq), [2, 1], 'symbol=abc → ABCUSDT only, newest first');
    assert.strictEqual(+abc[1].fwd[5].close.toFixed(4), -2.5, 'fwd = price change only (1.95 vs 2 → −2.5%)');
    assert.strictEqual((await json('/api/cards?kind=move', mem.token)).cards.length, 1, 'kind=move');
    assert.strictEqual((await json('/api/cards?kind=all', mem.token)).cards.length, 4, 'kind=all');
    assert.strictEqual((await json('/api/cards?kind=<x>', mem.token)).cards.length, 3, 'unknown kind → card');
    assert.strictEqual((await json('/api/cards?limit=1', mem.token)).cards.length, 1, 'limit=1');
    assert.strictEqual((await json('/api/cards?symbol=' + encodeURIComponent("x' OR 1=1 --"), mem.token)).cards.length, 0, 'symbol is sanitized (no SQL injection)');

    // ── 📋 Detay ──
    const det = await json(`/api/cards/ABCUSDT-${now - 10 * 60_000}/detail`, mem.token);
    assert(det.text.includes('📋 Detay'), 'detail text from memory');
    assert.strictEqual((await req(`/api/cards/ABCUSDT-${now - 20 * 60_000}/detail`, { token: mem.token })).status, 404, 'no detail in memory → 404');
    assert.strictEqual((await req('/api/cards/..%2Fserver/detail', { token: mem.token })).status, 404, 'bad id → 404');

    // ── /api/tracking ──
    const tk = await json('/api/tracking', mem.token);
    assert.deepStrictEqual(tk.open.map(o => o.symbol), ['DEFUSDT', 'ABCUSDT', 'ABCUSDT', 'ABCUSDT'], 'open tracks, newest first (move row tracked too)');
    const first = tk.open.find(o => o.id === `ABCUSDT-${now - 20 * 60_000}`);
    assert.deepStrictEqual(first.done, [5, 15], 'windows already recorded');
    assert.strictEqual(first.chg, -2.5, 'change since card = last close vs card price');
    assert.deepStrictEqual(tk.series, [{ symbol: 'ABCUSDT', seq: 2, cards24h: 2, lastT: now - 10 * 60_000, lastPrice: 2.05, maxGrade: 3 }]);
    assert.deepStrictEqual(tk.moves, [{ symbol: 'ABCUSDT', up: 2, down: 1 }]);
    assert.deepStrictEqual(tk.follows, ['ABCUSDT']);
    assert(tk.muted.length === 1 && tk.muted[0].symbol === 'DEFUSDT' && tk.muted[0].until > now, 'muted list with end time');
    assert.strictEqual((await json('/api/tracking?limit=1', mem.token)).open.length, 1, 'limit=1');
    assert((await json('/api/tracking?limit=99999', mem.token)).open.length <= 100, 'limit capped');

    // ── /api/market ──
    const mk = await json('/api/market', mem.token);
    assert.strictEqual(mk.hours, 24);
    assert.deepStrictEqual(mk.big.map(b => b.symbol), ['DEFUSDT', 'ABCUSDT'], 'big trades sorted by total $');
    assert.strictEqual(mk.big[1].netUsd, 70_000);
    assert.deepStrictEqual((await json('/api/market?hours=4', mem.token)).big.map(b => b.symbol), ['ABCUSDT'], 'hours=4 window');
    assert.strictEqual((await json('/api/market?hours=7', mem.token)).hours, 24, 'hours whitelist');
    assert.strictEqual((await json('/api/market?limit=1', mem.token)).big.length, 1, 'limit=1');
    assert.deepStrictEqual(mk.liq.map(l => l.symbol), ['ABCUSDT'], 'only liquidations of the last 60 min');
    assert.strictEqual(mk.liq[0].liqShort60, 2000);
    assert(mk.state && 'breadth80' in mk.state, 'market state from the engine');

    // ── Funding (getPremium taklidi): en yüksek 10 azalan, en düşük 10 artan; 10 sınırı ──
    const premMap = new Map();
    for (let i = 0; i < 25; i++) premMap.set('C' + String(i).padStart(2, '0') + 'USDT', { rate: (i - 12) / 10000, next: 1700000000000 + i });
    internal.getPremium = () => premMap;
    const fk = (await json('/api/market', mem.token)).funding;
    assert.strictEqual(fk.top.length, 10); assert.strictEqual(fk.bottom.length, 10);
    assert.strictEqual(fk.top[0].symbol, 'C24USDT'); assert.strictEqual(fk.top[0].ratePct, 0.12);
    assert.deepStrictEqual(fk.top.map(f => f.ratePct), [...fk.top.map(f => f.ratePct)].sort((a, b) => b - a), 'top descending');
    assert.strictEqual(fk.bottom[0].symbol, 'C00USDT'); assert.strictEqual(fk.bottom[0].ratePct, -0.12);
    assert.deepStrictEqual(fk.bottom.map(f => f.ratePct), [...fk.bottom.map(f => f.ratePct)].sort((a, b) => a - b), 'bottom ascending');
    assert.strictEqual(fk.top[0].next, 1700000000024);
    internal.getPremium = () => new Map();
    assert.deepStrictEqual((await json('/api/market', mem.token)).funding, { top: [], bottom: [] }, 'empty premium');
    internal.getPremium = orig.getPremium;

    // ── /api/coin/:symbol ──
    const co = await json('/api/coin/abc', mem.token);
    assert.strictEqual(co.symbol, 'ABCUSDT');
    assert(co.watched && co.followed && co.mutedUntil === null, 'watched + followed');
    assert.deepStrictEqual(co.series, { seq: 2, cards24h: 2, lastT: now - 10 * 60_000, maxGrade: 3 });
    assert.deepStrictEqual(co.cards.map(c => c.seq), [2, 1]);
    assert.deepStrictEqual(co.events.map(e => e.id), ['ABCUSDT-ev1'], 'events: last 7 days only');
    assert(!('secretBig' in co.events[0].feat), 'event features are whitelisted (slimEventFeat)');
    assert.deepStrictEqual(co.touches.map(t => t.id), ['ABCUSDT-t1']);
    assert.strictEqual(co.big.day.buyN, 3);
    assert.strictEqual(co.big.hours.length, 1);
    assert.strictEqual(co.liq.liqShort60, 2000);
    assert.strictEqual(co.open.length, 3, 'open tracks of this coin');
    assert.strictEqual((await json('/api/coin/abc?limit=1', mem.token)).cards.length, 1, 'limit=1');
    assert((await json('/api/coin/def', mem.token)).mutedUntil > now, 'muted coin shows end time');
    assert.strictEqual((await req('/api/coin/' + encodeURIComponent('<>!'), { token: mem.token })).status, 400, 'invalid symbol → 400');
    assert.strictEqual((await json('/api/coin/' + encodeURIComponent('<b>x'), mem.token)).symbol, 'BXUSDT', 'markup stripped from symbol');

    // ── /api/feeds ──
    const fd = await json('/api/feeds', mem.token);
    assert(fd.liq && fd.liq.messages >= 2 && fd.flow && fd.flow.universe === 2 && fd.openTracks === 4 && fd.details >= 1, 'feed counters: ' + JSON.stringify(fd));

    // ── Kayıt kapalıyken (SQLite yok) uçlar boş döner, çökmez ──
    internal.getStore = () => null;
    internal.getFlow = () => null;
    assert.deepStrictEqual((await json('/api/tracking', mem.token)).open, []);
    assert.deepStrictEqual((await json('/api/market', mem.token)).big, []);
    assert.deepStrictEqual((await json('/api/coin/abc', mem.token)).cards, []);
    assert.strictEqual((await json('/api/cards?symbol=abc', mem.token)).source, 'memory');

    console.log('PASS: panel extra endpoints (session, member/admin read, GET-only 405, limits, symbol/kind filters, detail, tracking, market, coin, feeds)');
  } finally {
    Object.assign(internal, orig);
    internal.series.delete('ABCUSDT');
    internal.series.delete('DEFUSDT');
    server.close();
    store.close(); flow.close();
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch(err => { console.error(err); process.exit(1); });
