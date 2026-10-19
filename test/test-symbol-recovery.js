'use strict';

const assert = require('assert');
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
    const candles = Array.from({ length: count }, (_, i) => ({
      t: start + i * MIN, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true,
    }));
    sr.seed(tf, candles);
  }
  assert(sr.ready(), `${symbol} fixture must be ready`);
  return sr;
}

function rawCandles(startT, count) {
  return Array.from({ length: count }, (_, i) => {
    const t = startT + i * MIN;
    return [t, '101', '102', '100', '101.5', '10', t + MIN - 1, '1015', 0, '4', '406'];
  });
}

async function main() {
  const originalFetch = binance.fetchKlines;
  const originalResubscribe = binance.resubscribeWsSymbols;
  const now = Math.floor(Date.now() / MIN) * MIN;
  const lastT = now - 5 * MIN;
  const okSym = 'RECOVERYOKUSDT';
  const busySym = 'RECOVERYBUSYUSDT';
  const failSym = 'RECOVERYFAILUSDT';
  const attempts = new Map();
  const resubscribed = [];

  try {
    for (const sym of [okSym, busySym, failSym]) {
      internal.series.set(sym, makeReadySeries(sym, lastT));
      internal.busy.delete(sym);
      internal.pending.set(sym, []);
      internal.recoveryBlocked.delete(sym);
      internal.recoveryQueue.delete(sym);
    }
    internal.busy.add(busySym);

    binance.fetchKlines = async (symbol, interval) => {
      assert.strictEqual(interval, '1m');
      const n = (attempts.get(symbol) || 0) + 1;
      attempts.set(symbol, n);
      if (symbol === failSym && n === 1) throw new Error('simulated REST outage');
      return rawCandles(lastT + MIN, 4);
    };
    binance.resubscribeWsSymbols = symbols => { resubscribed.push(...symbols); return symbols; };

    const first = await internal.runRecoveryCycle();
    assert.strictEqual(first.outcomes[okSym], 'ok', 'healthy REST recovery should succeed');
    assert.strictEqual(first.outcomes[busySym], 'busy', 'busy symbol must not be silently dropped');
    assert.strictEqual(first.outcomes[failSym], 'REST failed', 'REST failure should be reported');
    assert(internal.recoveryBlocked.has(busySym), 'busy symbol signals must remain gated');
    assert(internal.recoveryQueue.has(busySym), 'busy symbol must be queued for retry');
    assert(internal.recoveryBlocked.has(failSym), 'failed recovery signals must remain gated');
    assert(internal.recoveryQueue.has(failSym), 'failed REST recovery must be queued for retry');
    assert(!internal.recoveryBlocked.has(okSym), 'successfully recovered symbol should be unblocked');
    assert(resubscribed.includes(okSym), 'successful REST recovery should request WebSocket resubscription');

    internal.busy.delete(busySym);
    const second = await internal.runRecoveryCycle();
    assert.strictEqual(second.outcomes[busySym], 'ok', 'busy symbol should recover on retry');
    assert.strictEqual(second.outcomes[failSym], 'ok', 'failed REST request should recover on retry');
    assert(!internal.recoveryBlocked.has(busySym), 'recovered busy symbol should be unblocked');
    assert(!internal.recoveryBlocked.has(failSym), 'recovered failed symbol should be unblocked');
    assert(!internal.recoveryQueue.has(busySym), 'recovered busy symbol should leave the queue');
    assert(!internal.recoveryQueue.has(failSym), 'recovered failed symbol should leave the queue');
    assert(internal.isFreshSymbol(okSym), 'recovered series should have a current 1m candle');

    console.log('PASS: per-symbol REST recovery, busy/failure retry, signal gating and resubscription');
  } finally {
    binance.fetchKlines = originalFetch;
    binance.resubscribeWsSymbols = originalResubscribe;
    for (const sym of [okSym, busySym, failSym]) {
      internal.series.delete(sym);
      internal.busy.delete(sym);
      internal.pending.delete(sym);
      internal.recoveryBlocked.delete(sym);
      internal.recoveryQueue.delete(sym);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
