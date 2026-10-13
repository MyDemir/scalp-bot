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
 *   bilgisayara almak:  fly ssh sftp get /data/export/veri.zip
 * Çıktı zip (tepeler.csv · kartlar.csv · temaslar.csv) — haftalarca veride bile bellek şişmez.
 */

const { rowToStat } = require('./cardStore');
const { flatDrop, dropCols, csvLine, csvHeader } = require('./eventLog');
const { createZipSet } = require('./zipWriter');

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
 * Tek zip: tepeler.csv · kartlar.csv · temaslar.csv (40 MB'ı aşarsa veri-…-2.zip …). Tepe adayları parça parça okunur.
 * @param {object} store  cardStore
 * @returns {Promise<{files:{name, buf, type}[], counts:{tepeler, kartlar, temaslar}}>}
 */
async function buildExports(store, days = 30, now = Date.now(), { maxZipBytes = 40e6, base = 'veri' } = {}) {
  const since = now - days * 86_400_000;
  const zip = createZipSet(base, { maxBytes: maxZipBytes });
  const counts = { tepeler: 0, kartlar: 0, temaslar: 0 };
  const cols = dropCols(), te = zip.entry('tepeler.csv', csvHeader(cols));
  if (store.forEachEvent) await store.forEachEvent({ since }, async r => { counts.tepeler++; await te.write(csvLine(flatDrop(r), cols)); });
  await te.end();
  const cards = store.since(since).map(rowToStat).filter(r => r.kind === 'card').map(r => {
    const { bursts, text, kind, partial, done, ...rest } = r;
    return flatten({ ...rest, time: new Date(r.t).toISOString(), partial: partial ? 1 : 0 });
  });
  const tc = (store.touchesSince ? store.touchesSince(since) : []).map(r => flatten({ ...r, time: new Date(r.t).toISOString() }));
  for (const [name, rows, key] of [['kartlar.csv', cards, 'kartlar'], ['temaslar.csv', tc, 'temaslar']]) {
    const c = colsOf(rows), e = zip.entry(name, csvHeader(c));
    for (const r of rows) await e.write(csvLine(r, c));
    await e.end();
    counts[key] = rows.length;
  }
  return { files: await zip.finish(), counts };
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
  buildExports(store, days).then(({ files, counts }) => {
    for (const f of files) { fs.writeFileSync(require('path').join(dir, f.name), f.buf); console.log(`${f.name} → ${require('path').join(dir, f.name)}`); }
    console.log(`tepeler ${counts.tepeler} · kartlar ${counts.kartlar} · temaslar ${counts.temaslar} satır`);
    store.close();
  }).catch(err => { console.error(err); process.exit(1); });
}
