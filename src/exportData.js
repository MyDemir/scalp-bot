'use strict';

/**
 * İstatistik verisini CSV olarak dışa aktarma — kendi analizin için (Excel / Google Sheets / Python).
 *   tepeler.csv  : tepe defteri (src/eventLog.js) — her satır bir pompa tepe adayı (outcome: düştü / devam / yatay); kartlı/kartsız,
 *                  tepe anındaki tüm göstergeler (RSI 3/5/15dk/1s/4s, EMA21 uzaklıkları, MACD, Stoch, VWAP σ,
 *                  hacim katları, alış %, seviye, kontrol listesi, eksik şartlar …) + 5/15/60/240 dk sonrası
 *   kartlar.csv  : gönderilen kartlar + kart anındaki göstergeler + 15/60/240 dk sonrası
 *   temaslar.csv : seviye tepkisi (src/levelTouch.js) — dirence temas + 60 dk sonrası, dibin indiği EMA21
 * Biçim: UTF-8 (BOM'lu), virgülle ayrılmış, ondalık nokta. Zamanlar ISO (UTC).
 *
 * Telegram: /disaaktar [gün] (yönetici) → dosyalar özelden gelir.
 * Komut satırı (Fly makinesinde):  node src/exportData.js --days 30 --out /data/export
 *   bilgisayara almak:  fly ssh sftp get /data/export/tepeler.csv
 */

const { rowToStat } = require('./cardStore');
const { toCsv, flatDrop, dropCols } = require('./eventLog');

/** İç içe nesneyi tek seviyeye indirir: { rsi: { '3m': 90 } } → { rsi_3m: 90 }; diziler "a|b" */
function flatten(o, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = Array.isArray(v) ? v.map(x => (typeof x === 'object' ? JSON.stringify(x) : x)).join('|') : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}
const colsOf = rows => { const set = new Set(); for (const r of rows) for (const k of Object.keys(r)) set.add(k); return [...set]; };

/**
 * @param {object} store  cardStore
 * @returns {{name:string, csv:string, n:number}[]}
 */
function buildExports(store, days = 30, now = Date.now()) {
  const since = now - days * 86_400_000;
  const out = [];
  const ev = store.eventsSince ? store.eventsSince(since) : [];
  out.push({ name: 'tepeler.csv', n: ev.length, csv: toCsv(ev.map(r => flatDrop(r)), dropCols()) });
  const cards = store.since(since).map(rowToStat).filter(r => r.kind === 'card').map(r => {
    const { bursts, text, kind, partial, done, ...rest } = r;
    return flatten({ ...rest, time: new Date(r.t).toISOString(), partial: partial ? 1 : 0 });
  });
  out.push({ name: 'kartlar.csv', n: cards.length, csv: toCsv(cards, colsOf(cards)) });
  const tc = (store.touchesSince ? store.touchesSince(since) : []).map(r => flatten({ ...r, time: new Date(r.t).toISOString() }));
  out.push({ name: 'temaslar.csv', n: tc.length, csv: toCsv(tc, colsOf(tc)) });
  return out;
}

module.exports = { buildExports, flatten };

if (require.main === module) {
  const a = process.argv.slice(2);
  const arg = (k, d) => { const i = a.indexOf(`--${k}`); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const days = Number(arg('days', 30));
  const dir = arg('out', require('path').join(process.env.DB_PATH ? require('path').dirname(process.env.DB_PATH) : 'data', 'export'));
  const fs = require('fs');
  const { createCardStore } = require('./cardStore');
  const store = createCardStore({ recover: false });      // çalışan botun yarım takiplerine dokunma
  if (!store.enabled()) { console.error('Veritabanı açılamadı'); process.exit(1); }
  fs.mkdirSync(dir, { recursive: true });
  for (const f of buildExports(store, days)) {
    fs.writeFileSync(require('path').join(dir, f.name), f.csv);
    console.log(`${f.name}: ${f.n} satır → ${require('path').join(dir, f.name)}`);
  }
  store.close();
}
