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
 * Parametreler (p):
 *   rsi5m, rsi15m, rsi1h, rsi4h      : RSI değerleri
 *   ema21Distance                    : ATR cinsinden EMA21 uzaklığı
 *   ema21Touched                     : son N mumda EMA21 dokunuşu var mı
 *   nearDailyLevel                   : günlük EMA200 veya majör direnç yakını
 *   regime                           : 'REVERSAL' | 'CONTINUATION' | 'NEUTRAL'
 */

const cfg = require('./config');

const primaryRSI = p => Math.max(p.rsi5m || 0, p.rsi15m || 0);

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
    label:  () => `5m/15m RSI < ${cfg.rsiEntryMin}`,
    fails:  p => primaryRSI(p) < cfg.rsiEntryMin,
    reason: p => `5m/15m RSI yetersiz (max: ${primaryRSI(p).toFixed(1)} < ${cfg.rsiEntryMin})`,
  },
  {
    key:    'rsiHigh',
    label:  () => `5m/15m RSI > ${cfg.rsiEntryMax}`,
    fails:  p => primaryRSI(p) > cfg.rsiEntryMax,
    reason: p => `5m/15m RSI sınır aşıldı (${primaryRSI(p).toFixed(1)} > ${cfg.rsiEntryMax})`,
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
function checkGates(p) {
  for (const g of GATES) {
    if (g.fails(p)) return { pass: false, reason: g.reason(p), key: g.key };
  }
  const hasEMC = !!(p.rsi15m && p.rsi15m >= cfg.rsiEMCThreshold);
  return { pass: true, hasEMC };
}

/** Takılan tüm kapıların anahtarları (tablo sırasıyla) */
function listFailures(p) {
  return GATES.filter(g => g.fails(p)).map(g => g.key);
}

/** Rapor etiketleri: { key → okunur ad } (cfg eşikleri çağrı anında okunur) */
function gateLabels() {
  return Object.fromEntries(GATES.map(g => [g.key, g.label()]));
}

module.exports = { checkGates, listFailures, gateLabels, GATE_KEYS: GATES.map(g => g.key) };
