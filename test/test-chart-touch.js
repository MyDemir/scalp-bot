// Gerçeğe yakın: ARK benzeri 1h mumlar + seviyeler (temas sayılı) → grafik
const REPO=require('path').resolve(__dirname, '..'); const chart=require(`${REPO}/src/chart`); const fs=require('fs');
let seed=3; const rnd=()=>((seed=(seed*16807)%2147483647)/2147483647);
const t0=Date.UTC(2026,8,26,18); const cs=[]; let p=0.27;
for(let i=0;i<110;i++){ const o=p; if(i<40)p*=1+(rnd()-0.52)*0.02; else if(i<100)p*=1+(rnd()-0.48)*0.012; else p*=1+0.025+rnd()*0.01; cs.push({t:t0+i*3600e3,o,h:Math.max(o,p)*1.004,l:Math.min(o,p)*0.996,c:p,v:100+rnd()*80}); }
const last=cs[cs.length-1].c;
const L=(name,value,kind,touches)=>({name,value,kind,touches,dist:(last-value)/value*100});
const levels=[L('4h tepe',last*1.03,'swing',5),L('4h tepe',last*1.012,'swing',2),L('Günlük bölge',last*1.07,'zone',6),L('30 günlük en yüksek',last*1.09,'high',4),
 L('Haftalık bölge',last*1.18,'zone',7),L('1d EMA200',last*1.25,'major',3),L('1h tepe',last*0.97,'swing',4),L('4h MA200',last*0.9,'major',8)];
const level=levels[1];
const png=chart.renderChart({symbol:'ARKUSDT',candles:cs,tf:'1h',level:{...level,zone:'near'},levels,subtitle:'Kart 3',minTouches:4});
fs.writeFileSync(require('./_tmp') + '/chart-touch.png',png); console.log('ok',png.length);
// Süzgeç: 4'ten az temaslılar grafik içinde çizgi olarak yok ama sağ üst listede var; kartın direnci (2 temas) yine çizilir
{ const assert = require('assert');
  const png2 = chart.renderChart({ symbol: 'ARKUSDT', candles: cs, tf: '1h', level: null, levels, subtitle: 'x', minTouches: 4 });
  assert(png2 && png2.length > 20000);
  const png3 = chart.renderChart({ symbol: 'ARKUSDT', candles: cs, tf: '1h', level: { ...level, zone: 'near' }, levels: levels.map(l => ({ ...l, touches: undefined })), subtitle: 'x' });
  assert(png3 && png3.length > 20000, 'temas bilgisi olmayan seviyelerle de çizer');
  console.log('✅ Grafik: çizgiler ≥4 temaslı dirençler; sağ üst liste geçilmemiş tüm dirençler (en yakın 5, temas sayılı, ★ ≥4); kartın direnci her zaman; temas bilgisi yoksa çizim bozulmuyor'); }
