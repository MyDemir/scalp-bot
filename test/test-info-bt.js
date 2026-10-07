'use strict';
// Bilgi backtest'i: sahte Binance REST ile CLI + look-ahead + canlı motorla eşdeğerlik
const SP = require('./_tmp'), REPO = require('path').resolve(__dirname, '..');
const assert = require('assert'); const fs = require('fs'); const { execFileSync } = require('child_process');
const { gen, agg, MIN } = require('./gen'); const M = require('./mockinfo');
const PR = 18401, PT = 18403, CHAT = '-1001234567890';
const D = 1440, nowF = Math.floor(Date.now() / MIN) * MIN, start = nowF - 42 * D * MIN;
const pumpAt = 40 * D + 600;                        // dönemin içinde (son 2 günün ortası)
const pump = gen({ seed: 3, days: 42, start, p0: 130, pumps: [{ at: pumpAt, len: 90, rate: 0.0012, vol: 3, dumpLen: 40 }] });
{ const i = pumpAt + 57, c = pump[i], o = pump[i - 1].c, nc = o * 1.012, f = nc / c.c;
  Object.assign(c, { o, c: nc, h: nc * 1.0005, l: o * 0.9995, v: c.v * 6, tb: c.v * 6 * 0.8 }); c.q = c.v * nc; c.tq = c.tb * nc;
  for (let j = i + 1; j < pump.length; j++) for (const k of ['o', 'h', 'l', 'c']) pump[j][k] *= f; }
{ const i = pumpAt + 150, c = pump[i], o = pump[i - 1].c, nc = o * 0.975, f = nc / c.c;   // 1 dk −%2.5 hareket
  Object.assign(c, { o, c: nc, h: o * 1.0005, l: nc * 0.999 });
  for (let j = i + 1; j < pump.length; j++) for (const k of ['o', 'h', 'l', 'c']) pump[j][k] *= f; }
const defs = {
  BTCUSDT: { m1: gen({ seed: 5, days: 42, start, p0: 60000 }), histUntil: nowF, vol: 9e9 },
  PUMPUSDT: { m1: pump, histUntil: nowF, vol: 3e8 },
  CALMUSDT: { m1: gen({ seed: 7, days: 42, start, p0: 2 }), histUntil: nowF, vol: 2e7 },
  LOWUSDT: { m1: gen({ seed: 8, days: 42, start, p0: 1 }), histUntil: nowF, vol: 1e6 },
};
const market = M.buildMarket(defs); const hits = []; const srv = M.startRest(PR, market, hits);
const tg = M.startTelegram(PT);
const env = { ...process.env, BINANCE_REST_BASE_URL: `http://127.0.0.1:${PR}`, BACKTEST_REQ_DELAY_MS: '0', BINANCE_REST_WEIGHT_PER_MIN: '600000',
  TELEGRAM_BOT_TOKEN: 'TEST:TOKEN', TELEGRAM_CHAT_ID: CHAT, TELEGRAM_API_BASE: `http://127.0.0.1:${PT}`, DB_PATH: `${SP}/info-bt.db` };
const results = []; const ok = s => results.push('✅ ' + s);

