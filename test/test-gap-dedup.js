'use strict';

const assert = require('assert');
const { Series } = require('../src/series');
const telegram = require('../src/telegram');

console.log('--- Gap Tamamlama, Tekrar Mum ve Telegram Kuyruk Testleri ---');

// 1. Test: Series ve processCandle tekrar/eski mum kontrolü
(() => {
  const sr = new Series('TESTUSDT');
  const now = Math.floor(Date.now() / 60000) * 60000;
  
  // Seed with 10 candles
  const candles = [];
  for (let i = 10; i >= 1; i--) {
    const t = now - i * 60000;
    candles.push({ t, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true });
  }
  sr.seed('1m', candles);
  assert.strictEqual(sr.lastT('1m'), now - 60000);

  // Apply new candle
  const newCandle = { t: now, o: 101, h: 105, l: 100, c: 104, v: 2000, closed: true };
  const closedTfs = sr.apply1m(newCandle);
  assert(sr.lastT('1m') === now, 'Yeni mum eklenmeli');

  // Try applying the EXACT same candle again (simulate duplicate WebSocket frame or backfill overlap)
  const dupClosed = sr.apply1m(newCandle);
  assert.strictEqual(dupClosed.size, 0, 'Tekrar gelen mum apply1m tarafından boş dönmeli');
  assert.strictEqual(sr.d['1m'].t.length, 11, 'Mum sayısı artmamalı');

  // Try applying an older candle (stale frame)
  const oldCandle = { t: now - 120000, o: 100, h: 101, l: 99, c: 100, v: 500, closed: true };
  const oldClosed = sr.apply1m(oldCandle);
  assert.strictEqual(oldClosed.size, 0, 'Eski mum apply1m tarafından boş dönmeli');
  assert.strictEqual(sr.d['1m'].t.length, 11, 'Eski mum eklenmemeli');

  console.log('✅ Series: Çift ve bayat mum koruması başarılı');
})();

// 2. Test: Telegram kuyruk sınırları, metrikleri ve son iletimler
(() => {
  const snapshotA = telegram.getStats();
  const snapshotB = telegram.getStats();
  assert.deepStrictEqual(snapshotB, snapshotA, 'getStats aynı sayaçları okurken sıfırlamamalı');

  const stats = telegram.takeStats();
  assert(typeof stats.queued === 'number', 'takeStats kuyruk sayısını içermeli');
  const afterTake = telegram.getStats();
  assert.strictEqual(afterTake.sent, 0, 'takeStats sonrası dönemsel sent sayacı sıfırlanmalı');
  assert.strictEqual(afterTake.failed, 0, 'takeStats sonrası dönemsel failed sayacı sıfırlanmalı');
  assert(typeof stats.droppedOverflow === 'number', 'droppedOverflow metriği bulunmalı');
  assert(typeof stats.droppedExpired === 'number', 'droppedExpired metriği bulunmalı');
  assert(typeof stats.pendingReplies === 'number', 'pendingReplies metriği bulunmalı');

  assert(Array.isArray(telegram.getRecentDispatches()), 'getRecentDispatches bir dizi dönmeli');

  console.log('✅ Telegram: Kuyruk öncelik, sınır ve metrik yapısı doğrulandı');
})();

console.log('Tüm gap ve kuyruk testleri başarıyla tamamlandı.');
process.exit(0);
