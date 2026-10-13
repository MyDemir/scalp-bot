'use strict';
// Testler için küçük zip okuyucu: { 'ad.csv': 'metin', … } (merkezi dizinden)
const zlib = require('zlib');
module.exports = function unzip(buf) {
  const out = {};
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('zip değil');
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('merkezi dizin bozuk');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(off + 26), lxl = buf.readUInt16LE(off + 28);
    const data = buf.slice(off + 30 + lnl + lxl, off + 30 + lnl + lxl + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    if (raw.length !== size) throw new Error('boy uyuşmuyor: ' + name);
    out[name] = raw.toString('utf8');
    p += 46 + nl + xl + cl;
  }
  return out;
};
