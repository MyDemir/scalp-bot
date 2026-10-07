'use strict';
// Seviye tepkisi: temas → geri çekilme → 3m EMA21'e dönüş → kırılım → üstte kaldı; bekleme; kart eşleşmesi; kayıt + tablo
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert'); const fs = require('fs');
const { Series } = require(`${REPO}/src/series`); const cfg = require(`${REPO}/src/config`);
const { createTouchTracker, stopOf, LADDER } = require(`${REPO}/src/levelTouch`);
const { touchText, touchGroups, touchSum } = require(`${REPO}/src/infoStats`);
const { createCardStore } = require(`${REPO}/src/cardStore`);
const { toPlain } = require(`${REPO}/src/infoCard`);
const MIN = 60e3; const s = { ...cfg.info }; const R = []; const ok = x => R.push('✅ ' + x);

// 1m yol: 3000 dk 80 → 97 yavaş yükseliş, sonra senaryo
const t0 = Date.UTC(2026, 0, 1);
const path = [];
for (let i = 0; i < 3000; i++) path.push(80 + 17 * i / 2999 + Math.sin(i / 7) * 0.05);
const seg = (from, to, n) => { for (let k = 1; k <= n; k++) path.push(from + (to - from) * k / n); };
const base = path.length;
seg(97, 99.4, 24);            // hızlı yükseliş (RSI yüksek)
const touchIdx = path.length; path.push(99.2);   // temas mumu: tepe 100.1, kapanış 99.2
seg(99.2, 97.6, 15);          // geri çekilme (3m EMA21'in altına)
seg(97.6, 100.9, 15);         // toparlanma, 100.3 üstünde 5m kapanış
seg(100.9, 101.5, 40);        // üstte kalır
const m1 = path.map((c, i) => {
  const o = i ? path[i - 1] : c;
  const h = i === touchIdx ? 100.1 : Math.max(o, c) * 1.0003, l = Math.min(o, c) * 0.9997;
  return { t: t0 + i * MIN, o, h, l, c, v: 100, tb: 60, q: 100 * c, tq: 60 * c, closed: true };
});

const S = new Series('TESTUSDT');
const agg = (ms, upto) => { const m = new Map(); for (const c of m1) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
  if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; } } return [...m.values()]; };
const T0 = m1[base - 60].t;
for (const [tf, m] of Object.entries({ '1d': 1440, '4h': 240, '1h': 60, '15m': 15, '5m': 5, '3m': 3 })) S.seed(tf, agg(m * MIN, T0).filter(c => c.t + m * MIN <= T0));
S.seed('1m', m1.filter(c => c.t < T0).slice(-240));
const LV = [{ name: 'Fib 0.786', value: 100, kind: 'fib', touches: 5 }, { name: 'Günlük bölge', value: 110, kind: 'zone', touches: 2 }];
const tt = createTouchTracker();
const ev = [];
for (const c of m1.filter(c => c.t >= T0)) {
  const closed = S.apply1m(c);
  S._lv = { key: `${S.lastT('1h')}:${S.lastT('4h')}:${S.lastT('1d')}:true:true:3:3:true`, levels: LV, leg: null };
  assert(S.ready());
  ev.push(...tt.observe(S, closed, s));
  if (c.t === m1[touchIdx].t) tt.noteCard('TESTUSDT', c.t + 3 * MIN);   // temastan 2 dk sonra kart
}
assert.strictEqual(ev.length, 1, 'tek olay (110 hiç değmedi; toparlanmadaki ikinci geçiş beklemede): ' + JSON.stringify(ev.map(e => [e.name, e.t])));
const e = ev[0];
console.log(JSON.stringify(e));
assert.strictEqual(e.name, 'Fib 0.786');
assert.strictEqual(e.lvTouches, 5, 'seviyenin test sayısı kayda geçmeli');
assert.strictEqual(e.t, m1[touchIdx].t + MIN);
assert(e.rsiOk && e.hits >= 2, 'temasta RSI şartı: ' + JSON.stringify(e.rsi));
assert(e.card, '±5 dk içinde kart');
assert(Math.abs(e.pb - (100.1 - 97.6 * 0.9997) / 100.1 * 100) < 0.05, 'çekilme ≈ %2.53: ' + e.pb);
assert(e.pbMin >= 14 && e.pbMin <= 16, 'dibe ~15 dk: ' + e.pbMin);
assert(e.emaMin != null && e.emaMin > 0 && e.emaMin <= 15, "3m EMA21'e dönüş geri çekilmede: " + e.emaMin);
assert(e.brokeMin != null && e.brokeMin > e.emaMin && e.brokeAfterEma, 'kırılım EMA21 dönüşünden sonra: ' + e.brokeMin);
assert(e.held && e.c60 > 0.3 && e.up > 1 && e.dn < -2, 'üstte kaldı');
assert(LADDER.length === 3 && LADDER.some(([n]) => e.stop.includes(n.split(' ')[0])) && e.stopDepth <= 0.2 && !e.falling, 'dibin indiği ortalama: ' + e.stop + ' ' + e.stopDepth);
ok(`Temas: Fib 0.786 (100) — çekilme %${e.pb.toFixed(2)} (${e.pbMin} dk, dip ${e.stop}'e indi, %${e.stopDepth}), 3dk EMA21'e ${e.emaMin}. dk, kırılım ${e.brokeMin}. dk (EMA21'den sonra), 60. dk seviyenin %${e.c60.toFixed(2)} üstünde; RSI şartlı, kart eşleşti; 110 değmedi, ikinci geçiş beklemede`);

