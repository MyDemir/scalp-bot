'use strict';
// 🔻 Tepe reddi: skor, mesaj biçimi, bildirim kuralları (eşik, pompa, coin başına aralık, susturma, konu)
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const TMP = require('./_tmp');
process.env.INFO_SETTINGS_PATH = `${TMP}/peak-settings.json`; fs.rmSync(process.env.INFO_SETTINGS_PATH, { force: true });
process.env.DB_PATH = `${TMP}/peak.db`;
const { peakScore, formatPeakAlert, emaPrice } = require(`${REPO}/src/peakAlert`);
const { toPlain } = require(`${REPO}/src/infoCard`);
const R = []; const ok = x => R.push('✅ ' + x);
const MIN = 60e3;

// ── 1) Skor ──
const base = { wick_5m: 0.4, clv_1m: 0.8, body_1m: -0.2, volx_3m: 2.5, session: 'Avrupa', pumpPct: 6.2, pumpMin: 48, price: 1.05, ema21_3m: 1.5, ema21_5m: 2.7, ema21_15m: 4.7, rsi3: 88, rsi5: 86, rsi15: 79, rsi1h: 70, vwD_sig: 2.1, atr5Pct: 1.6, pkLv: 'Günlük VWAP +2σ', buy_1m: 41 };
assert.deepStrictEqual(peakScore(base), { score: 4, R: true, K: true, V: true, SE: true });
assert.strictEqual(peakScore({ ...base, wick_5m: 0.1, clv_1m: 0.4 }).R, true, 'mum reddi: 1dk alt yarıda kapanış da sayılır');
assert.strictEqual(peakScore({ ...base, wick_5m: 0.1, clv_1m: 0.9 }).score, 3);
assert.strictEqual(peakScore({ ...base, session: 'ABD', body_1m: 0.1 }).score, 2);
assert.strictEqual(peakScore({}).score, 0, 'eksik alan → 0');
assert(Math.abs(emaPrice(1.05, 5) - 1) < 1e-9);
ok('Skor: mum reddi (fitil ≥ %35 ya da 1dk alt yarı) · kırmızı · hacim ≥ 2 kat · Asya/Avrupa; eksik alanlar sayılmaz');

// ── 2) Mesaj ──
const e = { t: Date.UTC(2026, 9, 13, 9, 32), price: 1.06, feat: base };
const m = formatPeakAlert({ sym: 'XUSDT', e, sc: peakScore(base), level: { name: 'Günlük bölge', value: 1.08 }, id: 'XUSDT-1-tepe' });
const plain = toPlain(m.text);
console.log(plain + '\n---\n' + toPlain(m.details).slice(0, 600));
assert(plain.startsWith('🔻 #XUSDT — Tepe reddi 4/4') && plain.includes('✅ Mum reddi · ✅ Kırmızı mum · ✅ Hacim 2.5 kat · ✅ Seans (Avrupa)'));
assert(plain.includes('Pompa: +%6.2 (4s dipten · 48 dk) · ATR 5dk %1.60') && plain.includes('Tepe: 1.06 · Fiyat: 1.05'));
assert(plain.includes('EMA21 3dk 1.03448 (−%1.5) · 5dk 1.02240 (−%2.7)') || /EMA21 3dk 1\.034\d* \(−%1\.5\)/.test(plain), 'EMA21 hedefleri: ' + plain);
assert(m.text.length <= 1024, 'grafik altı yazısı ≤ 1024: ' + m.text.length);
assert(m.keyboard.flat().some(b => b.callback_data === 'd:XUSDT-1-tepe'), 'Detay butonu');
assert(m.details.includes('Tepe mumu') && m.details.includes('Günlük bölge 1.08') && m.details.includes('#TEPERED') && m.details.length < 4096);
ok(`Mesaj: ${m.text.split('\n').length} satır (${m.text.length} karakter ≤ 1024), EMA21 3/5/15dk fiyat ve uzaklık, Detay'da mum ölçüleri + açıklama`);

