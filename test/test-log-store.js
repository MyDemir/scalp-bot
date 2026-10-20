'use strict';
// Kalıcı olay günlüğü: diske yazma, yeniden başlatmada geri yükleme, gün/seviye/arama filtresi,
// dışa aktarma ve saklama süresi (eski günlerin silinmesi).

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createLogStore, dayOf } = require('../src/logStore');

const dir = path.join(__dirname, '.tmp', 'log-store');
fs.rmSync(dir, { recursive: true, force: true });

const DAY = 86_400_000;
let time = Date.UTC(2026, 9, 20, 12, 0, 0);
const now = () => time;

const a = createLogStore({ dir, now, retentionDays: 14 });
assert(a.enabled());
a.append({ t: time - 20 * DAY, level: 'error', tag: 'ESKI', message: 'çok eski' });
a.append({ t: time - DAY, level: 'warn', tag: 'WS', message: 'dün uyarı' });
a.append({ t: time - 60_000, level: 'error', tag: 'REST', message: 'klines SEIUSDT ECONNRESET' });
a.append({ t: time - 30_000, level: 'info', tag: 'HEARTBEAT', message: 'WS 1/1 bağlı' });
a.append({ t: time, level: 'error', tag: 'TELEGRAM', message: 'x'.repeat(10_000) });
a.flush();

// Yeni süreç (yeniden başlatma) aynı klasörden okur
const b = createLogStore({ dir, now, retentionDays: 14 });
const today = dayOf(time);
assert.deepStrictEqual(b.days(), [today, dayOf(time - DAY), dayOf(time - 20 * DAY)]);
const all = b.query({ day: today });
assert.strictEqual(all.total, 3);
assert.strictEqual(all.entries[0].tag, 'TELEGRAM', 'newest first');
assert(all.entries[0].message.length <= 4000, 'long messages are capped');
assert.strictEqual(b.query({ day: today, level: 'error' }).total, 2);
assert.strictEqual(b.query({ day: today, q: 'seiusdt' }).entries[0].tag, 'REST', 'search is case-insensitive');
assert.strictEqual(b.query({ day: '../../etc' }).total, 0, 'invalid day is rejected');
assert.strictEqual(b.recent(4).length, 4, 'restores newest entries across days');
assert.strictEqual(b.recent(4)[3].message, 'dün uyarı');
const sum = b.summary().find(d => d.day === today);
assert.deepStrictEqual([sum.total, sum.errors, sum.warnings], [3, 2, 0]);
assert(b.exportDay(today).toString().split('\n').filter(Boolean).every(l => JSON.parse(l).t), 'export is JSON lines');
assert.strictEqual(b.exportDay('2020-01-01'), null);

assert.strictEqual(b.prune(), 1, 'days older than retention are deleted');
assert(!b.days().includes(dayOf(time - 20 * DAY)));

const off = createLogStore({ dir, disabled: true });
off.append({ t: time, level: 'error', tag: 'X', message: 'y' });
assert.strictEqual(off.enabled(), false);
assert.deepStrictEqual(off.days(), []);

fs.rmSync(dir, { recursive: true, force: true });
console.log('PASS: persistent log store — write, restore after restart, day/level/search filters, export, retention');