// Nerede durdu: dibin %0.2 yakınına indiği en alttaki ortalama
{
  const mas = [{ name: '3dk EMA21', v: 100 }, { name: '5dk EMA21', v: 98 }, { name: '15dk EMA21', v: 95 }];
  assert.deepStrictEqual(stopOf(97.9, mas), { stop: '5dk EMA21', stopDepth: -0.102 });
  assert.deepStrictEqual(stopOf(98.15, mas), { stop: '5dk EMA21', stopDepth: 0.153 });   // %0.2 yakın = indi
  assert.deepStrictEqual(stopOf(101, mas), { stop: 'yok', stopDepth: null });
  assert.strictEqual(stopOf(99, mas).stop, '3dk–5dk EMA21 arası');
  assert.strictEqual(stopOf(96.5, mas).stop, '5dk–15dk EMA21 arası');
  assert.strictEqual(stopOf(94.6, mas).stop, '15dk EMA21');
  assert.strictEqual(stopOf(93, mas).stop, '15dk EMA21 altı');
  ok("Nerede durdu (3dk/5dk/15dk EMA21): 97.9 → 5dk EMA21 · 98.15 → 5dk EMA21 (%0.2 payı) · 99 → 3dk–5dk arası · 96.5 → 5dk–15dk arası · 94.6 → 15dk EMA21 · 93 → 15dk EMA21 altı · 101 → ortalamaya inmedi");
}

// Yukarıdan gelen fiyat temas sayılmaz (önceki kapanış seviyenin altında olmalı)
{
  const S2 = new Series('DOWNUSDT'); const tt2 = createTouchTracker();
  for (const tf of ['1d', '4h', '1h', '15m', '5m', '3m']) S2.seed(tf, S.d[tf].t.map((t, i) => ({ t, o: 105, h: 105.2, l: 104.8, c: 105, v: 1, closed: true })));
  S2.seed('1m', Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * MIN, o: 105, h: 105.1, l: 104.9, c: 105, v: 1, closed: true })));
  let n = 0;
  for (let i = 60; i < 80; i++) {
    const p = 105 - (i - 59) * 0.3;
    const cl = S2.apply1m({ t: t0 + i * MIN, o: p + 0.3, h: p + 0.3, l: p, c: p, v: 1, closed: true });
    S2._lv = { key: `${S2.lastT('1h')}:${S2.lastT('4h')}:${S2.lastT('1d')}:true:true:3:3:true`, levels: LV, leg: null };
    n += tt2.observe(S2, cl, s).length + tt2.openCount();
  }
  assert.strictEqual(n, 0, 'yukarıdan inen fiyat seviyeye "temas" yazmamalı');
  ok('Yukarıdan inerken seviyeyi geçen fiyat temas sayılmadı (yalnız alttan gelen)');
}

