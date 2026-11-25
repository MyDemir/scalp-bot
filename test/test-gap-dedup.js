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
  // Kuyruk limiti reply mesajlarıyla doluyken de katı olmalı; yeni sinyal kuyruğu büyütmemeli.
  const queue = telegram._internal.queue;
  queue.length = 0;
  const queueLimit = Math.max(1, Math.floor(Number(process.env.TELEGRAM_MAX_QUEUE_LEN) || 250));
  for (let i = 0; i < queueLimit; i++) {
    queue.push({ kind: 'reply', chatId: 'test', text: 'reply-' + i, createdAt: Date.now() });
  }
  const beforeOverflow = telegram.getStats().droppedOverflow;
  const accepted = telegram._internal.enqueue('alert', 'test', 'overflow-alert');
  assert.strictEqual(accepted, false, 'reply-only full queue must reject a lower-priority alert');
  assert.strictEqual(queue.length, queueLimit, 'queue length must never exceed configured cap');
  assert.strictEqual(telegram.getStats().droppedOverflow, beforeOverflow + 1, 'dropped alert must be counted');
  queue.length = 0;


  console.log('✅ Telegram: Kuyruk öncelik, sınır ve metrik yapısı doğrulandı');
})();

// 3. Test (S1-100): 1m akışında 10 dk boşluk — mevcut davranış sabitlenir (src değişmeden)
(() => {
  const { MIN } = require('../src/series');
  const infoBot = require('../src/infoBot'); const I = infoBot._internal;
  const minimum = { '1m': 25, '3m': 60, '5m': 60, '15m': 40, '1h': 15, '4h': 0, '1d': 0 };
  const now = Math.floor(Date.now() / MIN) * MIN;
  // Hizalı fixture: 1m son mumu lastT; üst TF'ler lastT+1dk'dan önce kapanan son periyoda kadar
  const TFM = { '3m': 3, '5m': 5, '15m': 15, '1h': 60 };
  const mkReady = (sym, lastT) => {
    const sr = new Series(sym);
    sr.seed('1m', Array.from({ length: 25 }, (_, i) => ({ t: lastT - (24 - i) * MIN, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true })));
    for (const [tf, count] of Object.entries(minimum)) {
      if (!count || tf === '1m') continue;
      const ms = TFM[tf] * MIN, end = Math.floor((lastT + MIN) / ms) * ms - ms;
      sr.seed(tf, Array.from({ length: count }, (_, i) => ({ t: end - (count - 1 - i) * ms, o: 100, h: 102, l: 99, c: 101, v: 1000, closed: true })));
    }
    assert(sr.ready(), sym + ' hazır olmalı');
    return sr;
  };
  const clear = sym => { I.recoveryBlocked.delete(sym); I.recoveryQueue.delete(sym); I.series.delete(sym); };
  const quiet = (fn) => { const w = console.warn, e = console.error, l = console.log; console.warn = console.error = console.log = () => {}; try { return fn(); } finally { console.warn = w; console.error = e; console.log = l; } };
  const candle = t => ({ t, o: 101, h: 102, l: 100, c: 101, v: 1000, tb: 500, q: 101000, tq: 50500, closed: true });

  // (a) Taze ama içinde boşluk olan akış: scanStaleRecovery kilitlemez (yalnız SON mum yaşına bakar);
  //     processCandle boşluklu mumu uygular, kilit koymaz; boşluk checkCoverage'da görünür, Series'te "eksik" işaretlenir.
  const A = 'GAPAUSDT'; clear(A);
  const base = Math.floor(now / (60 * MIN)) * 60 * MIN - 2 * 60 * MIN;     // saat başı (3/5/15 dk hizalı), geçmişte
  I.series.set(A, mkReady(A, base - MIN));
  const srA = I.series.get(A);
  for (let i = 0; i <= 2; i++) quiet(() => I.processCandle(srA, candle(base + i * MIN), true));   // base..base+2 canlı (5m ve 15m dilimi yarım)
  const resumeT = base + 13 * MIN;                                          // base+3 .. base+12 = 10 dk eksik
  const feedN = 20;                                                         // boşluk sonrası 20 ardışık canlı mum
  for (let i = 0; i < feedN; i++) quiet(() => I.processCandle(srA, candle(resumeT + i * MIN), true));
  assert.strictEqual(srA.lastT('1m'), resumeT + (feedN - 1) * MIN, 'boşluk sonrası mumlar seriye uygulanır');
  const nowA = resumeT + feedN * MIN + 5_000;
  quiet(() => I.scanStaleRecovery(nowA));
  assert(!I.recoveryBlocked.has(A), 'son mum taze: scanStaleRecovery kilitlemez (kilit yalnız bayat akışta)');
  const cov = I.checkCoverage(srA, { since: base - MIN, now: nowA });
  assert.strictEqual(cov.missing, 10, 'checkCoverage 10 dk boşluğu sayar'); assert.strictEqual(cov.ok, false, 'boşluk varken ok=false');
  const inc = ['3m', '5m', '15m'].filter(tf => srA.incomplete(tf, 14) > 0);
  assert.deepStrictEqual(inc, ['3m', '5m', '15m'], 'boşluktan etkilenen 3m/5m/15m mumları eksik işaretli (incTf kaynağı): ' + inc);
  assert.strictEqual(srA.incomplete('1h', 1), 0, 'boşluk 1h dilimine değmeden bitti ve 1h henüz kapanmadı');
  clear(A);

  // (a2) Dilim sınırına HİZALI boşluk: seed'den sonra tam bir 5m dilimi (ve 3m dilimleri) hiç 1m gelmez → sonraki mum eksik işaretli.
  const A2 = 'GAPA2USDT'; clear(A2);
  const base2 = Math.floor(now / (60 * MIN)) * 60 * MIN - 2 * 60 * MIN;
  I.series.set(A2, mkReady(A2, base2 - MIN));
  const srA2 = I.series.get(A2);
  const n5 = srA2.count('5m'), n15 = srA2.count('15m');
  for (let i = 0; i < 4; i++) quiet(() => I.processCandle(srA2, candle(base2 + 5 * MIN + i * MIN), true));   // base2..+4 hiç gelmedi (tam 5m dilimi)
  quiet(() => I.processCandle(srA2, candle(base2 + 9 * MIN), true));   // 5m dilimi base2+5 kapanır, öncesinde boş dilim var
  assert.strictEqual(srA2.count('5m'), n5 + 1, 'sahte mum eklenmez (yalnız gelen dilim)');
  assert.strictEqual(srA2.incomplete('5m', 14), 1, 'hizalı 5m boşluğu inc5 > 0');
  assert.strictEqual(srA2.incomplete('15m', 14), 0, '15m dilimi henüz kapanmadı');
  assert.strictEqual(srA2.count('15m'), n15);
  clear(A2);

  // (b) Bayat akış (son mum 10 dk önce): kilitlenir + kurtarma kuyruğuna girer; kilitliyken canlı mum seriye işlenir
  //     ama değerlendirme (kart) atlanır ve sayılır.
  const B = 'GAPBUSDT'; clear(B);
  I.series.set(B, mkReady(B, now - 10 * MIN));
  quiet(() => I.scanStaleRecovery(now));
  assert(I.recoveryBlocked.has(B) && I.recoveryQueue.has(B), 'bayat akış kilitlenir ve kuyruğa alınır');
  const srB = I.series.get(B); const be0 = I.stats.blockedEvals, cards0 = I.stats.cards;
  quiet(() => I.processCandle(srB, candle(now - MIN), true));
  assert.strictEqual(I.stats.blockedEvals, be0 + 1, 'kilitte atlanan değerlendirme sayılır');
  assert.strictEqual(I.stats.cards, cards0, 'kilitliyken kart üretilmez');
  assert.strictEqual(srB.lastT('1m'), now - MIN, 'mum seriye yine de işlenir');
  clear(B);
  console.log('✅ Veri boşluğu: taze+delikli akış kilitlenmez ama checkCoverage/incomplete işaretler; bayat akış kilitlenir, kilitte kart yok');
})();

console.log('Tüm gap ve kuyruk testleri başarıyla tamamlandı.');
process.exit(0);
