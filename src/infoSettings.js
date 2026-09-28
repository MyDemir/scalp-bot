'use strict';

/**
 * Bilgi botu ayarları — varsayılanlar config.info'dan, değişiklikler JSON dosyasında.
 *
 *   Dosya: <DB_PATH klasörü>/info-settings.json  (Fly'da /data → deploy sonrası korunur)
 *   İçerik: { values: {...}, mutes: {SYMBOL: bitişMs}, follows: [SYMBOL] }
 *
 * Telegram /ayarlar menüsü ve /ayar komutu buradaki DEFS'i kullanır (etiket, sınır, adım).
 */

const fs   = require('fs');
const path = require('path');
const cfg  = require('./config');

// type: 'num' | 'int' | 'bool'
const DEFS = [
  { key: 'rsiMin', short: 'RSI 🔴', label: 'Kart eşiği RSI (🔴)', type: 'int', min: 50, max: 100, step: 1 },
  { key: 'rsiMin2', short: 'RSI 🔴🔴', label: 'RSI 🔴🔴 / 🔴🔴🔴 eşiği', type: 'int', min: 50, max: 100, step: 1 },
  { key: 'rsiPeriod', short: 'RSI periyot', label: 'RSI periyodu', type: 'int', min: 2, max: 30, step: 1 },
  { key: 'minTFs', short: 'Dilim',        label: 'Eşiği geçen dilim (3m/5m/15m)', type: 'int', min: 1, max: 3, step: 1 },
  { key: 'strongRsi', short: 'RSI 🔴🔴🔴',     label: 'RSI 🔴🔴🔴 (satırda) eşiği',         type: 'int', min: 60, max: 100, step: 1 },
  { key: 'levelMaxPct', short: 'Seviye %',   label: 'Seviyeye yakınlık %',     type: 'num', min: 0.5, max: 10, step: 0.5 },
  { key: 'levelRequired', short: 'Seviye şartı', label: 'Seviye şartı',            type: 'bool' },
  { key: 'dipBelowPct', short: 'Dip alt %',   label: 'DİPTE: altında en fazla %', type: 'num', min: 0.1, max: 3, step: 0.1 },
  { key: 'dipAbovePct', short: 'Dip üst %',   label: 'DİPTE: üstünde en fazla %', type: 'num', min: 0, max: 2, step: 0.1 },
  { key: 'burstPct1', short: 'Patlama1 %',     label: 'Patlama gövde % (1. kademe)', type: 'num', min: 0.2, max: 10, step: 0.1 },
  { key: 'burstPct2', short: 'Patlama2 %',     label: 'Patlama gövde % (2. kademe)', type: 'num', min: 0.2, max: 10, step: 0.1 },
  { key: 'volMult', short: 'Hacim ×',       label: 'Hacim katı (×ortalama)',  type: 'num', min: 1, max: 10, step: 0.5 },
  { key: 'volAvgN', short: 'Ort. mum',       label: 'Hacim ortalaması (mum)',  type: 'int', min: 5, max: 100, step: 5 },
  { key: 'takerBuyPct', short: 'Alım >%',   label: 'Alım: taker > %',         type: 'int', min: 50, max: 90, step: 1 },
  { key: 'takerSellPct', short: 'Satış <%',  label: 'Satış: taker < %',        type: 'int', min: 10, max: 50, step: 1 },
  { key: 'volGrade2X', short: 'Hacim 🔴🔴 ×', label: 'Hacim 🔴🔴: ortalamanın en az … katı', type: 'num', min: 1, max: 20, step: 0.5 },
  { key: 'dirGrade3Pct', short: 'Yön 🔴🔴🔴 %', label: 'Hacim 🔴🔴🔴: yön uyumu (alış/satış) ≥ %', type: 'int', min: 50, max: 95, step: 1 },
  { key: 'windowMin', short: 'Pencere dk',     label: 'Sayaç penceresi (dk)',    type: 'int', min: 15, max: 200, step: 15 },
  { key: 'shortWindowMin', short: 'Kısa dk', label: 'Kısa pencere (dk)',      type: 'int', min: 5, max: 60, step: 5 },
  { key: 'resetRsi', short: 'Sıfırla <',      label: 'Kart no. sıfırlama (5m RSI <)', type: 'int', min: 40, max: 95, step: 1 },
  { key: 'seriesBursts', short: 'Seri patlama', label: 'Seri içi patlama → şartsız kart', type: 'bool' },
  { key: 'sepATR', short: 'Ayrışma ATR',        label: 'EMA21 ayrışma (ATR)',     type: 'num', min: 0, max: 5, step: 0.1 },
  { key: 'sepRequired', short: 'Ayrışma şartı',   label: 'Ayrışma şartı',           type: 'bool' },
  { key: 'confRsi', short: 'Destek RSI',       label: 'Destek RSI (1h/4h ≥)',    type: 'int', min: 50, max: 95, step: 1 },
  { key: 'confRequired', short: 'Destek şartı',  label: 'Destek şartı (1h/4h biri)', type: 'bool' },
  { key: 'macdRequired', short: 'MACD şartı',  label: 'MACD 5m zayıflama şartı', type: 'bool' },
  { key: 'moveAlertPct', short: 'Hareket %', label: 'Hareket uyarısı: 1 dk ≥ % (0 = kapalı)', type: 'num', min: 0, max: 20, step: 0.5 },
  { key: 'moveAlertAll', short: 'Hrk. tüm pariteler', label: 'Hareket uyarısı: tüm pariteler', type: 'bool' },
  { key: 'moveAlertSound', short: 'Hrk. sesli', label: 'Hareket uyarısı sesli', type: 'bool' },
  { key: 'chart', short: 'Grafik', label: 'Kartlarda grafik', type: 'bool' },
  { key: 'chartMoves', short: 'Grafik ⚡', label: '⚡ uyarılarda grafik', type: 'bool' },
  { key: 'ichiTenkan', short: 'Tenkan', label: 'Ichimoku Tenkan', type: 'int', min: 2, max: 100, step: 1, menu: false },
  { key: 'ichiKijun', short: 'Kijun', label: 'Ichimoku Kijun', type: 'int', min: 2, max: 200, step: 1, menu: false },
  { key: 'ichiChikou', short: 'Chikou', label: 'Ichimoku Chikou kaydırma', type: 'int', min: 1, max: 200, step: 1, menu: false },
  { key: 'ichiSenkouB', short: 'Senkou B', label: 'Ichimoku Senkou B', type: 'int', min: 2, max: 300, step: 1, menu: false },
  { key: 'ichiShift', short: 'Kaydırma', label: 'Ichimoku bulut kaydırma', type: 'int', min: 1, max: 200, step: 1, menu: false },
  { key: 'minVolumeM', short: 'Hacim M$',    label: 'Evren: 24s hacim ≥ (milyon $)', type: 'num', min: 0, max: 500, step: 1 },
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
  const listeners = [];

  function load() {
    if (!persist) return;
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j.values || {})) if (k in DEF_BY_KEY) values[k] = v;
      mutes = j.mutes || {};
      follows = new Set(j.follows || []);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`[AYAR] ${file} okunamadı (${e.message}) — varsayılanlar kullanılıyor`);
    }
  }

  function save() {
    if (!persist) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const changed = Object.fromEntries(Object.entries(values).filter(([k, v]) => defaults[k] !== v));
      fs.writeFileSync(file, JSON.stringify({ values: changed, mutes, follows: [...follows] }, null, 2));
    } catch (e) {
      console.error(`[AYAR] ${file} yazılamadı: ${e.message}`);
    }
  }

  /** Doğrulayıp ayarlar. @returns {{ok:boolean, value?, error?:string}} */
  function set(key, raw) {
    const d = DEF_BY_KEY[key];
    if (!d) return { ok: false, error: `bilinmeyen ayar: ${key}` };
    let v;
    if (d.type === 'bool') {
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
    const v = Math.min(d.max, Math.max(d.min, round(values[key] + dir * d.step, d.step)));
    return set(key, v);
  }

  return {
    load, save, set, bump,
    get: () => values,
    defs: DEFS,
    onChange: fn => listeners.push(fn),
    reset() { values = { ...defaults }; save(); },

    isMuted(sym, now = Date.now()) {
      const u = mutes[sym];
      if (!u) return false;
      if (u <= now) { delete mutes[sym]; return false; }
      return true;
    },
    mute(sym, ms, now = Date.now()) { mutes[sym] = now + ms; save(); },
    unmute(sym) { delete mutes[sym]; save(); },
    mutedList(now = Date.now()) { return Object.entries(mutes).filter(([, u]) => u > now); },

    isFollowed: sym => follows.has(sym),
    toggleFollow(sym) { if (follows.has(sym)) follows.delete(sym); else follows.add(sym); save(); return follows.has(sym); },
    followList: () => [...follows],
  };
}

module.exports = { createSettings, DEFS };
