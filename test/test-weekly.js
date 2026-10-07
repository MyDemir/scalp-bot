'use strict';
// Haftalık rapor: Pazartesi 03:01 TSİ zamanı, MD + 3 CSV, gönderilemezse silme yok, gönderilince silme + VACUUM, ilk kurulumda bekleme
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const W = require(`${REPO}/src/weeklyReport`);
const { createCardStore } = require(`${REPO}/src/cardStore`);
const cfg = require(`${REPO}/src/config`);
const R = []; const ok = x => R.push('✅ ' + x);
const H = 3_600_000, MIN = 60_000;

// ── 1) Zaman ──
assert.strictEqual(new Date(W.lastSlot(Date.UTC(2026, 9, 6, 10))).toISOString(), '2026-10-05T00:01:00.000Z');   // Salı → bu Pazartesi 03:01 TSİ
assert.strictEqual(new Date(W.lastSlot(Date.UTC(2026, 9, 5, 0, 0))).toISOString(), '2026-09-28T00:01:00.000Z');   // Pzt 03:00 → geçen hafta
assert.strictEqual(new Date(W.lastSlot(Date.UTC(2026, 9, 5, 0, 1))).toISOString(), '2026-10-05T00:01:00.000Z');   // Pzt 03:01 → bu
assert.strictEqual(W.weekLabel(Date.UTC(2026, 9, 4, 19)), '2026-H40');                                             // Pazar 22:00 TSİ → 40. hafta
ok('Zaman: son "Pazartesi 03:01 TSİ" doğru (03:00 → geçen hafta, 03:01 → bu hafta); Pazar akşamı 40. hafta');

// ── 2) Veritabanı + dosyalar ──
const dir = require('./_tmp') + '/weekly-tmp'; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
const st = createCardStore({ file: dir + '/cards.db', logger: { log() {}, error: x => { throw new Error(x); } } });
const now = Date.UTC(2026, 9, 5, 0, 2);      // Pazartesi 03:02 TSİ
const old = now - 2 * 24 * H, recent = now - 2 * H;           // biri kapsamda, biri son 5 saatte (sonraki haftaya kalır)
for (const [id, t] of [['C1', old], ['C2', recent]]) {
  st.add({ id, kind: 'card', symbol: 'AUSDT', t, seq: 1, price: 1, data: { grade: 3, hits: 2, rsi: { '3m': 91, '5m': 92, '15m': 88 }, level: { name: 'Fib 0.786', value: 1.01, dist: -0.3, zone: 'dip' } } });
}
const feat = { rsi3: 90, rsi5: 91, rsi15: 85, rsi_1m: 93, rsi_3m: 90, rsi_5m: 91, rsi_15m: 85, rsi_1h: 80, rsi_4h: 70, pumpPct: 8, pumpMin: 70, pkLv: 'Günlük VWAP +2σ', pkLvDist: -0.12, vwD_sig: 2.1, vwW_sig: 1.3, vw90_pct: 2.4, trPct: -3.1, trMin: 18, trLv: '15dk EMA21', trEma: '15dk EMA21', fails: 'seviye', rsiOk: true, hits: 2 };
st.addEvent({ id: 'E1', symbol: 'BUSDT', t: old, price: 2, dropT: old + 5 * MIN, dropMin: 5, card: false, cardGrade: null, feat, out: { 60: { low: -3.1, high: 0.2, close: -2 }, 240: { low: -5, high: 0.2, close: -4 } } });
st.addEvent({ id: 'E2', symbol: 'BUSDT', t: recent, price: 2, dropT: recent + 5 * MIN, dropMin: 5, card: true, cardGrade: 2, feat, out: {} });
st.addTouch({ id: 'T1', symbol: 'AUSDT', t: old, name: 'Fib 0.786', kind: 'fib', value: 1, hits: 2, rsiOk: true, card: true, emaGap: 1, pb: 2, pbMin: 5, emaMin: 3, brokeMin: null, brokeAfterEma: false, held: false, up: 0.1, dn: -2, c60: -1, stop: '3dk EMA21', stopDepth: 0, falling: false });

