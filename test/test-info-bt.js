'use strict';
// Bilgi backtest'i: sahte Binance REST ile CLI + look-ahead + canlı motorla eşdeğerlik
const SP = require('./_tmp'), REPO = require('path').resolve(__dirname, '..');
const assert = require('assert'); const fs = require('fs'); const { execFileSync } = require('child_process');
const { gen, agg, MIN } = require('./gen'); const M = require('./mockinfo');
const { formatCard } = require('../src/infoCard');
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
// Evren seçimi dönem başından ÖNCEKİ 24 saatin hacmine (1d mum quoteVolume) bakar: coin hacmini q ile ayarla (yalnız q/tq; fiyat ve v aynı)
const scaleQ = (m1, f, from = -Infinity, to = Infinity) => { for (const c of m1) if (c.t >= from && c.t < to) { c.q *= f; c.tq *= f; } return m1; };
const ST3 = Math.floor((nowF - 3 * D * MIN) / (D * MIN)) * D * MIN;   // CLI testindeki (3 gün) dönem başı
const defs = {
  BTCUSDT: { m1: gen({ seed: 5, days: 42, start, p0: 60000 }), histUntil: nowF, vol: 9e9 },
  PUMPUSDT: { m1: pump, histUntil: nowF, vol: 3e8 },
  CALMUSDT: { m1: scaleQ(gen({ seed: 7, days: 42, start, p0: 2 }), 60), histUntil: nowF, vol: 2e7 },
  LOWUSDT: { m1: gen({ seed: 8, days: 42, start, p0: 1 }), histUntil: nowF, vol: 1e6 },
  // OI 30 gün sınırı testi (evrene girmez: hacim düşük): sınırdan önce, hemen önce ve sonra pompalar
  OLDUSDT: { m1: scaleQ(gen({ seed: 11, days: 42, start, p0: 50, pumps: [7, 11, 13].map(d => ({ at: d * D + 600, len: 90, rate: 0.0012, vol: 3, dumpLen: 40 })) }), 0.01), histUntil: nowF, vol: 1e6 },
  // Evren seçimi (dönem başı = ST3): hacim ST3'ten önce düşük/yüksek, sonra tersi; "vol" = BUGÜNKÜ 24s hacim (seçimde kullanılmamalı)
  TODAYHIUSDT: { m1: scaleQ(scaleQ(gen({ seed: 21, days: 42, start, p0: 10 }), 0.1, -Infinity, ST3), 10, ST3), histUntil: nowF, vol: 5e9 },   // bugün yüksek, dönem başında düşük
  PASTHIUSDT:  { m1: scaleQ(scaleQ(gen({ seed: 22, days: 42, start, p0: 10 }), 10, -Infinity, ST3), 0.1, ST3), histUntil: nowF, vol: 1e5 },   // dönem başında yüksek, bugün düşük
  NEWUSDT:     { m1: scaleQ(gen({ seed: 23, days: 42, start, p0: 10 }), 10), histUntil: nowF, vol: 5e9, onboard: ST3 + D * MIN / 2 },          // dönem başından sonra listelendi (verisi var, yüksek hacim)
  DELISTUSDT:  { m1: scaleQ(gen({ seed: 24, days: 42, start, p0: 10 }), 10), histUntil: nowF, vol: 1e5, status: 'SETTLING', delivery: ST3 + 1.5 * D * MIN },   // dönem içinde kapanıyor
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
  assert(/Semboller : 5 \(dönem öncesi 24s hacim ≥ 3M \$\)/.test(out) && /BTCUSDT/.test(out.split('Semboller :')[1].split('\n')[0]), 'evren: ' + out.slice(0, 700));
  { const line = out.split('Semboller :')[1].split('\n')[0];
    for (const n of ['BTCUSDT', 'PUMPUSDT', 'CALMUSDT', 'PASTHIUSDT', 'DELISTUSDT']) assert(line.includes(n), `evrende ${n} bekleniyordu: ${line}`);
    assert(/Evren seçimi: 9 aday, 8 uygun .*, 9 REST isteği/.test(out), 'evren özeti: ' + out.slice(0, 700)); }
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
  // Seri içinde yeni kart yalnız derece yükselince geldiği için şart sıkılaştırma RSI eşiğiyle ölçülür
  const n1 = J.cards.length;
  const n2 = Number((await run(['--days', '3', '--symbol', 'PUMP', '--ayar', 'rsiMin=97,resetRsi=75,minTFs=3'])).out.match(/PUMPUSDT: (\d+) kart/)[1]);
  assert(n2 < n1, `sıkı ayarla daha az kart bekleniyordu (${n2} vs ${n1})`);
  const bad = await run(['--days', '1', '--symbol', 'PUMP', '--ayar', 'rsiMin=150']);
  assert(bad.code !== 0 && /50–100/.test(bad.out), bad.out);
  ok(`--ayar rsiMin=97,minTFs=3 → ${n2} kart (RSI 90'da ${n1}); geçersiz --ayar rsiMin=150 hata ile reddedildi`);
  const fs2 = require('fs'); const SF = `${SP}/bt-live-settings.json`;
  fs2.writeFileSync(SF, JSON.stringify({ values: { minTFs: 2 } }));
  const before = fs2.readFileSync(SF, 'utf8');
  const low = await new Promise(res => require('child_process').execFile('node', [`${REPO}/src/infoBacktest.js`, '--days', '3', '--kanit', '--canli-ayar', '--ayar', 'levelMaxPct=2.5'], { env: { ...env, INFO_SETTINGS_PATH: SF }, cwd: SP, maxBuffer: 1e7 }, (e, so, se) => res(so + se)));
  assert(low.includes('KANIT MODU') && /RSI ≥ 70/.test(low), low.slice(0, 800));
  assert.strictEqual(fs2.readFileSync(SF, 'utf8'), before, '--kanit/--ayar canlı ayar dosyasını değiştirmemeli');
  const nLow = Number(low.match(/Kart         : (\d+)/)[1]);
  assert(nLow > J.cards.length, `RSI 70 ile daha çok kart bekleniyordu (${nLow} vs ${J.cards.length})`);
  ok(`--kanit (RSI ≥ 70, sıfırlama 60, yalnızca backtest): ${nLow} kart (RSI 90: ${J.cards.length}); --canli-ayar ile birlikte kullanılınca canlı ayar dosyası değişmedi`);

  // 5) BTC bağlamı: ctx.market(t) elle hesapla eşit, look-ahead yok, breadth80/pumping null, params.limits
  { const ta = require(`${REPO}/src/ta`); const b1 = market.BTCUSDT.tfs['1m'].filter(c => c.t >= st - 61 * MIN && c.t < nowF);
    const mk = bt.createBtcMarket(b1);
    const t = st + 600 * MIN + 7 * MIN;                       // 15m periyodunun ortasında (yarım mum dahil)
    const upto = b1.filter(c => c.t < t), n = upto.length, cl = upto.map(c => c.c);
    const hand = m => +((cl[n - 1] / cl[n - 1 - m] - 1) * 100).toFixed(2);
    const c15 = agg(upto, 15 * MIN, Infinity).map(c => c.c);   // son (yarım) mum dahil
    const got = mk(t);
    assert.strictEqual(got.btc5, hand(5)); assert.strictEqual(got.btc15, hand(15));
    assert.strictEqual(got.btcRsi15, +ta.rsiLast(c15.slice(-300), 14).toFixed(1), 'btcRsi15 elle hesapla eşit olmalı');
    assert(got.breadth80 === null && got.pumping === null);
    // look-ahead: t'den sonraki BTC mumlarını bozunca t'deki değerler değişmemeli
    const b2 = b1.map(c => (c.t >= t ? { ...c, c: c.c * 1.5, h: c.h * 1.5 } : c));
    assert.deepStrictEqual(bt.createBtcMarket(b2)(t), got, 'look-ahead: gelecek mumlar t anını değiştirdi');
    assert.notDeepStrictEqual(bt.createBtcMarket(b2)(t + 3 * MIN), mk(t + 3 * MIN));
    // runSymbol: tepe kaydında BTC alanları dolu
    const r = await bt.runSymbol('PUMPUSDT', { start: st, end: nowF, s, btcClose, btcMarket: bt.createBtcMarket(market.BTCUSDT.tfs['1m'].filter(c => c.t >= st - 61 * MIN && c.t < nowF)) });
    const ready = r.drops.filter(d => d.t > st + 6 * 60 * MIN);
    assert(r.drops.length > 0 && ready.length > 0 && ready.every(d => d.feat.btc5 != null && d.feat.btc15 != null && d.feat.btcRsi15 != null && d.feat.breadth80 == null && d.feat.pumping == null), 'tepe kaydında btc5/btc15/btcRsi15 dolu, breadth80/pumping null');
    assert(Array.isArray(J.params.limits) && J.params.limits.length >= 5 && J.params.limits.some(x => /breadth80/.test(x)) && J.params.limits.some(x => /OI yalnız son 30 gün/.test(x)) && !J.params.limits.some(x => /^funding yok/.test(x)) && J.params.limits.some(x => /bir dönem geriden/.test(x)) && J.params.limits.some(x => /minToFunding sapabilir/.test(x)), 'params.limits');
    assert(out.includes('Canlıdan eksik bağlam'));
    ok(`BTC bağlamı: btc5=${got.btc5} btc15=${got.btc15} btcRsi15=${got.btcRsi15} elle hesapla eşit; gelecek mum değişince aynı; ${ready.length} tepe kaydında dolu, breadth80/pumping null; params.limits ${J.params.limits.length} madde + konsol satırı`); }

  // 6) Funding / OI geçmişi: canlı ctx biçimi, t anında bilinen son değer (look-ahead yok), OI yalnız son 30 gün
  { const { oiFields, oiChange1h } = require(`${REPO}/src/marketData`); const { compact } = require(`${REPO}/src/infoStats`);
    const fAt = t => { const ft = Math.floor((t - M.FUND_OFF) / M.FUND_MS) * M.FUND_MS + M.FUND_OFF; return { ft, rate: parseFloat(M.fundingRateOf(ft)) }; };
    const oiRows = t => { const last = Math.floor(t / M.OI_MS) * M.OI_MS; return Array.from({ length: 13 }, (_, j) => M.oiAt(last - (12 - j) * M.OI_MS)); };
    // birim: ödeme anından 1 ms önce önceki oran, ödeme anında yeni oran; next son iki ödemenin aralığıyla
    const rows = [0, 1, 2].map(k => ({ fundingTime: st + k * M.FUND_MS + M.FUND_OFF, fundingRate: M.fundingRateOf(st + k * M.FUND_MS + M.FUND_OFF) }));
    const fa = bt.createFundingAt(rows);
    assert.strictEqual(fa(rows[0].fundingTime - 1), null, 'ilk ödemeden önce funding boş olmalı');
    assert.deepStrictEqual(fa(rows[0].fundingTime), { rate: parseFloat(rows[0].fundingRate), next: null, mark: null, index: null });
    assert.strictEqual(fa(rows[2].fundingTime - 1).rate, parseFloat(rows[1].fundingRate), 'look-ahead: t\'den sonraki ödeme t anında görünmemeli');
    assert.notStrictEqual(parseFloat(rows[1].fundingRate), parseFloat(rows[2].fundingRate));
    assert.strictEqual(fa(rows[2].fundingTime - 1).next, st + 2 * M.FUND_MS);
    // uçtan uca: kart ve tepe kaydı
    const nOiBefore = hits.filter(h => h.startsWith('openInterestHist')).length, nFrBefore = hits.filter(h => h.startsWith('fundingRate')).length;
    const r = await bt.runSymbol('PUMPUSDT', { start: st, end: nowF, s, btcClose, keepCards: true });
    const nOi = hits.filter(h => h.startsWith('openInterestHist')).length - nOiBefore, nFr = hits.filter(h => h.startsWith('fundingRate')).length - nFrBefore;
    assert(r.cards.length >= 1 && r.drops.length >= 5);
    for (const c of r.cards) {
      const e = fAt(c.t);
      assert.strictEqual(c.snap.funding.rate, e.rate, `kart funding t=${c.t}`);
      assert.strictEqual(c.snap.funding.next, Math.round(e.ft / MIN) * MIN + M.FUND_MS);
      assert.strictEqual(c.oi.changePct, oiChange1h(oiRows(c.t)), 'kart OI 1s = canlı fetchOIChange1h hesabı');
      const k = compact(c); assert(k.funding === +(e.rate * 100).toFixed(4) && k.oiChg60 === +c.oi.changePct.toFixed(2), 'kart kaydı funding/oiChg60');
      assert(/Funding: /.test(c.text) && /Açık pozisyon 1s: /.test(formatCard(c, s).details), 'kart metninde funding ve OI');
    }
    let crossed = 0;
    for (const d of r.drops) {
      const e = fAt(d.t);
      assert.strictEqual(d.feat.funding, +(e.rate * 100).toFixed(4), `tepe funding t=${d.t}`);
      const nextRate = parseFloat(M.fundingRateOf(e.ft + M.FUND_MS));
      if (d.feat.funding !== +(nextRate * 100).toFixed(4)) crossed++;
      assert(Number.isFinite(d.feat.minToFunding) && d.feat.minToFunding > 0 && d.feat.minToFunding <= 480, 'minToFunding');
      const want = oiFields(oiRows(d.t));
      assert.deepStrictEqual({ oiChg15: d.feat.oiChg15, oiChg60: d.feat.oiChg60, oiUsd: d.feat.oiUsd }, want, `tepe OI t=${d.t}`);
      assert(want.oiChg60 != null && d.feat.lsTopAcc == null && d.feat.obBid1 == null && d.feat.spotPrem == null, 'enrich\'in diğer alanları backtest\'te yok');
      assert.strictEqual(d.feat.basisPct, null);
    }
    assert.strictEqual(crossed, r.drops.length, 'her tepe kaydında sonraki ödemenin oranı değil, bilinen oran');
    assert(nFr === 1 && nOi >= 1 && nOi <= Math.ceil((3 * D + 65 + 30) / 5 / 500) + 1, `istek sayısı: fundingRate ${nFr}, openInterestHist ${nOi}`);
    // 30 günden eski dönem: OI isteği atılmaz, alanlar boş; sınırı geçen dönemde yalnız sınırdan sonrası dolu
    const floor = nowF - 30 * D * MIN;
    const DM = D * MIN, oSt = Math.floor((start + 6 * DM) / DM) * DM, oEnd = oSt + 3 * DM;
    const h0 = hits.filter(h => h.startsWith('openInterestHist')).length;
    const old = await bt.runSymbol('OLDUSDT', { start: oSt, end: oEnd, s, btcClose });
    assert.strictEqual(hits.filter(h => h.startsWith('openInterestHist')).length, h0, '30 günden eski dönem için OI isteği atılmamalı');
    assert(old.drops.length > 0 && old.drops.every(d => d.feat.oiChg15 == null && d.feat.oiChg60 == null && d.feat.oiUsd == null && d.feat.funding != null), 'eski dönemde OI boş, funding dolu');
    const xSt = Math.floor((start + 10.5 * DM) / DM) * DM, xEnd = xSt + 5 * DM;
    const x = await bt.runSymbol('OLDUSDT', { start: xSt, end: xEnd, s, btcClose });
    const pre = x.drops.filter(d => d.t < floor + 65 * MIN), post = x.drops.filter(d => d.t > floor + 80 * MIN);
    assert(pre.length > 0 && post.length > 0, `sınırın iki yanında tepe kaydı (${pre.length}/${post.length})`);
    assert(pre.every(d => d.feat.oiChg60 == null) && post.every(d => d.feat.oiChg60 != null), 'OI yalnız 30 gün sınırından sonra dolu');
    ok(`Funding/OI geçmişi: ${r.cards.length} kart + ${r.drops.length} tepe kaydında funding = t'ye kadar son ödenen oran (sonraki ödeme görünmüyor), kart OI 1s ve tepe oiChg15/oiChg60/oiUsd canlıyla aynı hesap; istek fundingRate ${nFr}, openInterestHist ${nOi}; 30 günden eski dönemde OI isteği yok ve boş (${old.drops.length} tepe), sınırı geçen dönemde ${pre.length} boş / ${post.length} dolu`); }

  // 7) Evren dönem başından önceki 24s hacme göre (bugünkü değil), dönem başında listelenmemiş coin yok, hayatta kalma
  { const { getPeriodLiquidSymbols } = require(`${REPO}/src/binanceClient`); const DM = D * MIN;
    const sel = async (startMs, o = {}) => (await getPeriodLiquidSymbols({ minVolume24hUSDT: 3e6, maxCoins: 0, excludeBaseAssets: [], start: startMs, ...o }));
    const a = await sel(ST3), has = (r, n) => r.symbols.includes(n);
    assert(!has(a, 'TODAYHIUSDT'), 'bugün hacmi yüksek ama dönem başında düşük coin seçilmemeli');
    assert(has(a, 'PASTHIUSDT'), 'dönem başında yüksek, bugün düşük coin seçilmeli');
    assert(!has(a, 'NEWUSDT'), 'dönem başında listelenmemiş coin seçilmemeli (look-ahead)');
    assert(has(a, 'DELISTUSDT'), 'dönem içinde kapanan (SETTLING) coin dönem başında listeliydi, seçilmeli');
    assert(!has(a, 'LOWUSDT') && !has(a, 'OLDUSDT'), 'düşük hacim elenmeli');
    // dönem başı 2 gün sonra: hacimler tersine döner; NEW artık uygun (listeleme ≥ 1 gün önce), DELIST dönem başında kapanmış
    const b = await sel(ST3 + 2 * DM);
    assert(has(b, 'TODAYHIUSDT') && !has(b, 'PASTHIUSDT') && has(b, 'NEWUSDT') && !has(b, 'DELISTUSDT'), b.symbols.join());
    // listeleme dönem başından önceki gün içinde: tam 24 saat yok → seçilmez
    const c = await sel(ST3 + DM); assert(!has(c, 'NEWUSDT'), 'önceki gün listelenen coin seçilmemeli');
    // --max-coins: dönem öncesi hacme göre en likit N (BTC 1., sonra PUMP)
    const d = await sel(ST3, { maxCoins: 2 }); assert.strictEqual(d.symbols.length, 2); assert.strictEqual(d.symbols[0], 'BTCUSDT');
    // REST: aday başına 1 istek (1d, limit 1) + exchangeInfo; bugünkü 24hr ticker çağrılmaz
    const h1 = hits.length; await sel(ST3); const mine = hits.slice(h1);
    assert.strictEqual(mine.filter(x => /^klines \S+ 1d 1$/.test(x)).length, 8); assert.strictEqual(mine.filter(x => x === 'exchangeInfo').length, 1); assert(!mine.includes('24hr'));
    ok(`Evren dönem öncesi hacme göre: dönem başı t0 → ${a.symbols.join(',')}; t0+2g → ${b.symbols.join(',')}; bugün-yüksek/dönem-düşük elendi, dönem-yüksek/bugün-düşük seçildi, listelenmemiş (NEW) elendi, SETTLING (DELIST) dönem başında seçildi; ${mine.length} istek (8 × 1d + exchangeInfo)`); }

  console.log(results.join('\n')); srv.close(); tg.srv.close(); process.exit(0);
})().catch(e => { console.log('❌ BAŞARISIZ:', e.stack || e.message); console.log(results.join('\n')); process.exit(1); });
