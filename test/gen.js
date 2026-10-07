// Sentetik 1m piyasa: uzun düşüş (seviyeler yukarıda kalır) + sonda seviyeye doğru pompalar
const MIN = 60e3;
function gen({ seed = 1, days = 40, start = Date.UTC(2026, 0, 1), p0 = 110, pumps = [] } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const out = []; let p = p0; const N = days * 1440;
  for (let i = 0; i < N; i++) {
    const t = start + i * MIN;
    let drift = -0.13 / 1440 * 0.01 * 100 / 100;            // yavaş düşüş
    let volK = 1, tk = 0.5;
    for (const pm of pumps) if (i >= pm.at && i < pm.at + pm.len) { drift = pm.rate; volK = pm.vol ?? 3; tk = 0.7; }
    for (const pm of pumps) if (i >= pm.at + pm.len && i < pm.at + pm.len + (pm.dumpLen ?? 0)) { drift = -pm.rate * 0.8; volK = 2.5; tk = 0.3; }
    const o = p; p *= 1 + drift + (rnd() - 0.5) * 0.002;
    const v = (100 + rnd() * 60) * volK * (1 + (Math.abs(p - o) / o > 0.009 ? 2 : 0));
    const tb = v * Math.min(0.95, Math.max(0.05, tk + (rnd() - 0.5) * 0.2));
    out.push({ t, o, h: Math.max(o, p) * (1 + rnd() * 0.0008), l: Math.min(o, p) * (1 - rnd() * 0.0008), c: p, v, tb, q: v * p, tq: tb * p });
  }
  return out;
}
function agg(arr, ms, upto) { const m = new Map(); for (const c of arr) { if (c.t >= upto) break; const ps = Math.floor(c.t / ms) * ms; const a = m.get(ps);
  if (!a) m.set(ps, { ...c, t: ps }); else { a.h = Math.max(a.h, c.h); a.l = Math.min(a.l, c.l); a.c = c.c; a.v += c.v; a.tb += c.tb; a.q += c.q; a.tq += c.tq; } } return [...m.values()]; }
module.exports = { gen, agg, MIN };
