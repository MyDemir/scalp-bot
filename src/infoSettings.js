'use strict';

/**
 * Bilgi botu ayarları.
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

const DEFS = [
  { key: 'grade4Min', short: '4 daire skor', label: '4 daire için en az güven skoru', type: 'int', min: 1, max: 15, step: 1 },
  { key: 'seriesMinRsi15m', short: 'Seri 15m RSI', label: 'Seri içi kart için min 15m RSI', type: 'int', min: 50, max: 100, step: 1 },
  { key: 'sfpAbovePct', short: 'SFP üst %', label: 'SFP kırılım eşiği %', type: 'num', min: 0.1, max: 2, step: 0.1 },
  { key: 'sepPct2', short: 'EMA %2', label: 'EMA21 ayrışma ≥ %2', type: 'num', min: 0.5, max: 20, step: 0.5 },
  { key: 'sepPct5', short: 'EMA %5', label: 'EMA21 ayrışma ≥ %5', type: 'num', min: 1, max: 30, step: 0.5 },
  { key: 'sepPct10', short: 'EMA %10', label: 'EMA21 ayrışma ≥ %10', type: 'num', min: 2, max: 50, step: 0.5 },
  { key: 'chartMinTouches', short: 'Grafik temas', label: 'Grafik: direnç için en az … temas (4s mumlar)', type: 'int', min: 1, max: 10, step: 1 },
  { key: 'levelsWeeklyZone', short: 'Haftalık bölge', label: 'Direnç: haftalık bölge', type: 'bool' },
  { key: 'rsiMin', short: 'Kart eşiği', label: 'Kart eşiği RSI (🔴)', type: 'int', min: 50, max: 100, step: 1 },
  { key: 'rsiMin2', short: 'RSI 🔴🔴', label: 'RSI 🔴🔴 işareti', type: 'int', min: 50, max: 100, step: 1 },
  { key: 'rsiEntryMax', short: 'RSI üst sınır', label: 'Kontrol: 3m/5m RSI aralığı üstü', type: 'int', min: 80, max: 100, step: 1 },
  { key: 'confluencePct', short: 'Çakışma %', label: 'Kontrol: çakışan direnç mesafesi %', type: 'num', min: 0.1, max: 3, step: 0.1 },
  { key: 'gradeBy', short: 'Derece hesabı', label: 'Derece: sart3 = ayrışma + 1s RSI + 15dk RSI şartları · liste = kontrol listesi skoru', type: 'enum', options: ['sart3', 'liste'] },
  { key: 'gradeRsi1h', short: 'Derece 1s RSI', label: 'Derece şartı: 1s RSI ≥', type: 'num', min: 50, max: 100, step: 1 },
  { key: 'gradeRsi15m', short: 'Derece 15dk RSI', label: 'Derece şartı: 15dk RSI ≥', type: 'num', min: 50, max: 100, step: 1 },
  { key: 'gradeRsi1hMax', short: 'Kaçak: 1s RSI', label: 'Kaçak pompa: 1s RSI ≥ (1s şartı da bunun altında sayılır; 0 = kapalı)', type: 'num', min: 0, max: 100, step: 1 },
  { key: 'gradeRsi4hMax', short: 'Kaçak: 4s RSI', label: 'Kaçak pompa: 4s RSI ≥ (0 = kapalı)', type: 'num', min: 0, max: 100, step: 1 },
  { key: 'gradeRunawayMax', short: 'Kaçakta en çok', label: 'Derece: kaçak pompada en fazla … daire', type: 'int', min: 1, max: 4, step: 1 },
  { key: 'gradeNoLevelMax', short: 'Dirençsiz en çok', label: 'Derece: direnç yoksa (fiyat keşfi) en fazla … daire', type: 'int', min: 1, max: 4, step: 1 },
  { key: 'grade2Min', short: '🔴🔴 skor', label: '🔴🔴 için en az kontrol skoru', type: 'int', min: 1, max: 15, step: 1 },
  { key: 'grade3Min', short: '🔴🔴🔴 skor', label: '🔴🔴🔴 için en az kontrol skoru', type: 'int', min: 1, max: 15, step: 1 },
  { key: 'rsiPeriod', short: 'RSI periyot', label: 'RSI periyodu', type: 'int', min: 2, max: 30, step: 1 },
  { key: 'minTFs', short: 'Dilim sayısı', label: 'Eşiği geçen dilim (3m/5m/15m)', type: 'int', min: 1, max: 3, step: 1 },
  { key: 'strongRsi', short: 'RSI 🔴🔴🔴', label: 'RSI 🔴🔴🔴 (satırda) eşiği', type: 'int', min: 60, max: 100, step: 1 },
  { key: 'levelMaxPct', short: 'Uzaklık %', label: 'Seviyeye yakınlık %', type: 'num', min: 0.5, max: 10, step: 0.5 },
  { key: 'levelRequired', short: 'Seviye şartı', label: 'Seviye şartı', type: 'bool' },
  { key: 'levelsSwing', short: 'Salınım tepeleri', label: 'Direnç: 1h/4h salınım tepeleri', type: 'bool' },
  { key: 'swingBars', short: 'Salınım mum', label: 'Salınım tepesi: iki yanında en az … mum', type: 'int', min: 2, max: 10, step: 1 },
  { key: 'zoneTouches', short: 'Bölge teması', label: 'Günlük bölge: en az … temas', type: 'int', min: 2, max: 6, step: 1 },
  { key: 'levelsFib', short: 'Fib seviyeleri', label: 'Direnç: son 1h bacağın Fib 0.236/0.382/0.618', type: 'bool' },
  { key: 'sfpCards', short: 'Sahte kırılım', label: 'Sahte kırılım (SFP) kartı', type: 'bool' },
  { key: 'sfpBars', short: 'SFP süresi', label: 'Sahte kırılım: kırılımdan sonra en fazla … 5m mum', type: 'int', min: 1, max: 24, step: 1 },
  { key: 'discoveryCards', short: 'Fiyat keşfi', label: 'Fiyat keşfi kartı (yakında direnç yok, seviye kırıldı)', type: 'bool' },
  { key: 'dipBelowPct', short: 'Dirençte alt %', label: 'Dirençte: direncin en fazla % altında', type: 'num', min: 0.1, max: 3, step: 0.1 },
  { key: 'dipAbovePct', short: 'Dirençte üst %', label: 'Dirençte: direncin en fazla % üstünde (fitil payı)', type: 'num', min: 0, max: 2, step: 0.1 },
  { key: 'burstPct1', short: 'Patlama1 %', label: 'Patlama gövde % (1. kademe)', type: 'num', min: 0.2, max: 10, step: 0.1 },
  { key: 'burstPct2', short: 'Patlama2 %', label: 'Patlama gövde % (2. kademe)', type: 'num', min: 0.2, max: 10, step: 0.1 },
  { key: 'volMult', short: 'Hacim ×', label: 'Hacim katı (×ortalama)', type: 'num', min: 1, max: 10, step: 0.5 },
  { key: 'volAvgN', short: 'Ort. mum', label: 'Hacim ortalaması (mum)', type: 'int', min: 5, max: 100, step: 5 },
  { key: 'takerBuyPct', short: 'Alım >%', label: 'Alım: taker > %', type: 'int', min: 50, max: 90, step: 1 },
  { key: 'takerSellPct', short: 'Satış <%', label: 'Satış: taker < %', type: 'int', min: 10, max: 50, step: 1 },
  { key: 'volGrade2X', short: 'Hacim 🔴🔴 ×', label: 'Hacim 🔴🔴: ortalamanın en az … katı', type: 'num', min: 1, max: 20, step: 0.5 },
  { key: 'dirGrade3Pct', short: 'Yön 🔴🔴🔴 %', label: 'Hacim 🔴🔴🔴: yön uyumu (alış/satış) ≥ %', type: 'int', min: 50, max: 95, step: 1 },
  { key: 'windowMin', short: 'Pencere dk', label: 'Sayaç penceresi (dk)', type: 'int', min: 15, max: 200, step: 15 },
  { key: 'shortWindowMin', short: 'Kısa dk', label: 'Kısa pencere (dk)', type: 'int', min: 5, max: 60, step: 5 },
  { key: 'resetRsi', short: 'Sıfırlama RSI', label: 'Kart no. sıfırlama (15m RSI <)', type: 'int', min: 40, max: 95, step: 1 },
  { key: 'seriesBursts', short: 'Seri patlama', label: 'Seri içi patlama (15m RSI ≥ seriesMinRsi15m)', type: 'bool' },
  { key: 'sepATR', short: 'Ayrışma ATR', label: 'EMA21 ayrışma (ATR)', type: 'num', min: 0, max: 5, step: 0.1 },
  { key: 'sepRequired', short: 'Ayrışma şartı', label: 'Ayrışma şartı', type: 'bool' },
  { key: 'confRsi', short: 'Destek RSI', label: 'Kontrol: 1h/4h RSI şişkin ≥', type: 'int', min: 50, max: 95, step: 1 },
  { key: 'confRequired', short: 'Destek şartı', label: 'Destek şartı (1h/4h biri)', type: 'bool' },
  { key: 'macdRequired', short: 'MACD şartı', label: 'MACD 5m zayıflama şartı', type: 'bool' },
  { key: 'moveAlertPct', short: 'Hareket %', label: 'Hareket: 1 dk ≥ % (RSI kartına eklenir · 0 = kapalı)', type: 'num', min: 0, max: 20, step: 0.5 },
  { key: 'cardSound', short: 'Kart sesli', label: 'Her kart bildirimli (sesli)', type: 'bool' },
  { key: 'chart', short: 'Grafik', label: 'Kartlarda grafik', type: 'bool' },
  { key: 'chartTf', short: 'Grafik TF', label: 'Grafik zaman dilimi', type: 'enum', options: ['5m', '15m', '1h', '4h'] },
  { key: 'chartFib', short: 'Fibonacci', label: 'Grafikte Fibonacci', type: 'bool' },
  { key: 'chartIchi', short: 'Ichimoku', label: 'Grafikte Ichimoku', type: 'bool' },
  { key: 'ichiTenkan', short: 'Tenkan', label: 'Ichimoku Tenkan', type: 'int', min: 2, max: 100, step: 1, menu: false },
  { key: 'ichiKijun', short: 'Kijun', label: 'Ichimoku Kijun', type: 'int', min: 2, max: 200, step: 1, menu: false },
  { key: 'ichiChikou', short: 'Chikou', label: 'Ichimoku Chikou kaydırma', type: 'int', min: 1, max: 200, step: 1, menu: false },
  { key: 'ichiSenkouB', short: 'Senkou B', label: 'Ichimoku Senkou B', type: 'int', min: 2, max: 300, step: 1, menu: false },
  { key: 'ichiShift', short: 'Kaydırma', label: 'Ichimoku bulut kaydırma', type: 'int', min: 1, max: 200, step: 1, menu: false },
  { key: 'peakAlert', short: 'Tepe reddi', label: '🔻 Tepe reddi bildirimi (ayrı mesaj)', type: 'bool' },
  { key: 'peakAlertMin', short: 'Tepe skoru', label: 'Tepe reddi: en az skor (mum reddi · kırmızı · hacim · seans; 4 = yalnız 03–15 TSİ)', type: 'int', min: 2, max: 4, step: 1 },
  { key: 'peakAlertAtrPct', short: 'Tepe ATR %', label: 'Tepe reddi: 5dk ATR en az % (oynaklık; 0 = kapalı)', type: 'num', min: 0, max: 5, step: 0.1 },
  { key: 'peakAlertPumpPct', short: 'Tepe pompa %', label: 'Tepe reddi: pompa en az % (4s dipten)', type: 'num', min: 3, max: 30, step: 1 },
  { key: 'peakAlertRsiOnly', short: 'Tepe: RSI şartı', label: 'Tepe reddi: yalnız RSI kart şartı sağlanan coinlerde', type: 'bool' },
  { key: 'peakAlertGapMin', short: 'Tepe aralık dk', label: 'Tepe reddi: coin başına en fazla … dk\'da bir', type: 'int', min: 5, max: 240, step: 5 },
  { key: 'flowK', short: 'Akış pencere', label: 'Akış etiketi: son … pencere', type: 'int', min: 2, max: 30, step: 1 },
  { key: 'flowCvdPct', short: 'Akış CVD %', label: 'Akış: CVD (net akış / hacim) eşiği ±%', type: 'num', min: 0.5, max: 20, step: 0.5 },
  { key: 'flowPricePct', short: 'Akış fiyat %', label: 'Akış: fiyat yatay sayılır (±%)', type: 'num', min: 0.5, max: 20, step: 0.5 },
  { key: 'flowStrongX', short: 'Akış güçlü ×', label: 'Akış: hacim katı ≥ → güçlü', type: 'num', min: 1, max: 5, step: 0.1 },
  { key: 'flowWeakX', short: 'Akış zayıf ×', label: 'Akış: hacim katı < → zayıf hacim', type: 'num', min: 0.1, max: 1, step: 0.1 },
  { key: 'flowBuyPct', short: 'Akış alış %', label: 'Akış: alış ≥ % → 🟢', type: 'int', min: 50, max: 90, step: 1 },
  { key: 'flowSellPct', short: 'Akış satış %', label: 'Akış: alış ≤ % → 🔴', type: 'int', min: 10, max: 50, step: 1 },
  { key: 'flowBigPct', short: 'Büyük işlem %', label: 'Akış 🐋: büyük işlem eşiği = günlük spot hacminin %…', type: 'num', min: 0.01, max: 1, step: 0.01 },
  { key: 'flowBigMinUsd', short: 'Büyük işlem min $', label: 'Akış 🐋: büyük işlem eşiği en az … $', type: 'int', min: 500, max: 1000000, step: 500 },
  { key: 'minVolumeM', short: 'Hacim M$', label: 'Evren: 24s hacim ≥ (milyon $)', type: 'num', min: 0, max: 500, step: 1 },
  { key: 'tradfi', short: 'Hisse/emtia', label: 'Evren: kripto dışı kontratlar (hisse · ETF · altın/gümüş · döviz) izlensin', type: 'bool' },
];
const DEF_BY_KEY = Object.fromEntries(DEFS.map(d => [d.key, d]));

function defaultFile() {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'signals.db');
  return process.env.INFO_SETTINGS_PATH || path.join(path.dirname(dbPath), 'info-settings.json');
}

const round = (v, step) => {
  const dec = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return +(+v).toFixed(dec);
};

function createSettings({ file = defaultFile(), defaults = cfg.info, persist = true } = {}) {
  let values  = { ...defaults };
  let mutes   = {};
  let follows = new Set();
  let topics  = {};
  const listeners = [];

  function load() {
    if (!persist) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j.values || {})) if (k in DEF_BY_KEY) values[k] = v;
      mutes = j.mutes || {};
      follows = new Set(j.follows || []);
      topics = j.topics || {};
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[AYAR] ${file} okunamadı (${e.message}) — varsayılanlar kullanılıyor`);
    }
  }

  function save() {
    if (!persist) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => defaults[k] !== v));
      fs.writeFileSync(file, JSON.stringify({ values: changed, mutes, follows: [...follows], topics }, null, 2));
    } catch (e) {
      console.error(`[AYAR] ${file} yazılamadı: ${e.message}`);
    }
  }

  function set(key, raw) {
    const d = DEF_BY_KEY[key];
    if (!d) return { ok: false, error: `bilinmeyen ayar: ${key}` };
    let v;
    if (d.type === 'enum') {
      const v0 = String(raw).trim().toLowerCase();
      if (!d.options.includes(v0)) return { ok: false, error: `${key} şunlardan biri olmalı: ${d.options.join(', ')}` };
      v = v0;
    } else if (d.type === 'bool') {
      const s = String(raw).toLowerCase();
      if (['1', 'true', 'ac', 'aç', 'acik', 'açık', 'on', 'evet'].includes(s)) v = true;
      else if (['0', 'false', 'kapat', 'kapali', 'kapalı', 'off', 'hayir', 'hayır'].includes(s)) v = false;
      else return { ok: false, error: `${key} için aç/kapat bekleniyor` };
    } else {
      v = Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(v)) return { ok: false, error: `${key} sayı olmalı` };
      if (d.type === 'int') v = Math.round(v);
      v = round(v, d.step);
      if (v < d.min || v > d.max) return { ok: false, error: `${key} ${d.min}–${d.max} arasında olmalı` };
    }
    const prev = values[key];
    values[key] = v;
    save();
    if (prev !== v) listeners.forEach(fn => { try { fn(key, v, prev); } catch { /* yok */ } });
    return { ok: true, value: v };
  }

  function bump(key, dir) {
    const d = DEF_BY_KEY[key];
    if (!d) return { ok: false, error: 'bilinmeyen ayar' };
    if (d.type === 'bool') return set(key, !values[key]);
    if (d.type === 'enum') {
      const i = d.options.indexOf(values[key]);
      const n = d.options.length;
      return set(key, d.options[((i < 0 ? 0 : i) + (dir >= 0 ? 1 : -1) + n) % n]);
    }
    const v = Math.min(d.max, Math.max(d.min, round(values[key] + dir * d.step, d.step)));
    return set(key, v);
  }

  return {
    load, save, set, bump,
    get: () => values,
    defaults: () => defaults,
    defs: DEFS,
    onChange: fn => listeners.push(fn),
    /** Verilen anahtarları (yoksa tümünü) varsayılana döndürür; değişen anahtar sayısı */
    reset(keys = null) {
      const list = keys || Object.keys(defaults);
      const changed = [];
      for (const k of list) {
        if (!(k in defaults) || values[k] === defaults[k]) continue;
        changed.push([k, values[k]]);
        values[k] = defaults[k];
      }
      save();
      for (const [k, prev] of changed) listeners.forEach(fn => { try { fn(k, values[k], prev); } catch { /* yok */ } });
      return changed.length;
    },

    isMuted(sym, now = Date.now()) {
      const u = mutes[sym];
      if (!u) return false;
      if (u <= now) { delete mutes[sym]; return false; }
      return true;
    },
    mute(sym, ms, now = Date.now()) { mutes[sym] = now + ms; save(); },
    unmute(sym) { delete mutes[sym]; save(); },
    mutedList(now = Date.now()) { return Object.entries(mutes).filter(([, u]) => u > now); },

    topic: name => topics[name] ?? null,
    topics: () => ({ ...topics }),
    setTopic(name, id) { topics[name] = id; save(); },
    clearTopic(name) { delete topics[name]; save(); },

    isFollowed: sym => follows.has(sym),
    toggleFollow(sym) { if (follows.has(sym)) follows.delete(sym); else follows.add(sym); save(); return follows.has(sym); },
    followList: () => [...follows],
  };
}

module.exports = { createSettings, DEFS };
