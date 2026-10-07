'use strict';
/**
 * Tüm testleri sırayla çalıştırır: `npm test` (ya da `node test/run.js [ad …]`, ör. `node test/run.js drops weekly`).
 * Her test ayrı süreçte; ağ gerekmez (Binance / Telegram sahte sunucularla taklit edilir).
 * Geçici dosyalar test/.tmp'ye yazılır (git'e girmez).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ALL = ['info-unit', 'neg', 'breakout', 'move', 'counter', 'daily-levels', 'fib1h', 'fib', 'chart', 'chart1h', 'chart-touch',
  'touch', 'drops', 'weekly', 'info-e2e', 'info-bt'];
const want = process.argv.slice(2);
const list = want.length ? ALL.filter(n => want.some(w => n.includes(w))) : ALL;
const logDir = path.join(__dirname, '.tmp', 'logs');
fs.mkdirSync(logDir, { recursive: true });

let fail = 0;
for (const n of list) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(__dirname, `test-${n}.js`)], { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 64e6 });
  const out = (r.stdout || '') + (r.stderr || '');
  fs.writeFileSync(path.join(logDir, `${n}.log`), out);
  const ok = r.status === 0;
  if (!ok) fail++;
  console.log(`${ok ? '✅' : '❌'} ${n.padEnd(14)} ${((Date.now() - t0) / 1000).toFixed(1)} sn`);
  if (!ok) console.log(out.split('\n').slice(-15).map(l => '   ' + l).join('\n'));
}
console.log(`\n${list.length - fail}/${list.length} geçti · ayrıntı: test/.tmp/logs/`);
process.exit(fail ? 1 : 0);
