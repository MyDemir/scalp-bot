'use strict';
// Backfill kurtarma senaryoları: coin başına eksik mum ve son mum yaşı kontrolü, delik/eski veri
// kalan coin'in kurtarma kuyruğuna alınması, sınırlı paralellikte tohumlama ve REST weight bütçesi.

const assert = require('assert');
process.env.BINANCE_REST_WEIGHT_PER_MIN = '60000';   // 1 weight = 1 ms → bütçe ölçülebilir
const { Series, MIN } = require('../src/series');
const binance = require('../src/binanceClient');
const infoBot = require('../src/infoBot');

const internal = infoBot._internal;
const minimum = { '1m': 25, '3m': 60, '5m': 60, '15m': 40, '1h': 15, '4h': 0, '1d': 0 };

function makeReadySeries(symbol, lastT) {
  const sr = new Series(symbol);
  for (const [tf, count] of Object.entries(minimum)) {
    if (!count) continue;
    const start = tf === '1m' ? lastT - (count - 1) * MIN : Date.now() - count * MIN;
    sr.seed(tf, Array.from({ length: count }, (_, i) => ({ t: start + i * MIN, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true })));
  }
  return sr;
}
const raw = t => [t, '101', '102', '100', '101.5', '10', t + MIN - 1, '1015', 0, '4', '406'];

function reset(symbols) {
  for (const sym of symbols) {
    internal.series.delete(sym); internal.busy.delete(sym); internal.pending.delete(sym);
    internal.recoveryBlocked.delete(sym); internal.recoveryQueue.delete(sym);
    internal.recoveryAttempts.delete(sym); internal.recoveryNotBefore.delete(sym);
  }
}