// ── 3) Bildirim kuralları (infoBot) ──
const telegram = require(`${REPO}/src/telegram`);
const sent = []; telegram.sendCard = o => sent.push(o);
const bot = require(`${REPO}/src/infoBot`)._internal;
bot.settings.set('chart', false);
const sr = { symbol: 'XUSDT' };
const cand = (t, f = {}) => ({ t, price: 1.06, feat: { ...base, ...f } });
const T = Date.UTC(2026, 9, 13, 9, 0);
bot.onPeakCandidate(sr, cand(T));
assert.strictEqual(sent.length, 1, 'skor 4, pompa %6.2 → bildirim');
bot.onPeakCandidate(sr, cand(T + 10 * MIN));
assert.strictEqual(sent.length, 1, '30 dk dolmadan aynı coin → yok');
bot.onPeakCandidate(sr, cand(T + 31 * MIN, { session: 'ABD' }));
assert.strictEqual(sent.length, 1, 'skor 3 < varsayılan 4 → yok');
bot.onPeakCandidate(sr, cand(T + 32 * MIN, { pumpPct: 4 }));
assert.strictEqual(sent.length, 1, 'pompa %4 < %5 → yok');
bot.onPeakCandidate({ symbol: 'AUSDT' }, cand(T + 33 * MIN, { atr5Pct: 0.9 }));
assert.strictEqual(sent.length, 1, 'ATR 5dk %0.9 < %1.2 → yok');
bot.onPeakCandidate({ symbol: 'YUSDT' }, cand(T + 33 * MIN));
assert.strictEqual(sent.length, 2, 'başka coin → var');
bot.settings.mute('ZUSDT', 3600e3);
bot.onPeakCandidate({ symbol: 'ZUSDT' }, cand(T + 34 * MIN));
assert.strictEqual(sent.length, 2, 'susturulan coin → yok');
bot.settings.set('peakAlertMin', 3); bot.settings.setTopic('tepe', 55);
bot.onPeakCandidate(sr, cand(T + 61 * MIN, { session: 'ABD' }));
assert.strictEqual(sent.length, 3, 'eşik 3 yapılınca skor 3 → var');
assert.strictEqual(sent[2].thread, 55, '/konu tepe');
bot.settings.set('peakAlertRsiOnly', true);
bot.onPeakCandidate({ symbol: 'RUSDT' }, cand(T + 65 * MIN, { rsiOk: false }));
assert.strictEqual(sent.length, 3, 'yalnız RSI şartlı açık, RSI şartı yok → yok');
bot.onPeakCandidate({ symbol: 'RUSDT' }, cand(T + 66 * MIN, { rsiOk: true }));
assert.strictEqual(sent.length, 4, 'RSI şartı var → var');
assert(sent[3].text.includes('RSI şartı ✅'));
bot.settings.set('peakAlertRsiOnly', false);
bot.settings.set('peakAlertAtrPct', 0);
bot.onPeakCandidate({ symbol: 'AUSDT' }, cand(T + 67 * MIN, { atr5Pct: 0.3 }));
assert.strictEqual(sent.length, 5, 'ATR şartı 0 → kapalı, düşük ATR de gider');
bot.settings.set('peakAlert', false);
bot.onPeakCandidate({ symbol: 'WUSDT' }, cand(T + 70 * MIN));
assert.strictEqual(sent.length, 5, 'kapalı → yok');
assert(bot.details.get('XUSDT-' + T + '-tepe').includes('Tepe reddi'), 'Detay saklandı');
ok('Bildirim: skor ≥ 4, 5dk ATR ≥ %1.2 ve pompa ≥ %5 (varsayılan; ATR 0 = kapalı), coin başına 30 dk\'da bir, susturulan coin yok, eşik /ayarlar\'dan, yalnız RSI şartlı seçeneği, /konu tepe, kapatılabilir, Detay saklanıyor');
console.log('\n' + R.join('\n'));
process.exit(0);
