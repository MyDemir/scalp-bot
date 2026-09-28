'use strict';

/**
 * Katman 3A — Mert Zorunlu Koşullar (Hard Gates)
 *
 * Kapılar SIRALI bir tabloda tanımlı; hem canlı bot hem backtest aynı tabloyu kullanır.
 *   checkGates()   → ilk takılan kapı ({ pass:false, reason }) ya da { pass:true, hasEMC }
 *   listFailures() → takılan TÜM kapıların anahtarları (backtest'te hangi kapının ne kadar
 *                    eleme yaptığını ölçmek için; karar yine checkGates ile verilir)
 *
 * EMC = Extreme Momentum Condition (15m RSI 95+)
 *   Deterministic bir "kesin giriş" değil, ek bir momentum sinyalidir.
 *
 * Giriş tetikleyicisi (trigger) — rsiLow/rsiHigh kapıları buna göre çalışır:
 *   current (canlı, varsayılan) : 5m RSI ≥ cfg.rsi5mMin VE 15m RSI ≥ cfg.rsi15mMin, max(5m,15m) ≤ cfg.rsiEntryMax
 *   (Mert varyantı ayrı modülde: src/mert.js — yalnızca backtest --compare)
 *   Tetikleyici verilmezse "current" kullanılır → canlı bot davranışı değişmez.
 *
 * Parametreler (p):
 *   rsi5m, rsi15m, rsi1h, rsi4h      : RSI değerleri
 *   ema21Distance                    : ATR cinsinden EMA21 uzaklığı
 *   ema21Touched                     : son N mumda EMA21 dokunuşu var mı
 *   nearDailyLevel                   : günlük EMA200 veya majör direnç yakını
 *   regime                           : 'REVERSAL' | 'CONTINUATION' | 'NEUTRAL'
 */

const cfg = require('./config');

/** Tetikleyici tanımları — eşikler çağrı anında cfg'den okunur */
function getTriggers() {
  const mk = (key, t) => ({
    key, ...t, tfLabel: t.rsiTFs.join('/'),
    label: t.rsiMins
      ? `${Object.entries(t.rsiMins).map(([tf, m]) => `${tf} RSI ≥ ${m}`).join(' + ')} (≤ ${t.rsiMax})`
      : `${t.rsiTFs.join('/')} RSI ${t.rsiMin}–${t.rsiMax}`,
  });
  return {
    // rsiMins: her TF kendi eşiğini AYRI AYRI geçmeli (VE). rsiMin yalnızca rapor/geri uyumluluk için.
    current: mk('current', {
      rsiTFs: ['5m', '15m'], entryTF: '5m',
      rsiMins: { '5m': cfg.rsi5mMin, '15m': cfg.rsi15mMin },
      rsiMin: Math.min(cfg.rsi5mMin, cfg.rsi15mMin), rsiMax: cfg.rsiEntryMax,
    }),
  };
}
const defaultTrigger = () => getTriggers().current;

/** Tetikleyici RSI'ı: rsiTFs içindeki en yüksek RSI (skor ve üst sınır bununla) */
const primaryRSI = (p, t) => Math.max(...t.rsiTFs.map(tf => p['rsi' + tf] || 0));

/** Eşiğin altında kalan TF'ler: [[tf, rsi, min], ...] — rsiMins yoksa max(RSI) < rsiMin kuralı */
function rsiShortfalls(p, t) {
  if (!t.rsiMins) return primaryRSI(p, t) < t.rsiMin ? [[t.tfLabel, primaryRSI(p, t), t.rsiMin]] : [];
  return Object.entries(t.rsiMins)
    .filter(([tf, m]) => !(p['rsi' + tf] >= m))
    .map(([tf, m]) => [tf, p['rsi' + tf], m]);
}

