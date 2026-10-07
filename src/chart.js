'use strict';

const { impulseLeg } = require('./levels');

/**
 * Kart grafiği (PNG) — 5m mumlar + Ichimoku BULUTU (KivancOzbilgic "ICHIMOKU Kinko Hyo by KIVANC" parametreleri;
 * sade görünüm için yalnızca Senkou A–B arası bulut çizilir: A ≥ B yeşil, A < B kırmızı)
 * + hacim + direnç seviyesi + son fiyat etiketi.
 *
 *   Ichimoku (Kıvanç'ın 5 parametreli sürümü): Tenkan (kırmızı), Kijun (mavi), Chikou (erik),
 *   Senkou A (yeşil), Senkou B (mor); bulut Senkou A ile B arasında. Kripto için önerdiği
 *   1-3-3-6-3 oranı korunarak varsayılan 10 / 30 / 30 / 60 / 30.
 *
 *   @napi-rs/canvas yoksa ya da çizim hata verirse null döner → kart grafiksiz (yalnız metin) gider.
 *   Yazı tipi repo içinde (src/assets/fonts, DejaVu) — sunucu imajında sistem fontu yok.
 */

const path = require('path');

let canvasLib = null;
let fontsReady = false;
function lib() {
  if (canvasLib === false) return null;
  if (!canvasLib) {
    try {
      canvasLib = require('@napi-rs/canvas');
      const dir = path.join(__dirname, 'assets', 'fonts');
      canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans.ttf'), 'ChartSans');
      canvasLib.GlobalFonts.registerFromPath(path.join(dir, 'DejaVuSans-Bold.ttf'), 'ChartSansBold');
      fontsReady = true;
    } catch (err) {
      console.warn(`[GRAFİK] @napi-rs/canvas yüklenemedi (${err.message}) — kartlar grafiksiz gider`);
      canvasLib = false;
      return null;
    }
  }
  return canvasLib;
}

const C = {
  bg: '#0f141b', grid: '#1c2430', axis: '#8b96a5', text: '#d7dde6', faint: '#5d6878',
  up: '#26a69a', down: '#ef5350',
  tenkan: '#ff4d4d', kijun: '#3d8bff', chikou: '#dda0dd', spanA: '#2ecc71', spanB: '#a855f7',
  cloudUp: 'rgba(46,204,113,0.20)', cloudDn: 'rgba(239,83,80,0.18)',
  level: '#f5a623', levelOther: '#7d8796', levelStrong: '#d9e1ea',
  ema3: '#f2f4f7', ema5: '#ffd166',
};

const DEFAULT_ICHI = { tenkan: 10, kijun: 30, chikou: 30, senkouB: 60, shift: 30 };

/** (en yüksek + en düşük) / 2 — son p mum */
function midline(h, l, p) {
  const out = new Array(h.length).fill(null);
  for (let i = p - 1; i < h.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - p + 1; j <= i; j++) { if (h[j] > hi) hi = h[j]; if (l[j] < lo) lo = l[j]; }
    out[i] = (hi + lo) / 2;
  }
  return out;
}

/** Ichimoku serileri (ham, kaydırılmamış) */
function ichimoku(h, l, c, p = DEFAULT_ICHI) {
  const tenkan = midline(h, l, p.tenkan);
  const kijun = midline(h, l, p.kijun);
  const spanB = midline(h, l, p.senkouB);
  const spanA = tenkan.map((t, i) => (t != null && kijun[i] != null ? (t + kijun[i]) / 2 : null));
  return { tenkan, kijun, spanA, spanB, chikou: c.slice() };
}

let hmFmt = null;
function hm(t, tz) {
  try {
    hmFmt = hmFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    return hmFmt.format(new Date(t));
  } catch { return new Date(t).toISOString().slice(11, 16); }
}

