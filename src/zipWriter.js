'use strict';

/**
 * Küçük ZIP yazıcı (ek paket yok, Node zlib) — büyük CSV'leri bellekte metin olarak biriktirmeden sıkıştırır.
 *
 *   const z = createZipSet('veri-2026-H42', { maxBytes: 40e6 });
 *   const e = z.entry('tepeler.csv', '﻿id,symbol,…\n');   // başlık her parçada tekrarlanır
 *   await e.write('satır\n'); …; await z.finish()  → [{ name: 'veri-2026-H42.zip', buf }]
 *
 * Telegram'ın dosya sınırı 50 MB: bir zip `maxBytes`'ı (sıkıştırılmış) aşarsa o anki dosya kapatılır ve
 * kalan satırlar yeni bir zip'e (`…-2.zip`, dosya adı `tepeler-2.csv`) yazılır.
 * Telefonda (Android / iOS Dosyalar) zip doğrudan açılır.
 */

const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosTime(d = new Date()) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** Sıkıştırılmış tek dosya girdisi (bellekte yalnız sıkıştırılmış hali durur) */
function createEntry(name) {
  const z = zlib.createDeflateRaw({ level: 6 });
  const chunks = [];
  let csize = 0, size = 0, crc = 0, pending = '';
  z.on('data', c => { chunks.push(c); csize += c.length; });
  const done = new Promise((res, rej) => { z.on('end', res); z.on('error', rej); });
  async function flush() {
    if (!pending) return;
    const b = Buffer.from(pending, 'utf8');
    pending = '';
    crc = crc32(b, crc); size += b.length;
    if (!z.write(b)) await new Promise(r => z.once('drain', r));
  }
  return {
    name,
    get compressed() { return csize; },
    get size() { return size; },
    /** Metin ekler (256 KB'lık dilimlerle sıkıştırıcıya verilir) */
    async write(s) { pending += s; if (pending.length >= 256 * 1024) await flush(); },
    async end() { await flush(); z.end(); await done; return { name, crc, size, csize, data: Buffer.concat(chunks) }; },
  };
}

/** Girdilerden zip dosyası (Buffer) */
function zipBuffer(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const parts = [], central = [];
  let off = 0;
  for (const e of entries) {
    const nm = Buffer.from(e.name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(e.crc, 14);
    lh.writeUInt32LE(e.csize, 18); lh.writeUInt32LE(e.size, 22); lh.writeUInt16LE(nm.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nm, e.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(e.crc, 16); ch.writeUInt32LE(e.csize, 20); ch.writeUInt32LE(e.size, 24);
    ch.writeUInt16LE(nm.length, 28); ch.writeUInt16LE(0, 30); ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38); ch.writeUInt32LE(off, 42);
    central.push(ch, nm);
    off += 30 + nm.length + e.data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16); end.writeUInt16LE(0, 20);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * Boyut sınırlı zip kümesi. entry(ad, başlık) → { write(satır), rows } ; finish() → [{ name, buf, type }]
 */
function createZipSet(base, { maxBytes = 40e6 } = {}) {
  const zips = [[]];                 // her biri tamamlanmış girdiler
  let used = 0;                      // geçerli zip'in sıkıştırılmış boyu (tamamlanmış girdiler)
  const open = [];
  function entry(fileName, header = '') {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName, ext = dot > 0 ? fileName.slice(dot) : '';
    let part = 1, cur = createEntry(fileName), started = false;
    const h = {
      rows: 0,
      async write(line) {
        if (!started) { started = true; await cur.write(header); }
        await cur.write(line);
        h.rows++;
        if (used + cur.compressed > maxBytes) {            // sınır: bu parçayı kapat, yeni zip'te devam
          zips[zips.length - 1].push(await cur.end());
          zips.push([]); used = 0; part++;
          cur = createEntry(`${stem}-${part}${ext}`); started = false;
        }
      },
      ended: false,
      async end() {
        if (h.ended) return;
        h.ended = true;
        if (!started) await cur.write(header);
        const e = await cur.end(); zips[zips.length - 1].push(e); used += e.csize;
      },
    };
    open.push(h);
    return h;
  }
  async function finish() {
    for (const h of open.splice(0)) await h.end();            // açık kalanlar (bitenler atlanır)
    const list = zips.filter(z => z.length);
    return list.map((z, i) => ({ name: `${base}${list.length > 1 ? `-${i + 1}` : ''}.zip`, buf: zipBuffer(z), type: 'application/zip' }));
  }
  return { entry, finish };
}

module.exports = { createZipSet, zipBuffer, createEntry, crc32 };