// Sıra önemlidir: checkGates ilk takılanı raporlar (canlı loglar ve heartbeat bu metni sayar)
const GATES = [
  {
    key:    'regime',
    label:  () => 'Rejim: Momentum Continuation',
    fails:  p => p.regime === 'CONTINUATION',
    reason: () => 'Momentum Continuation rejiminde SHORT sinyali iptal',
  },
  {
    key:    'dailyLevel',
    label:  () => 'Günlük EMA200/dirence uzak',
    fails:  p => !p.nearDailyLevel,
    reason: () => 'Günlük EMA200 veya majör direnç yakınında değil',
  },
  {
    key:    'rsi1h',
    label:  () => `1h RSI < ${cfg.rsi1hMin}`,
    fails:  p => !p.rsi1h || p.rsi1h < cfg.rsi1hMin,
    reason: p => `1h RSI yetersiz (${p.rsi1h?.toFixed(1)} < ${cfg.rsi1hMin})`,
  },
  {
    key:    'rsi4h',
    label:  () => `4h RSI < ${cfg.rsi4hMin}`,
    fails:  p => !p.rsi4h || p.rsi4h < cfg.rsi4hMin,
    reason: p => `4h RSI yetersiz (${p.rsi4h?.toFixed(1)} < ${cfg.rsi4hMin})`,
  },
  {
    key:    'rsiLow',
    label:  t => (t.rsiMins
      ? Object.entries(t.rsiMins).map(([tf, m]) => `${tf} RSI < ${m}`).join(' veya ')
      : `${t.tfLabel} RSI < ${t.rsiMin}`),
    fails:  (p, t) => rsiShortfalls(p, t).length > 0,
    reason: (p, t) => (t.rsiMins
      ? `${t.tfLabel} RSI yetersiz (${rsiShortfalls(p, t).map(([tf, v, m]) => `${tf} ${v != null ? v.toFixed(1) : '—'} < ${m}`).join(', ')})`
      : `${t.tfLabel} RSI yetersiz (max: ${primaryRSI(p, t).toFixed(1)} < ${t.rsiMin})`),
  },
  {
    key:    'rsiHigh',
    label:  t => `${t.tfLabel} RSI > ${t.rsiMax}`,
    fails:  (p, t) => primaryRSI(p, t) > t.rsiMax,
    reason: (p, t) => `${t.tfLabel} RSI sınır aşıldı (${primaryRSI(p, t).toFixed(1)} > ${t.rsiMax})`,
  },
  {
    key:    'emaDist',
    label:  () => `EMA21 uzaklığı < ${cfg.ema21DistanceThreshold} ATR`,
    fails:  p => p.ema21Distance < cfg.ema21DistanceThreshold,
    reason: p => `EMA21 çok yakın (${p.ema21Distance.toFixed(2)} ATR < ${cfg.ema21DistanceThreshold})`,
  },
  {
    key:    'emaTouch',
    label:  () => `Son ${cfg.ema21TouchLookback} mumda EMA21 dokunuşu`,
    fails:  p => !!p.ema21Touched,
    reason: () => `Son ${cfg.ema21TouchLookback} mumda EMA21 dokunuşu var`,
  },
  // NOT: Funding kapısı kaldırıldı (Mert stratejisinde yok; eşik birimi de hatalıydı → hiç
  // tetiklenmiyordu). Funding verisi toplanmaya ve sinyal kaydına yazılmaya devam ediyor.
];

/**
 * @returns {{ pass: boolean, reason?: string, key?: string, hasEMC?: boolean }}
 */
function checkGates(p, trigger = defaultTrigger()) {
  for (const g of GATES) {
    if (g.fails(p, trigger)) return { pass: false, reason: g.reason(p, trigger), key: g.key };
  }
  const hasEMC = !!(p.rsi15m && p.rsi15m >= cfg.rsiEMCThreshold);
  return { pass: true, hasEMC };
}

/** Takılan tüm kapıların anahtarları (tablo sırasıyla) */
function listFailures(p, trigger = defaultTrigger()) {
  return GATES.filter(g => g.fails(p, trigger)).map(g => g.key);
}

/** Rapor etiketleri: { key → okunur ad } (cfg eşikleri çağrı anında okunur) */
function gateLabels(trigger = defaultTrigger()) {
  return Object.fromEntries(GATES.map(g => [g.key, g.label(trigger)]));
}

module.exports = {
  checkGates, listFailures, gateLabels, getTriggers, primaryRSI, rsiShortfalls,
  GATE_KEYS: GATES.map(g => g.key),
};
