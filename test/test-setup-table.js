'use strict';
// Kurulum tablosu: pompa başına ilk eşleşen aday, kapanıştan çeviri, eksik close60, yarı bölmesi
const REPO = require('path').resolve(__dirname, '..'); const assert = require('assert');
const { createSetupAcc } = require(`${REPO}/src/setupTable`);
const MIN = 60_000, T0 = Date.UTC(2026, 9, 1, 12);

// peak (r.price) = 110, giriş (feat.price) = 100. Tepeye göre close60 = -10% → 110*0.9/100-1 = -1% kapanıştan.
const mk = (symbol, tMin, feat, out, peak = 110) => ({ symbol, t: T0 + tMin * MIN, price: peak, feat: { price: 100, ...feat }, out });
const o = (low15, close60) => ({ 15: { low: low15 }, 60: close60 == null ? {} : { close: close60 } });
const base = { pumpPct: 3, sep3: 0, sep5: 0, rsi1h: 50, rsi15: 50, volx_3m: 1 };

const acc = createSetupAcc({ s: {} });
// Pompa A (AUSDT): 3 aday, ara < 60 dk. İlk aday pompa<5, ikinci pompa≥5 (close60 -10 → kapanıştan -1%), üçüncü de pompa≥5 ama close60 +20
acc.add(mk('AUSDT', 0, { ...base }, o(-13.6, -10)));                       // tepeye göre low15 -13.6 → 110*0.864/100-1 = -4.96%; close60 -1%
acc.add(mk('AUSDT', 50, { ...base, pumpPct: 7 }, o(-5, -10)));              // ikinci; ≥5 grubunun ilk adayı: low15 -5 → +4.5% (−1,5'e inmedi); close60 -1%
acc.add(mk('AUSDT', 99, { ...base, pumpPct: 9 }, o(0, 20)));               // üçüncü: sayılmamalı (close60 +32%)
// Pompa A2 (AUSDT): 60 dk ve üstü boşluk → ayrı pompa; close60 yok (eksik)
acc.add(mk('AUSDT', 99 + 60, { ...base, pumpPct: 6 }, o(-1, null)));
// Ayrı sembol BUSDT: kurulum şartları (sep, rsi1h bandı, rsi15) tam; hacim 12 kat; close60 +10 tepeye göre → 110*1.1/100-1 = +21% (yukarıda)
acc.add(mk('BUSDT', 400, { pumpPct: 12, sep3: 2.5, sep5: 2.1, rsi1h: 82, rsi15: 86, volx_3m: 12 }, o(-2, 10)));
// Sıra karışık gelsin: AUSDT'nin erken adayı en sona yazılır (rowid sırası zaman sırası değil)
acc.add(mk('AUSDT', 20, { ...base }, o(-13.6, -10)));                      // pompa A'nın ilk adayından sonra, aynı pompa

const st = acc.stats(), R = Object.fromEntries(st.rows.map(r => [r.name, r]));
assert.strictEqual(st.pumps, 3, 'AUSDT 2 pompa + BUSDT 1');
assert.strictEqual(st.candidates, 6);

const all = R['Tüm pompalar'];
assert.strictEqual(all.n, 2, 'A (ilk aday, -1%) + BUSDT (+21%); A2 close60 yok');
assert.strictEqual(st.missing[0], 1, 'A2 eksik sayıldı');
assert.strictEqual(all.below60, 50);
assert(Math.abs(all.med60 - ((-1 + 21) / 2)) < 1e-3, 'medyan kapanıştan: ' + all.med60);
assert.strictEqual(all.drop15, 50, 'A ilk aday low15 -4.96% ≤ -1.5; BUSDT low15 -2 → +7.8%');
assert(all.small, 'n<20 → az örnek');

const p5 = R['Pompa ≥ %5'];
assert.strictEqual(p5.n, 2, 'A: ikinci aday (ilk eşleşen), BUSDT; A2 eksik');
assert.strictEqual(p5.drop15, 0, 'A ikinci adayın low15 -5 → +4.5%; ilk aday değil');
assert.strictEqual(st.missing[1], 1);
assert(Math.abs(p5.med60 - 10) < 1e-3, 'ikinci aday -1, BUSDT +21 → medyan +10');

assert.strictEqual(R['EMA21 ayrışma'].n, 1);
assert.strictEqual(R['1s RSI bandı'].n, 1);
assert.strictEqual(R['15dk RSI'].n, 1);
assert.strictEqual(R['Bu 3 şarttan ≥ 2'].n, 1);
assert.strictEqual(R['3dk hacim ≥ 10 kat'].n, 1);

// Yarılar: kapsam orta noktası = (0 + 400)/2 = 200 dk. A (t=0) 1. yarıda (aşağıda), BUSDT (t=400) 2. yarıda (yukarıda)
assert.deepStrictEqual([all.n1, all.n2, all.h1, all.h2], [1, 1, 100, 0]);

// Eşik ayardan: sepPct2 = 3 → BUSDT ayrışma dışı; gradeRsi1hMax = 80 → 82 bandın dışı (üst sınır dışlayıcı)
{
  const a2 = createSetupAcc({ s: { sepPct2: 3, gradeRsi1hMax: 80, gradeRsi1h: 70 } });
  a2.add(mk('BUSDT', 400, { pumpPct: 12, sep3: 2.5, sep5: 2.1, rsi1h: 82, rsi15: 86, volx_3m: 12 }, o(-2, 10)));
  const q = Object.fromEntries(a2.stats().rows.map(r => [r.name, r]));
  assert.strictEqual(q['EMA21 ayrışma'].n, 0); assert.strictEqual(q['1s RSI bandı'].n, 0); assert.strictEqual(q['Bu 3 şarttan ≥ 2'].n, 0);
}

const txt = acc.text();
assert(txt.includes('Nasıl okunur') && txt.includes('(az örnek)') && txt.includes('Eksik takip') && txt.includes('Tüm pompalar'));
assert(!/(^|[^\p{L}])(al|sat)(?![\p{L}])/iu.test(txt.replace(/Nasıl okunur.*\n/, '')), 'al/sat ifadesi yok');
console.log(txt);
console.log('✅ Kurulum tablosu: pompa başına ilk eşleşen aday, kapanıştan çeviri, eksik close60 dışlanıp sayılıyor, yarı bölmesi, ayardan eşik');