// Kayıt (SQLite) + tablo
{
  const file = require('./_tmp') + '/touch-test.db'; for (const f of [file, file + '-wal', file + '-shm']) try { fs.unlinkSync(f); } catch { /* yok */ }
  { // eski şema (stop sütunları yok) → açılışta eklenmeli
    const Database = require(`${REPO}/node_modules/better-sqlite3`); const d0 = new Database(file);
    d0.exec(`CREATE TABLE touches (id TEXT PRIMARY KEY, symbol TEXT NOT NULL, t INTEGER NOT NULL, name TEXT NOT NULL, kind TEXT, value REAL, hits INTEGER, rsiok INTEGER, card INTEGER, emagap REAL, pb REAL, pbmin INTEGER, emamin INTEGER, brokemin INTEGER, brokeafterema INTEGER, held INTEGER, up REAL, dn REAL, c60 REAL)`);
    d0.close();
  }
  const st = createCardStore({ file, logger: { log() {}, error: x => { throw new Error(x); } } });
  const fake = (name, rsiOk, o) => ({ ...e, id: `${name}-${Math.random()}`, name, rsiOk, hits: rsiOk ? 2 : 0, card: rsiOk, t: Date.now() - 3600e3, ...o });
  const rows = [e, fake('Fib 0.786', false, { pb: 1.0, emaMin: null, brokeMin: null, brokeAfterEma: false, held: false }), fake('Fib 0.786', true, { pb: 3.0, emaMin: 4, brokeMin: null, brokeAfterEma: false, held: false }),
    fake('Günlük bölge', false, { pb: 0.5 }), fake('4h tepe', true, {})];
  rows[0] = { ...e, t: Date.now() - 7200e3 };
  for (const r of rows) st.addTouch(r);
  st.addTouch(rows[1]);                                            // aynı id tekrar → yok sayılır
  const back = st.touchesSince(Date.now() - 86_400_000);
  assert.strictEqual(back.length, 5);
  const b0 = back.find(x => x.id === e.id);
  for (const k of ['name', 'rsiOk', 'card', 'pbMin', 'emaMin', 'brokeMin', 'brokeAfterEma', 'held', 'stop', 'stopDepth', 'falling', 'lvTouches']) assert.deepStrictEqual(b0[k], e[k], k);
  const g = touchGroups(back);
  assert.deepStrictEqual(g.map(x => x.name), ['Fib 0.786', 'Günlük bölge', '4h tepe'], 'sıra: Fib → bölge → 4h tepe');
  const f = g[0];
  assert(f.all.n === 3 && f.rsi.n === 2 && f.cards === 2 && f.all.ema === 2 && f.all.broke === 1 && f.all.brokeAfterEma === 1 && f.all.held === 1);
  assert(Math.abs(f.all.pb - e.pb) < 1e-9, 'medyan çekilme');
  const txt = touchText(back, { title: 'son 1 gün · 5 temas', s });
  assert(txt.length < 4096 && txt.includes('🔥 <b>Pompa: RSI 85+ iken</b>\n📍 3 temas · kart çıkan 3') && txt.includes('💤 <b>RSI şartı yokken</b> (2 temas)') && txt.includes('🛑 <b>Ret sonrası nerede durdu</b>'), txt);
  assert(txt.includes(`▫️ ${e.stop} — `) && txt.includes('<blockquote expandable>ℹ️ <b>Nasıl ölçülür</b>') && txt.includes('RSI(14)'), 'durma dağılımı + açılır tanımlar');
  assert(txt.includes('▫️ Az örnek (&lt;5): Fib .786 (2), 4h tepe (1)'), 'az örnekli seviyeler tek satırda');
  assert(txt.includes('💪 <b>Seviye gücüne göre</b> (pompa)') && txt.includes('▪️ 4+ kez test edilmiş · 3 temas'), 'seviye gücü bloğu: ' + txt.slice(0, 900));
  const maxLine = Math.max(...txt.replace(/<blockquote[\s\S]*<\/blockquote>/, '').replace(/<[^>]+>/g, '').split('\n').filter(l => !l.startsWith('▫️ Az örnek')).map(l => [...l].length));
  assert(maxLine <= 40, 'telefon: satır ≤ 40 karakter, en uzun ' + maxLine);
  const ft = touchText(back, { filter: 'fib', s }).replace(/<blockquote[\s\S]*<\/blockquote>/, '');
  assert(ft.includes('Fib .786') && !ft.includes('G. bölge') && !ft.includes('4h tepe'), ft);
  { // ret / kırdı: hangisi önce
    const y = touchSum([{ ...e, brokeMin: 30, pbMin: 15 }, { ...e, brokeMin: 5, pbMin: 15, held: true }, { ...e, pb: 0, brokeMin: 3 }, { ...e, brokeMin: null }]);
    assert(y.rej === 2 && y.first === 2 && y.firstHeld === 2 - (e.held ? 0 : 1) || (y.rej === 2 && y.first === 2), JSON.stringify(y));
  }
  assert(touchText([], {}).includes('Kayıt yok'));
  // Temas anında zaten EMA21'e yapışık (emaMin 0) → EMA21 dönüş oranına katılmaz
  const x = touchSum([{ ...e, emaMin: 0 }, { ...e, emaMin: 0 }, { ...e, emaMin: 10 }, { ...e, emaMin: null }]);
  assert(x.sepN === 2 && x.ema === 1 && x.emaRate === 50 && x.emaMin === 10, JSON.stringify(x));
  st.close();
  console.log('\n' + toPlain(txt));
  ok("Kayıt: touches tablosuna yazıldı/okundu (tekrar id yok sayıldı); eski şemaya stop sütunları eklendi; rapor (telefon, satır ≤ 40): pompa / şartsız blok, ret–kırdı (hangisi önce), ret sonrası nerede durdu dağılımı, seviye blokları, az örnek tek satır, tanımlar açılır blokta; 'fib' süzgeci; boşsa 'Kayıt yok'; temasta zaten EMA21'de olanlar EMA21 oranına katılmadı");
}

console.log('\n' + R.join('\n'));
