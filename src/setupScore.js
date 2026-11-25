'use strict';
/**
 * v3 kurulum puanı. Derece kuralı bunu kullanmaz; 25.11.2026'dan beri v3 B (eventLog v3Next) ⭐ kurulum kartını tetikler (infoEngine.setupCard).
 * Saf ve deterministik: aynı (feat, s) → aynı sonuç; durum ve saat yok.
 * Eşikler ayar değildir (config.js'e yazılmaz); s.setupRsi1m / s.setupVol3 verilirse onlar, yoksa SETUP_DEFAULTS.
 * Kayıt sürümü: cfgSetupVer.
 */
const SETUP_DEFAULTS = { rsi1m: 85, vol3: 3, pumpMin: 5, min: 4 };
const SETUP_VER = 1;
const FLAGS = ['v3_rsi1m', 'v3_bb15', 'v3_stoch5', 'v3_vol3', 'v3_liq'];

const fin = v => typeof v === 'number' && Number.isFinite(v);

/**
 * @param {object} feat  tepe kaydı alanları: rsi_1m, bbB_15m, stochCross, volx_3m, liqShortPct15
 * @param {object} [s]   isteğe bağlı { setupRsi1m, setupVol3 }
 * @returns {{v3S, v3_rsi1m, v3_bb15, v3_stoch5, v3_vol3, v3_liq}} bayrak 0/1 (alan yoksa null); hepsi null ise v3S null
 */
function setupScore(feat, s = {}) {
  const f = feat || {}, st = s || {};
  const rsiMin = fin(st.setupRsi1m) ? st.setupRsi1m : SETUP_DEFAULTS.rsi1m;
  const volMin = fin(st.setupVol3) ? st.setupVol3 : SETUP_DEFAULTS.vol3;
  const out = {
    v3_rsi1m: fin(f.rsi_1m) ? (f.rsi_1m >= rsiMin ? 1 : 0) : null,
    v3_bb15: fin(f.bbB_15m) ? (f.bbB_15m > 1 ? 1 : 0) : null,
    v3_stoch5: typeof f.stochCross === 'string' ? (f.stochCross === 'down' ? 1 : 0) : null,
    v3_vol3: fin(f.volx_3m) ? (f.volx_3m >= volMin ? 1 : 0) : null,
    v3_liq: fin(f.liqShortPct15) ? (f.liqShortPct15 > 0 ? 1 : 0) : null,
  };
  const vals = FLAGS.map(k => out[k]);
  const v3S = vals.every(v => v == null) ? null : vals.reduce((a, v) => a + (v || 0), 0);
  return { v3S, ...out };
}

module.exports = { setupScore, SETUP_DEFAULTS, SETUP_VER, FLAGS };
