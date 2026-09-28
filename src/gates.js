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
 *   current (canlı, varsayılan) : max(5m, 15m) RSI  cfg.rsiEntryMin–cfg.rsiEntryMax
 *   plan    (yalnızca backtest) : max(3m, 5m)  RSI  cfg.planTrigger.rsiMin–rsiMax, giriş TF 3m
 *   plan5m  (yalnızca backtest) : planın RSI tetikleyicisi, giriş TF 5m (tetikleyici etkisini ayırmak için)
 *   Tetikleyici verilmezse "current" kullanılır → canlı bot davranışı değişmez.
 *
 * Parametreler (p):
 *   rsi3m, rsi5m, rsi15m, rsi1h, rsi4h : RSI değerleri (rsi3m yalnızca plan tetikleyicisinde)
 *   ema21Distance                    : ATR cinsinden EMA21 uzaklığı
 *   ema21Touched                     : son N mumda EMA21 dokunuşu var mı
 *   nearDailyLevel                   : günlük EMA200 veya majör direnç yakını
 *   regime                           : 'REVERSAL' | 'CONTINUATION' | 'NEUTRAL'
 */

const cfg = require('./config');

/** Tetikleyici tanımları — eşikler çağrı anında cfg'den okunur */
function getTriggers() {
  const mk = (key, t) => ({ key, ...t, tfLabel: t.rsiTFs.join('/'), label: `${t.rsiTFs.join('/')} RSI ${t.rsiMin}–${t.rsiMax}` });
  return {
    current: mk('current', { rsiTFs: ['5m', '15m'], entryTF: '5m', rsiMin: cfg.rsiEntryMin, rsiMax: cfg.rsiEntryMax }),
    // Planın RSI tetikleyicisi + mevcut 5m giriş (EMA21/ATR/TP 5m) → yalnızca tetikleyici farkını ölçer
    plan5m:  mk('plan5m',  { ...cfg.planTrigger, entryTF: '5m' }),
    plan:    mk('plan',    { ...cfg.planTrigger }),
  };
}
const defaultTrigger = () => getTriggers().current;

/** Tetikleyici RSI'ı: rsiTFs içindeki en yüksek RSI */
const primaryRSI = (p, t) => Math.max(...t.rsiTFs.map(tf => p['rsi' + tf] || 0));

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
    label:  t => `${t.tfLabel} RSI < ${t.rsiMin}`,
    fails:  (p, t) => primaryRSI(p, t) < t.rsiMin,
    reason: (p, t) => `${t.tfLabel} RSI yetersiz (max: ${primaryRSI(p, t).toFixed(1)} < ${t.rsiMin})`,
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
  checkGates, listFailures, gateLabels, getTriggers, primaryRSI,
  GATE_KEYS: GATES.map(g => g.key),
};