async function main() {
  const originalFetch = binance.fetchKlines;
  const origWarn = console.warn, origErr = console.error, origLog = console.log;
  const now = Math.floor(Date.now() / MIN) * MIN;
  const lastT = now - 6 * MIN;
  const OK = 'COVOKUSDT', HOLE = 'COVHOLEUSDT', STALE = 'COVSTALEUSDT';
  const all = [OK, HOLE, STALE];
  try {
    console.warn = () => {}; console.error = () => {}; console.log = () => {};

    // ── checkCoverage birimi ───────────────────────────────────────────
    const fresh = makeReadySeries('UNIT', now - MIN);
    let cov = internal.checkCoverage(fresh, { now: now + 5_000 });
    assert.strictEqual(cov.ok, true); assert.strictEqual(cov.missing, 0); assert.strictEqual(cov.trailing, 0);
    cov = internal.checkCoverage(makeReadySeries('UNIT', now - 10 * MIN), { now });
    assert.strictEqual(cov.ok, false, 'last candle older than 3 min is stale');
    assert(cov.ageMs > 3 * MIN);
    const holed = makeReadySeries('UNIT', now - 4 * MIN);
    holed.apply1m({ t: now - MIN, o: 1, h: 1, l: 1, c: 1, v: 1, closed: true });
    cov = internal.checkCoverage(holed, { since: now - 4 * MIN, now });
    assert.strictEqual(cov.missing, 2, 'two missing 1m candles detected');
    assert.strictEqual(internal.checkCoverage(holed, { since: now - MIN, now }).missing, 0, 'holes before `since` are ignored');
    assert.strictEqual(internal.checkCoverage(new Series('EMPTY')).ok, false, 'empty series is not covered');

    // ── backfillGap: eksik mumlu ve eski veri döndüren coin "ok" sayılmaz ─────
    for (const sym of all) { reset([sym]); internal.series.set(sym, makeReadySeries(sym, lastT)); }
    binance.fetchKlines = async (symbol) => {
      const ts = [];
      for (let t = lastT + MIN; t <= now - MIN; t += MIN) ts.push(t);
      if (symbol === HOLE) return ts.filter(t => t !== lastT + 2 * MIN).map(raw);   // ortada bir mum eksik
      if (symbol === STALE) return ts.slice(0, 1).map(raw);                          // REST de geride
      return ts.map(raw);
    };
    const result = await internal.backfillGap(all, Date.now() - 2 * MIN);
    assert.strictEqual(result.outcomes[OK], 'ok');
    assert.strictEqual(result.outcomes[HOLE], 'incomplete');
    assert.strictEqual(result.coverage[HOLE].missing, 1);
    assert.strictEqual(result.outcomes[STALE], 'stale');
    assert(result.coverage[STALE].ageMs > 3 * MIN);
    assert.strictEqual(internal.gapMetrics.lastIncomplete, 1);
    assert.strictEqual(internal.gapMetrics.lastStale, 1);
    assert(internal.recoveryBlocked.has(HOLE) && internal.recoveryQueue.has(HOLE), 'holed coin is blocked and queued for recovery');
    assert(internal.recoveryBlocked.has(STALE) && internal.recoveryQueue.has(STALE), 'stale coin is blocked and queued for recovery');
    assert(!internal.recoveryBlocked.has(OK), 'fully recovered coin keeps signalling');
    for (const sym of all) assert(!internal.busy.has(sym), `${sym} busy flag released`);

    // ── Kurtarma döngüsü: REST düzelince kilit kalkar ──────────────────────
    binance.fetchKlines = async () => { const ts = []; for (let t = lastT + MIN; t <= now - MIN; t += MIN) ts.push(t); return ts.map(raw); };
    const origResub = binance.resubscribeWsSymbols; binance.resubscribeWsSymbols = s => s;
    try {
      const cycle = await internal.runRecoveryCycle();
      assert.strictEqual(cycle.outcomes[STALE], 'ok', 'stale coin recovers once REST is current');
      assert(!internal.recoveryBlocked.has(STALE), 'stale coin unblocked after recovery');
    } finally { binance.resubscribeWsSymbols = origResub; }

    // ── Uzun süre geride kalan coin kendi son mumundan itibaren doldurulur ──
    reset(all);
    const behind = 'COVBEHINDUSDT';
    const behindLast = now - 30 * MIN;
    internal.series.set(behind, makeReadySeries(behind, behindLast));
    let askedLimit = 0;
    binance.fetchKlines = async (symbol, tf, limit) => {
      askedLimit = limit;
      const ts = []; for (let t = now - (limit - 1) * MIN; t <= now - MIN; t += MIN) ts.push(t);
      return ts.map(raw);
    };
    const r2 = await internal.backfillGap([behind], Date.now() - 2 * MIN);
    assert(askedLimit >= 31, `fetch limit covers the coin's own gap (asked ${askedLimit})`);
    assert.strictEqual(r2.outcomes[behind], 'ok', 'no hole left for a coin that was already behind');
    reset([behind]);

    // ── seedMany: sınırlı paralellik ───────────────────────────────────
    const seedSyms = Array.from({ length: 10 }, (_, i) => `SEEDPAR${i}USDT`);
    for (const s of seedSyms) internal.series.set(s, new Series(s));
    let active = 0, peak = 0;
    binance.fetchKlines = async (symbol, tf, limit) => {
      active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
      const ms = { '1m': MIN, '3m': 3 * MIN, '5m': 5 * MIN, '15m': 15 * MIN, '1h': 60 * MIN, '4h': 240 * MIN, '1d': 1440 * MIN }[tf];
      const endT = Math.floor(Date.now() / ms) * ms - ms;
      return Array.from({ length: Math.min(limit, 80) }, (_, i) => raw(endT - i * ms)).reverse().map(r => { r[6] = r[0] + ms - 1; return r; });
    };
    await internal.seedMany(seedSyms, 'test');
    assert(peak > 1 && peak <= 8, `seeding runs with bounded concurrency (peak ${peak})`);
    assert.strictEqual(internal.seedMetrics.lastSymbols, seedSyms.length);
    assert.strictEqual(internal.seedMetrics.lastFailures, 0);
    for (const s of seedSyms) assert(!internal.busy.has(s), `${s} released after seed`);
    reset(seedSyms);
  } finally {
    binance.fetchKlines = originalFetch;
    console.warn = origWarn; console.error = origErr; console.log = origLog;
    reset([...all, 'COVBEHINDUSDT']);
  }

  // ── REST weight bütçesi: paralel istekler dakikalık bütçeyi aşmaz ─────────
  const t0 = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => binance.call(5, 'budget', async () => true)));
  const elapsed = Date.now() - t0;
  assert(elapsed >= 90, `20 × weight 5 at 60000/min must take ≥ ~95 ms (took ${elapsed} ms)`);
  assert(binance.restBacklogMs() >= 0);

  console.log('PASS: per-coin missing-candle & last-candle-age checks, recovery of holed/stale coins, bounded seed concurrency, REST weight budget');
}

main().then(() => process.exit(process.exitCode || 0)).catch(err => { console.error(err); process.exit(1); });