let dmhFmt = null;
function dmh(t, tz) {
  try {
    dmhFmt = dmhFmt || new Intl.DateTimeFormat('tr-TR', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
    return dmhFmt.format(new Date(t)).replace(',', '').replace(/\//g, '.');
  } catch { return new Date(t).toISOString().slice(5, 16).replace('T', ' '); }
}

function fmtPx(v) {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 7;
  return v.toFixed(d);
}

/**
 * @param {object} p
 * @param {string} p.symbol
 * @param {object[]} p.candles   {t,o,h,l,c,v} eski → yeni (son mum devam eden olabilir)
 * @param {object} [p.level]     {name, value} — çizilir (görünür aralıktaysa)
 * @param {object} [p.ichi]      {tenkan, kijun, chikou, senkouB, shift}
 * @param {string} [p.tf]        '5m'
 * @param {string} [p.subtitle]  ör. 'Kart 3'
 * @param {number} [p.show]      gösterilecek mum sayısı
 * @returns {Buffer|null} PNG
 */
const L0Name = L0 => L0.name;

function renderChart({ symbol, candles, level = null, levels = [], overlays = [], ichi = DEFAULT_ICHI, showIchi = true, fib = true, fibDir = 'up', fibLeg = null, tf = '5m', subtitle = '', show = 100, minTouches = 4, tz = process.env.DISPLAY_TZ || 'Europe/Istanbul' }) {
  const L = lib();
  if (!L || !candles || candles.length < 20) return null;
  try {
    const h = candles.map(k => k.h), l = candles.map(k => k.l), c = candles.map(k => k.c);
    const I = ichimoku(h, l, c, ichi);
    const n = candles.length;
    // Fib bacağı verildiyse grafik bacağın başladığı mumdan itibaren çizilir (en az `show`, en fazla 240 mum)
    let want = show;
    if (fib && fibLeg && Number.isFinite(fibLeg.hiT) && Number.isFinite(fibLeg.loT)) {
      const t0 = Math.min(fibLeg.hiT, fibLeg.loT);
      const i0 = candles.findIndex(k => k.t >= t0);
      if (i0 >= 0) want = Math.min(240, Math.max(show, n - i0 + 4));
    }
    const N = Math.min(want, n);
    const start = n - N;
    const slots = N + ichi.shift;                     // gelecekteki bulut için boşluk

    const W = 1080, H = 640;
    const padL = 14, axisW = 92, top = 64, priceH = 420, gap = 10, volH = 88, bottom = 30;
    const plotW = W - padL - axisW;
    const volTop = top + priceH + gap;
    const cv = L.createCanvas(W, H);
    const g = cv.getContext('2d');
    g.fillStyle = C.bg; g.fillRect(0, 0, W, H);

    // Değer aralığı: görünen mumlar + görünen Ichimoku + (yakınsa) seviye
    const vals = [];
    for (let i = start; i < n; i++) vals.push(h[i], l[i]);
    const at = (arr, k) => (k >= 0 && k < arr.length ? arr[k] : null);
    for (let j = 0; j < slots && showIchi; j++) {
      const k = start + j;
      for (const v of [at(I.spanA, k - ichi.shift), at(I.spanB, k - ichi.shift)]) {
        if (v != null && Number.isFinite(v)) vals.push(v);
      }
    }
    for (const ov of overlays) for (let i = start; i < n; i++) { const v = ov.values[i]; if (v != null && Number.isFinite(v)) vals.push(v); }
    const last = c[n - 1];
    const nearPct = tf === '1h' || tf === '4h' ? 0.12 : 0.06;
    const near = L0 => L0 && Number.isFinite(L0.value) && Math.abs(L0.value - last) / last < nearPct;
    const showLevel = near(level);
    if (showLevel) vals.push(level.value);
    // Grafikte yalnız en az minTouches kez test edilmiş dirençler (Fib ayrı çizilir); kartın direnci her zaman gösterilir
    const strong = L0 => L0 && Number.isFinite(L0.value) && L0.kind !== 'fib' && (L0.touches == null || L0.touches >= minTouches);
    const isMain = L0 => level && L0.name === level.name && L0.value === level.value;
    const otherLevels = levels.filter(L0 => near(L0) && strong(L0) && !isMain(L0))
      .sort((a, b) => Math.abs(a.value - last) - Math.abs(b.value - last)).slice(0, 8);
    for (const L0 of otherLevels) vals.push(L0.value);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = (hi - lo) * 0.05 || last * 0.01;
    lo -= pad; hi += pad;

    const xs = j => padL + (j + 0.5) * plotW / slots;
    const ys = v => top + (hi - v) / (hi - lo) * priceH;
    const slotW = plotW / slots;

    // Izgara + sağ eksen fiyatları
    g.font = '15px ChartSans';
    g.textAlign = 'left';
    const ticks = 6;
    for (let i = 0; i <= ticks; i++) {
      const v = lo + (hi - lo) * i / ticks, y = ys(v);
      g.strokeStyle = C.grid; g.lineWidth = 1;
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
      g.fillStyle = C.axis; g.fillText(fmtPx(v), padL + plotW + 8, y + 5);
    }
    // zaman etiketleri
    const every = Math.max(1, Math.round(N / 6));
    g.textAlign = 'center';
    for (let j = Math.round(every / 2); j < N; j += every) {
      const x = xs(j);
      g.strokeStyle = C.grid; g.beginPath(); g.moveTo(x, top); g.lineTo(x, volTop + volH); g.stroke();
      g.fillStyle = C.axis; g.fillText(tf === '1h' || tf === '4h' ? dmh(candles[start + j].t, tz) : hm(candles[start + j].t, tz), x, H - 9);
    }

    // Bulut (Senkou A–B arası), yamuklar halinde
    for (let j = 0; j < slots - 1 && showIchi; j++) {
      const k = start + j;
      const a1 = at(I.spanA, k - ichi.shift), b1 = at(I.spanB, k - ichi.shift);
      const a2 = at(I.spanA, k + 1 - ichi.shift), b2 = at(I.spanB, k + 1 - ichi.shift);
      if ([a1, b1, a2, b2].some(v => v == null)) continue;
      g.fillStyle = (a1 + a2) >= (b1 + b2) ? C.cloudUp : C.cloudDn;
      g.beginPath();
      g.moveTo(xs(j), ys(a1)); g.lineTo(xs(j + 1), ys(a2)); g.lineTo(xs(j + 1), ys(b2)); g.lineTo(xs(j), ys(b1));
      g.closePath(); g.fill();
    }

    const line = (getter, color, width = 2) => {
      g.strokeStyle = color; g.lineWidth = width; g.beginPath();
      let on = false;
      for (let j = 0; j < slots; j++) {
        const v = getter(start + j);
        if (v == null || !Number.isFinite(v)) { on = false; continue; }
        if (!on) { g.moveTo(xs(j), ys(v)); on = true; } else g.lineTo(xs(j), ys(v));
      }
      g.stroke();
    };
    // Ichimoku: yalnızca bulut (Tenkan/Kijun/Chikou çizgileri grafiği kalabalıklaştırdığı için çizilmez)
    // EMA21 3m / 5m (kalın, kesiksiz) — hedef bölgeleri
    for (const ov of overlays) line(k => (k < n ? ov.values[k] : null), ov.color, 2.6);

    // Fibonacci düzeltme seviyeleri — SON İTKİ BACAĞINA göre (TradingView'deki gibi fitiller, 0 = bacağın bittiği uç):
    //   yükseliş (varsayılan; kartlar ve yükseliş uyarıları): penceredeki en düşük dip + ONDAN SONRAKİ en yüksek tepe
    //     → 0 = tepe, 1 = dip (0.382 / 0.5 / 0.618 geri çekilme seviyeleri)
    //   düşüş (düşüş uyarıları): penceredeki en yüksek tepe + ondan sonraki en düşük dip → 0 = dip, 1 = tepe
    // Bacak çok kısa kalırsa (pencerenin en ucunda) tüm pencerenin dip–tepesi kullanılır.
    let fibInfo = null;
    const edge = [];                                   // görünen aralığın dışındaki seviyeler → üst/alt kenarda ok + etiket
    if (fib) {
      // Günlük geniş bacak verildiyse (motorla aynı: son ~1 yılın tepe ↔ dibi) o; yoksa görünen mumlardan kısa bacak
      const leg = fibLeg && fibLeg.hi > fibLeg.lo ? fibLeg : impulseLeg(h, l, N, fibDir);
      if (leg && leg.hi > leg.lo) {
        const HI = leg.hi, Lw = leg.lo, up = leg.up;
        fibInfo = { up, wide: leg === fibLeg };
        const R = [[0, '#7d8796'], [0.236, '#8e9aaf'], [0.382, '#5dade2'], [0.5, '#f4d03f'], [0.618, '#f39c12'], [0.786, '#e67e22'], [1, '#7d8796']];
        g.font = '13px ChartSans'; g.textAlign = 'left';
        for (const [r, col] of R) {
          const v = up ? HI - (HI - Lw) * r : Lw + (HI - Lw) * r;
          if (v > hi || v < lo) { edge.push({ label: `Fib ${r}`, value: v, color: col }); continue; }
          const y = ys(v);
          g.strokeStyle = col; g.globalAlpha = r === 0.618 || r === 0.5 ? 0.9 : 0.6; g.lineWidth = r === 0.618 ? 1.6 : 1;
          g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
          g.globalAlpha = 1;
          const lab = `${r} · ${fmtPx(v)}`;
          const tw = g.measureText(lab).width;
          g.fillStyle = 'rgba(15,20,27,0.8)'; g.fillRect(padL + 2, y - 15, tw + 8, 16);
          g.fillStyle = col; g.fillText(lab, padL + 6, y - 3);
        }
        // tepe ve dip noktaları (geniş bacakta zamana göre bulunur)
        const idxOf = tt => { const i = candles.findIndex(k => k.t === tt); return i >= 0 ? i : null; };
        const hI = fibInfo.wide ? idxOf(leg.hiT) : leg.hiI, lI = fibInfo.wide ? idxOf(leg.loT) : leg.loI;
        g.fillStyle = '#7d8796';
        if (hI != null && hI >= start) { g.beginPath(); g.arc(xs(hI - start), ys(HI), 3.5, 0, 7); g.fill(); }
        if (lI != null && lI >= start) { g.beginPath(); g.arc(xs(lI - start), ys(Lw), 3.5, 0, 7); g.fill(); }
      }
    }
    // Henüz geçilmemiş (fiyatın üstündeki) TÜM dirençler — temas sayısından bağımsız, görünen aralıkta olsun olmasın
    // sağ üst listeye (en yakın 5). ≥ minTouches temaslılar ★ ve açık renkle; süzgeç yalnız grafik içi çizgiler için.
    for (const L0 of levels) {
      if (!L0 || !Number.isFinite(L0.value) || L0.kind === 'fib' || L0.value <= last) continue;
      const st = L0.touches != null && L0.touches >= minTouches;
      edge.push({ label: L0.name, value: L0.value, color: isMain(L0) ? C.level : st ? C.levelStrong : C.levelOther, touches: L0.touches, star: st });
    }

    // Mumlar
    const bw = Math.max(2, slotW * 0.62);
    let vmax = 0;
    for (let i = start; i < n; i++) if (candles[i].v > vmax) vmax = candles[i].v;
    for (let i = start; i < n; i++) {
      const k = candles[i], j = i - start, x = xs(j);
      const col = k.c >= k.o ? C.up : C.down;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(x, ys(k.h)); g.lineTo(x, ys(k.l)); g.stroke();
      const y1 = ys(Math.max(k.o, k.c)), y2 = ys(Math.min(k.o, k.c));
      g.fillRect(x - bw / 2, y1, bw, Math.max(1.5, y2 - y1));
      // hacim
      if (vmax > 0) {
        const vh = k.v / vmax * (volH - 4);
        g.globalAlpha = 0.55;
        g.fillRect(x - bw / 2, volTop + volH - vh, bw, vh);
        g.globalAlpha = 1;
      }
    }

    // Sağ üst liste: fiyatın üstündeki en yakın 5 direnç (hepsi; ★ = ≥ minTouches temas) + görünen aralık dışındaki Fib'ler
    const ups = edge.filter(e => e.value > last).sort((a, b) => a.value - b.value)
      .filter((e, i, a) => !a.slice(0, i).some(p => p.label === e.label && Math.abs(p.value - e.value) / e.value < 0.003)).slice(0, 5);
    const reservedBottom = ups.length ? top + 16 + (ups.length - 1) * 17 + 4 : top - 20;
    // Diğer seviyeler (gri, ince) — etiket sağda; yakın seviyelerin etiketleri üst üste binmesin diye kaydırılır
    // (çizgi gerçek yerinde kalır, yalnız yazı kayar)
    {
      const placed = [];
      const items = otherLevels.map(L0 => ({ L0, y: ys(L0.value) })).sort((a, b) => a.y - b.y);
      for (const it of items) {
        g.strokeStyle = C.levelOther; g.lineWidth = 1; g.setLineDash([4, 6]);
        g.beginPath(); g.moveTo(padL, it.y); g.lineTo(padL + plotW, it.y); g.stroke(); g.setLineDash([]);
        // sağ üst listede yazılanın çizgisine ayrıca etiket yazılmaz (kalabalık olmasın)
        if (ups.some(e => e.label === it.L0.name && Math.abs(e.value - it.L0.value) / it.L0.value < 0.003)) continue;
        let ly = it.y - 5;
        if (ly - 12 < reservedBottom) ly = Math.max(ly, reservedBottom + 14);       // kenar etiketlerinin altına
        for (const p of placed) if (Math.abs(ly - p) < 15) ly = p + 15;             // bir öncekinin altına
        placed.push(ly);
        const txt = `${L0Name(it.L0)} ${fmtPx(it.L0.value)}${it.L0.touches != null ? ` · ${it.L0.touches} temas` : ''}`;
        g.font = '13px ChartSans'; g.textAlign = 'right';
        const tw = g.measureText(txt).width;
        g.fillStyle = 'rgba(15,20,27,0.8)'; g.fillRect(padL + plotW - tw - 10, ly - 12, tw + 8, 15);
        g.fillStyle = C.levelOther; g.fillText(txt, padL + plotW - 6, ly);
        g.textAlign = 'left';
      }
    }
    // Direnç seviyesi (en yakın, turuncu)
    if (showLevel) {
      const y = ys(level.value);
      g.strokeStyle = C.level; g.lineWidth = 1.5; g.setLineDash([8, 6]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
      g.font = '15px ChartSansBold'; g.textAlign = 'left';
      const lab = `${level.name}  ${fmtPx(level.value)}${level.touches != null ? ` · ${level.touches} temas` : ''}`;
      const tw = g.measureText(lab).width;
      const lx0 = padL + plotW * 0.42;
      g.fillStyle = 'rgba(15,20,27,0.85)'; g.fillRect(lx0, y - 24, tw + 12, 20);
      g.fillStyle = C.level; g.fillText(lab, lx0 + 6, y - 9);
    }

    // Son fiyat etiketi
    {
      const y = ys(last), up = c[n - 1] >= candles[n - 1].o;
      g.strokeStyle = up ? C.up : C.down; g.lineWidth = 1; g.setLineDash([3, 4]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = up ? C.up : C.down;
      g.fillRect(padL + plotW + 2, y - 12, axisW - 4, 24);
      g.fillStyle = '#ffffff'; g.font = '15px ChartSansBold'; g.textAlign = 'left';
      g.fillText(fmtPx(last), padL + plotW + 8, y + 5);
    }

    // Sağ üst liste: ↑ ad değer (+%uzaklık · N temas), alt alta
    {
      g.font = '13px ChartSans'; g.textAlign = 'right';
      ups.forEach((e, i) => {
        const txt = `↑ ${e.star ? '★ ' : ''}${e.label} ${fmtPx(e.value)} (+%${((e.value - last) / last * 100).toFixed(1)}${e.touches != null ? ` · ${e.touches} temas` : ''})`;
        const y = top + 16 + i * 17, tw = g.measureText(txt).width;
        g.fillStyle = 'rgba(15,20,27,0.85)'; g.fillRect(padL + plotW - tw - 10, y - 13, tw + 8, 16);
        g.fillStyle = e.color; g.fillText(txt, padL + plotW - 6, y);
      });
      g.textAlign = 'left';
    }

    // Başlık + gösterge açıklaması
    g.textAlign = 'left';
    g.font = '24px ChartSansBold'; g.fillStyle = C.text;
    const head = `${symbol} · ${tf}${subtitle ? ` · ${subtitle}` : ''}`;
    g.fillText(head, padL, 30);
    g.font = '14px ChartSans'; g.textAlign = 'right'; g.fillStyle = C.faint;
    g.fillText(`${hm(candles[n - 1].t, tz)} (TSİ)`, W - 12, 28);
    g.textAlign = 'left';
    let lx = padL;
    const legend = [
      ...overlays.map(ov => [ov.label, ov.color]),
      ...(showIchi ? [[`Ichimoku bulutu (${ichi.tenkan}/${ichi.kijun}/${ichi.senkouB}, +${ichi.shift})`, C.spanA]] : []),
      ...(fibInfo ? [[`Fibonacci (${fibInfo.wide ? '1s geniş bacak, ' : ''}${fibInfo.up ? 'dip → tepe' : 'tepe → dip'})`, '#f39c12']] : []),
    ];
    g.font = '14px ChartSans';
    for (const [t, col] of legend) {
      g.fillStyle = col; g.fillRect(lx, 45, 14, 3);
      g.fillStyle = C.axis; g.fillText(t, lx + 18, 51);
      lx += g.measureText(t).width + 34;
    }
    return cv.toBuffer('image/png');
  } catch (err) {
    console.warn(`[GRAFİK] ${symbol} çizilemedi: ${err.message}`);
    return null;
  }
}

/**
 * EMA21 çizgileri, 5m mumlarla hizalı: 5m EMA21 doğrudan; 3m EMA21 her 5m mumun sonunda bilinen son değer.
 * @returns {{label, color, values:number[]}[]}
 */
function emaOverlays(series, candles5) {
  const ta = require('./ta');
  const out = [];
  const c5 = candles5.map(k => k.c);
  const e5 = ta.emaSeries(c5, 21), off5 = c5.length - e5.length;
  out.push({ label: '5m EMA21', color: C.ema5, values: c5.map((_, i) => (i >= off5 ? e5[i - off5] : null)) });
  if (series && series.count('3m') >= 30) {
    const t3 = series.col('3m', 't'), c3 = series.col('3m', 'c');
    const e3 = ta.emaSeries(c3, 21), off3 = c3.length - e3.length;
    const vals = [];
    let j = 0;
    for (const k of candles5) {
      const end = k.t + 5 * 60_000;                 // 5m mumun kapanışı
      while (j + 1 < t3.length && t3[j + 1] < end) j++;   // o ana kadar başlamış son 3m mum
      vals.push(j >= off3 && t3[j] < end ? e3[j - off3] : null);
    }
    out.unshift({ label: '3m EMA21', color: C.ema3, values: vals });
  }
  return out;
}

/** Series'ten 5m mum listesi (yarım mum dahil) */
function candlesFromSeries(series, tf = '5m') {
  const t = series.col(tf, 't'), o = series.col(tf, 'o'), h = series.col(tf, 'h'), l = series.col(tf, 'l'), c = series.col(tf, 'c'), v = series.col(tf, 'v');
  return t.map((_, i) => ({ t: t[i], o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] }));
}

module.exports = { renderChart, candlesFromSeries, emaOverlays, ichimoku, DEFAULT_ICHI, available: () => Boolean(lib()) };