(async () => {
  // 1) CLI: tüm evren, 3 gün, örnek + telegram (ayrı süreç; sunucular bu süreçte)
  const out = await new Promise((res, rej) => {
    const { execFile } = require('child_process');
    execFile('node', [`${REPO}/src/infoBacktest.js`, '--days', '3', '--ornek', '2', '--telegram', '--ayar', 'rsiMin=90'], { env, cwd: SP, maxBuffer: 1e7 }, (e, so, se) => e ? rej(new Error(se || e.message)) : res(so + se));
  });
  assert(/Semboller : 3 \(24s hacim ≥ 3M \$\)/.test(out), 'evren: ' + out.slice(0, 600));
  assert(/PUMPUSDT: [1-9]\d* kart/.test(out) && /BTCUSDT: 0 kart/.test(out) && /CALMUSDT: 0 kart/.test(out), out);
  assert(out.includes('Kart sınıfları') && out.includes('Örnek kartlar'));
  assert(/1 dk hareket ≥ %2 .*: 1 /.test(out) && /▼ düşüş\s+1 /.test(out), 'hareket sayımı: ' + out.split('⚡')[1]);
  const file = out.match(/Ayrıntılı sonuç: (\S+)/)[1];
  const J = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert(J.cards.length >= 2 && J.cards.every(c => c.symbol === 'PUMPUSDT'));
  assert(J.cards.every(c => c.fwd && c.fwd[60] && Number.isFinite(c.fwd[60].low)));
  assert(J.cards.some(c => c.burst?.dir === 'buy'), 'alış patlaması kartı bekleniyordu');
  assert.deepStrictEqual(J.cards.map(c => c.seq), J.cards.map((_, i) => i + 1));
  assert(tg.sent.length === 6 && tg.sent[0].text.includes('Bilgi botu backtest') && tg.sent[1].text.includes('Seviye tepkisi') && tg.sent[2].text.includes('Düşüş defteri') && tg.sent[3].text.includes('Teyit adayları') && tg.sent[4].text.includes('BACKTEST ÖRNEĞİ'), tg.sent.map(m => m.text.slice(0, 40)).join(' | '));
  assert(J.drops.every(e => ['düştü', 'devam', 'yatay'].includes(e.outcome)), 'tepe adaylarının sonucu');
  assert(Array.isArray(J.drops) && J.drops.every(e => e.symbol && e.price > 0 && e.feat && e.out), 'JSON drops');
  { const csvF = file.replace(/info-([^/]+)\.json$/, 'tepeler-$1.csv'); assert(fs.existsSync(csvF) && fs.readFileSync(csvF, 'utf8').split('\n')[0].includes('rsi15'), 'düşüş CSV'); }
  assert(Array.isArray(J.touches) && J.touches.length > 0 && J.touches.every(e => e.symbol && e.name && Number.isFinite(e.pb)), 'JSON touches');
  assert(out.includes('Seviye tepkisi') && out.includes(`${J.touches.length} temas (backtest)`));
  assert(!tg.sent.some(m => /mert/i.test(m.text)));
  ok(`CLI (--days 3, tüm evren): ${J.cards.length} PUMP kartı, BTC/CALM 0, LOW elendi; sınıf tablosu + ${J.cards.length} kartın 15/60 dk sonrası; JSON; Telegram'a özet + seviye tepkisi (${J.touches.length} temas) + tepe defteri (${J.drops.length} aday: ${J.drops.filter(e => e.outcome === 'düştü').length} düştü, CSV) + teyit adayları + 2 örnek (URL butonlu)`);
  console.log(out.split('BİLGİ BOTU BACKTEST — ÖZET')[1].split('── Örnek')[0]);

  // 2) Look-ahead: dönemi kısaltınca, kısa dönem içindeki kartlar AYNI kalmalı
  process.env.BINANCE_REST_BASE_URL = env.BINANCE_REST_BASE_URL; process.env.BACKTEST_REQ_DELAY_MS = '0'; process.env.BINANCE_REST_WEIGHT_PER_MIN = '600000';
  const bt = require(`${REPO}/src/infoBacktest.js`);
  const cfg = require(`${REPO}/src/config`); const s = { ...cfg.info, rsiMin: 90, resetRsi: 75 };
  const btcClose = new Map(market.BTCUSDT.tfs['1m'].map(c => [c.t, c.c]));
  const st = Math.floor((nowF - 3 * D * MIN) / (D * MIN)) * D * MIN;
  const cut = start + (pumpAt + 75) * MIN;
  const full = await bt.runSymbol('PUMPUSDT', { start: st, end: nowF, s, btcClose });
  const short = await bt.runSymbol('PUMPUSDT', { start: st, end: cut, s, btcClose });
  const key = c => `${c.t}|${c.seq}|${c.news.join('/')}|${c.snap.rsi['3m'].v.toFixed(6)}|${c.snap.level?.dist.toFixed(6)}`;
  const a1 = full.cards.filter(c => c.t <= cut).map(key), a2 = short.cards.map(key);
  assert(a2.length >= 1); assert.deepStrictEqual(a2, a1);
  ok(`Look-ahead yok: dönem pompanın ortasında kesilince ${a2.length} kart birebir aynı (zaman, numara, yenilik, RSI, seviye mesafesi)`);

  // 3) Canlı yol ile eşdeğerlik: canlıdaki gibi "REST yarım mumlu tohum + sonraki 1m'ler" ile aynı kartlar
  const { Series, TF_MS, KEEP } = require(`${REPO}/src/series`); const eng = require(`${REPO}/src/infoEngine`);
  const seedAt = st + 7 * MIN + 30e3;                     // gün ortası değil, periyotların ortasında bir an
  const S = new Series('PUMPUSDT'); const hist = pump.filter(c => c.t < Math.floor(seedAt / MIN) * MIN);
  for (const tf of ['1d', '4h', '1h', '15m', '5m', '3m']) S.seed(tf, agg(hist, TF_MS[tf], Infinity).slice(-(KEEP[tf] + 1)).map(c => ({ ...c, closed: c.t + TF_MS[tf] <= seedAt })));
  S.seed('1m', hist.slice(-240).map(c => ({ ...c, closed: true })));
  const tr = eng.createTracker(); const live = [];
  const ctx = { btc1h: t => { const a = btcClose.get(t - MIN), b = btcClose.get(t - 61 * MIN); return a && b ? (a / b - 1) * 100 : null; } };
  for (const c of pump.filter(c => c.t >= Math.floor(seedAt / MIN) * MIN && c.t < nowF)) { const card = eng.step(S, S.apply1m(c), s, tr, ctx); if (card) live.push(card); }
  const k2 = c => `${c.t}|${c.seq}|${c.news.join('/')}|${c.snap.hits}|${c.snap.level?.name}`;
  assert.deepStrictEqual(live.map(k2), full.cards.map(k2));
  ok(`Canlı yol (REST yarım mumlu tohum + WS 1m) ile backtest aynı ${live.length} kartı üretti`);

  // 4) --ayar ile şart sıkılaştırma → daha az kart; geçersiz ayar reddi
  const run = args => new Promise(res => require('child_process').execFile('node', [`${REPO}/src/infoBacktest.js`, ...args], { env, cwd: SP, maxBuffer: 1e7 }, (e, so, se) => res({ code: e ? e.code : 0, out: so + se })));
  const out2 = (await run(['--days', '3', '--symbol', 'PUMP', '--ayar', 'rsiMin=90,resetRsi=75,minTFs=3,levelMaxPct=1'])).out;
  const n2 = Number(out2.match(/PUMPUSDT: (\d+) kart/)[1]);
  assert(n2 < J.cards.length, `sıkı ayarla daha az kart bekleniyordu (${n2} vs ${J.cards.length})`);
  const bad = await run(['--days', '1', '--symbol', 'PUMP', '--ayar', 'rsiMin=150']);
  assert(bad.code !== 0 && /50–100/.test(bad.out), bad.out);
  ok(`--ayar minTFs=3,levelMaxPct=1 → ${n2} kart (RSI 90'da ${J.cards.length}); geçersiz --ayar rsiMin=150 hata ile reddedildi`);
  const fs2 = require('fs'); const SF = `${SP}/bt-live-settings.json`;
  fs2.writeFileSync(SF, JSON.stringify({ values: { minTFs: 2 } }));
  const before = fs2.readFileSync(SF, 'utf8');
  const low = await new Promise(res => require('child_process').execFile('node', [`${REPO}/src/infoBacktest.js`, '--days', '3', '--kanit', '--canli-ayar', '--ayar', 'levelMaxPct=2.5'], { env: { ...env, INFO_SETTINGS_PATH: SF }, cwd: SP, maxBuffer: 1e7 }, (e, so, se) => res(so + se)));
  assert(low.includes('KANIT MODU') && /RSI ≥ 70/.test(low), low.slice(0, 800));
  assert.strictEqual(fs2.readFileSync(SF, 'utf8'), before, '--kanit/--ayar canlı ayar dosyasını değiştirmemeli');
  const nLow = Number(low.match(/Kart         : (\d+)/)[1]);
  assert(nLow > J.cards.length, `RSI 70 ile daha çok kart bekleniyordu (${nLow} vs ${J.cards.length})`);
  ok(`--kanit (RSI ≥ 70, sıfırlama 60, yalnızca backtest): ${nLow} kart (RSI 90: ${J.cards.length}); --canli-ayar ile birlikte kullanılınca canlı ayar dosyası değişmedi`);

  console.log(results.join('\n')); srv.close(); tg.srv.close(); process.exit(0);
})().catch(e => { console.log('❌ BAŞARISIZ:', e.stack || e.message); console.log(results.join('\n')); process.exit(1); });
