'use strict';

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
  level: '#f5a623', levelOther: '#7d8796',
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
function renderChart({ symbol, candles, level = null, levels = [], overlays = [], ichi = DEFAULT_ICHI, showIchi = true, fib = true, tf = '5m', subtitle = '', show = 100, tz = process.env.DISPLAY_TZ || 'Europe/Istanbul' }) {
  const L = lib();
  if (!L || !candles || candles.length < 20) return null;
  try {
    const h = candles.map(k => k.h), l = candles.map(k => k.l), c = candles.map(k => k.c);
    const I = ichimoku(h, l, c, ichi);
    const n = candles.length;
    const N = Math.min(show, n);
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
    const otherLevels = levels.filter(L0 => near(L0) && (!level || L0.name !== level.name));
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

    // Fibonacci düzeltme seviyeleri — görünen penceredeki en düşük ve en yüksek noktaya göre.
    // Dip tepeden önceyse (yükseliş) 0 = tepe, 1 = dip; tersi (düşüş) 0 = dip, 1 = tepe.
    let fibInfo = null;
    if (fib) {
      let hiI = start, loI = start;
      for (let i = start; i < n; i++) { if (h[i] > h[hiI]) hiI = i; if (l[i] < l[loI]) loI = i; }
      const HI = h[hiI], Lw = l[loI], up = loI < hiI;
      if (HI > Lw) {
        fibInfo = { up };
        const R = [[0, '#7d8796'], [0.236, '#8e9aaf'], [0.382, '#5dade2'], [0.5, '#f4d03f'], [0.618, '#f39c12'], [0.786, '#e67e22'], [1, '#7d8796']];
        g.font = '13px ChartSans'; g.textAlign = 'left';
        for (const [r, col] of R) {
          const v = up ? HI - (HI - Lw) * r : Lw + (HI - Lw) * r;
          const y = ys(v);
          g.strokeStyle = col; g.globalAlpha = r === 0.618 || r === 0.5 ? 0.9 : 0.6; g.lineWidth = r === 0.618 ? 1.6 : 1;
          g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke();
          g.globalAlpha = 1;
          const lab = `${r} · ${fmtPx(v)}`;
          const tw = g.measureText(lab).width;
          g.fillStyle = 'rgba(15,20,27,0.8)'; g.fillRect(padL + 2, y - 15, tw + 8, 16);
          g.fillStyle = col; g.fillText(lab, padL + 6, y - 3);
        }
        // tepe ve dip noktaları
        g.fillStyle = '#7d8796';
        g.beginPath(); g.arc(xs(hiI - start), ys(HI), 3.5, 0, 7); g.fill();
        g.beginPath(); g.arc(xs(loI - start), ys(Lw), 3.5, 0, 7); g.fill();
      }
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

    // Diğer seviyeler (gri, ince) — etiket sağda
    for (const L0 of otherLevels) {
      const y = ys(L0.value);
      g.strokeStyle = C.levelOther; g.lineWidth = 1; g.setLineDash([4, 6]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
      g.font = '13px ChartSans'; g.textAlign = 'right'; g.fillStyle = C.levelOther;
      g.fillText(`${L0.name} ${fmtPx(L0.value)}`, padL + plotW - 6, y - 5);
      g.textAlign = 'left';
    }
    // Direnç seviyesi (en yakın, turuncu)
    if (showLevel) {
      const y = ys(level.value);
      g.strokeStyle = C.level; g.lineWidth = 1.5; g.setLineDash([8, 6]);
      g.beginPath(); g.moveTo(padL, y); g.lineTo(padL + plotW, y); g.stroke(); g.setLineDash([]);
      g.font = '15px ChartSansBold'; g.textAlign = 'left';
      const lab = `${level.name}  ${fmtPx(level.value)}`;
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
      ...(fibInfo ? [[`Fibonacci (${fibInfo.up ? 'dip → tepe' : 'tepe → dip'}, ${N} mum)`, '#f39c12']] : []),
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
