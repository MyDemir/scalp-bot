'use strict';
// Testlerin geçici dosyaları (veritabanı, grafik PNG, ayar, backtest çıktısı) → test/.tmp (git'e girmez)
const path = require('path'); const fs = require('fs');
const dir = path.join(__dirname, '.tmp');
fs.mkdirSync(dir, { recursive: true });
module.exports = dir;