const w = W.buildWeekly(st, { now, s: cfg.info, E: cfg.events });
assert.deepStrictEqual(w.counts, { cards: 1, touches: 1, drops: 1, peaks: 1 }, 'son 5 saat kapsam dışı');
assert.deepStrictEqual(w.files.map(f => f.name), ['haftalik-2026-H40.md', 'tepeler-2026-H40.csv', 'kartlar-2026-H40.csv', 'temaslar-2026-H40.csv']);
assert(w.md.includes('## Teyit adayları'), 'MD teyit bölümü');
assert(w.md.includes('# Haftalık istatistik — 2026-H40') && w.md.includes('## Düşüşler (1)') && w.md.includes('**BUSDT**') && w.md.includes('tepki: Günlük VWAP +2σ') && w.md.includes('dip −%3.1 (18 dk) 15dk EMA21') && w.md.includes('kart ❌ eksik: seviye'));
assert(w.md.includes('## Kartlar (1)') && w.md.includes('**AUSDT** #1 derece 3'));
const dcsv = w.files[1].buf.toString('utf8');
assert(dcsv.split('\n')[0].includes('rsi_4h') && dcsv.split('\n')[0].includes('pkLv') && dcsv.trim().split('\n').length === 2);
fs.writeFileSync(dir + '/' + w.files[0].name, w.files[0].buf);
console.log(w.md.split('\n').slice(0, 40).join('\n'));
ok(`Dosyalar: ${w.files.map(f => f.name).join(', ')} — kapsam rapordan 5 saat öncesine kadar (son 5 saat sonraki haftaya); MD'de özet + olay satırları (tepki seviyesi, VWAP σ, dip ve destek, eksik şart)`);

// ── 3) İş: ilk kurulum, gönderim hatası, başarılı gönderim + silme ──
(async () => {
  const sent = []; let fail = true;
  const job = W.createWeeklyJob({ store: st, file: dir + '/weekly-state.json', getSettings: () => cfg.info, E: cfg.events, logger: { log() {}, warn() {}, error: x => { throw new Error(x); } },
    send: async (files, cap) => { if (fail) return false; sent.push({ files: files.map(f => f.name), cap }); return true; },
    purge: c => st.purgeBefore(c) });
  // durum dosyası yok → ilk kurulum: bu haftanın Pazartesi'si "yapıldı" sayılır, hiçbir şey gönderilmez/silinmez
  assert.strictEqual(await job.tick(Date.UTC(2026, 9, 6, 10)), null);
  assert(job.state.lastSlot >= Date.UTC(2026, 9, 5, 0, 1) - 1 && sent.length === 0 && st.since(0).length === 2);
  // Bir sonraki Pazartesi 03:01 → gönderim başarısız → silme yok, 10 dk bekle
  const t1 = Date.UTC(2026, 9, 12, 0, 1, 30);
  assert.strictEqual(await job.tick(t1), 'fail');
  assert.strictEqual(st.since(0).length, 2, 'gönderilemedi → silinmedi');
  assert.strictEqual(await job.tick(t1 + 5 * MIN), null, '10 dk dolmadan tekrar denenmez');
  fail = false;
  assert.strictEqual(await job.tick(t1 + 11 * MIN), 'sent');
  assert(sent.length === 1 && sent[0].files.length === 4 && sent[0].cap.includes('Haftalık istatistik'));
  assert.strictEqual(st.since(0).length, 0, 'gönderildi → kartlar silindi');
  assert.strictEqual(st.eventsSince(0).length, 0); assert.strictEqual(st.touchesSince(0).length, 0);
  assert.strictEqual(await job.tick(t1 + 30 * MIN), null, 'aynı hafta ikinci kez yok');
  const state = JSON.parse(fs.readFileSync(dir + '/weekly-state.json', 'utf8'));
  assert.strictEqual(state.lastSlot, Date.UTC(2026, 9, 12, 0, 1));
  st.close();
  ok('İş: ilk kurulumda gönderim/silme yok (ilk rapor sonraki Pazartesi); gönderim hatasında veri silinmedi, 10 dk sonra tekrar; gönderilince 4 dosya + kartlar/temaslar/düşüşler silindi (VACUUM); aynı hafta tekrar yok; durum dosyaya yazıldı');
  console.log('\n' + R.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
