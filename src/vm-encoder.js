#!/usr/bin/env node
'use strict';

/**
 * ===== VISUAL ENCODER v2 =====
 * Encodes a file into an animated colored block grid on HTML canvas.
 *
 * Modes:
 *   q4  — 4 levels per channel (0,85,170,255), 6 bits/cell.
 *          Resilient to lossy compression (getDisplayMedia / screen capture).
 *          ~9.1 KB/frame.
 *   rgb — classic 3 bytes per cell (lossless screenshots only).
 *          ~36.4 KB/frame.
 *
 * Usage:
 *   node vm-encoder.js results.tar.gz                    # Q4 by default
 *   node vm-encoder.js results.tar.gz --mode rgb          # classic mode
 *   node vm-encoder.js results.tar.gz --block 8 --output frames.html
 */

const fs = require('fs');
const zlib = require('zlib');

// ── Parse args ──────────────────────────────────────────
const args = process.argv.slice(2);
const inputFile = args.find(a => !a.startsWith('--'));

if (!inputFile) {
    console.error('Usage: node vm-encoder-v2.js <file> [options]');
    console.error('  --mode q4|rgb   encoding mode (default: q4)');
    console.error('  --block N       block size in px (default: 8)');
    console.error('  --output FILE   output HTML (default: frames.html)');
    process.exit(1);
}

function getArg(name, def) {
    const i = args.indexOf('--' + name);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const MODE   = getArg('mode', 'q4');
const BLOCK  = parseInt(getArg('block', '8'));
const OUTPUT = getArg('output', 'frames.html');

if (MODE !== 'q4' && MODE !== 'rgb') {
    console.error('Invalid mode "' + MODE + '". Use q4 or rgb.');
    process.exit(1);
}

// ── Grid geometry ───────────────────────────────────────
const BORDER = BLOCK;
const COLS   = Math.floor((1200 - 2 * BORDER) / BLOCK);
const ROWS   = Math.floor((700  - 2 * BORDER) / BLOCK);
const HEADER_ROWS    = 1;
const DATA_ROWS      = ROWS - HEADER_ROWS;
const CELLS_PER_FRAME = DATA_ROWS * COLS;

// Q4: 4 cells → 3 bytes;  RGB: 1 cell → 3 bytes
const BYTES_PER_FRAME = MODE === 'q4'
    ? Math.floor(CELLS_PER_FRAME / 4) * 3
    : CELLS_PER_FRAME * 3;

const MODE_ID = MODE === 'q4' ? 1 : 0;
const CANVAS_W = COLS * BLOCK + 2 * BORDER;
const CANVAS_H = ROWS * BLOCK + 2 * BORDER;

// ── Read & compress input ───────────────────────────────
let data = fs.readFileSync(inputFile);
console.log('Input:  ' + inputFile + ' (' + (data.length / 1048576).toFixed(2) + ' MB)');

if (data[0] !== 0x1f || data[1] !== 0x8b) {
    console.log('Compressing with gzip -9…');
    data = zlib.gzipSync(data, { level: 9 });
    console.log('Compressed: ' + (data.length / 1048576).toFixed(2) + ' MB');
}

const totalFrames = Math.ceil(data.length / BYTES_PER_FRAME);
console.log('Mode:   ' + MODE + (MODE === 'q4' ? ' (4-level quantized, lossy-safe)' : ' (full RGB, lossless only)'));
console.log('Grid:   ' + COLS + '×' + ROWS + ' cells, block=' + BLOCK + 'px, canvas=' + CANVAS_W + '×' + CANVAS_H);
console.log('Payload per frame: ' + (BYTES_PER_FRAME / 1024).toFixed(1) + ' KB (' + CELLS_PER_FRAME + ' data cells)');
console.log('Frames: ' + totalFrames);

const estMinutes = (totalFrames * 0.5 / 60).toFixed(1);
console.log('Est. capture time at 500ms/frame: ~' + estMinutes + ' min');

// ── Feasibility check ───────────────────────────────────
const b64 = data.toString('base64');
const htmlSizeMB = (b64.length * 1.05) / 1048576;
if (htmlSizeMB > 200) {
    console.error('\n⚠  HTML will be ~' + htmlSizeMB.toFixed(0) + ' MB — browser may not handle it.');
    process.exit(1);
}
if (htmlSizeMB > 50) {
    console.warn('\n⚠  HTML will be ~' + htmlSizeMB.toFixed(0) + ' MB — may load slowly.');
}

// ── Q4 magic values ─────────────────────────────────────
// Q4 magic cell 0: val=55 → R=3*85=255, G=1*85=85, B=3*85=255
// Q4 magic cell 1: val=28 → R=1*85=85,  G=3*85=255, B=0*85=0
const Q4_MAGIC0_VAL = 55;
const Q4_MAGIC1_VAL = 28;

// ── Generate HTML ───────────────────────────────────────
const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Visual Encoder v2 — ${MODE.toUpperCase()} — ${totalFrames} frames</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#ccc;font:13px/1.4 monospace;display:flex;flex-direction:column;align-items:center;padding:8px}
#info{margin:6px 0;font-size:14px;letter-spacing:.5px}
canvas{image-rendering:pixelated;image-rendering:crisp-edges}
#ctrl{margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}
button{padding:4px 14px;font:13px monospace;cursor:pointer;background:#222;color:#eee;border:1px solid #444;border-radius:3px}
button:hover{background:#333}
button.active{background:#060;border-color:#0a0}
button.loop-on{background:#006;border-color:#00a}
kbd{background:#222;padding:1px 5px;border-radius:2px;border:1px solid #444;font-size:12px}
#hint{font-size:11px;color:#666;margin-top:4px}
#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;
  background:${MODE === 'q4' ? '#530' : '#035'};color:${MODE === 'q4' ? '#fa0' : '#0af'}}
</style>
</head>
<body>

<div id="info">Loading…</div>
<div><span id="mode-badge">${MODE.toUpperCase()} mode</span></div>
<canvas id="c" width="${CANVAS_W}" height="${CANVAS_H}"></canvas>
<div id="ctrl">
  <button onclick="prev()">◀</button>
  <button onclick="togglePlay()" id="bp">▶ Play</button>
  <button onclick="next()">▶</button>
  <button onclick="toggleLoop()" id="bl">🔁 Loop</button>
  <span style="margin-left:12px">ms/frame:</span>
  <button onclick="spd(200)">200</button>
  <button onclick="spd(300)">300</button>
  <button onclick="spd(500)" class="active" id="s500">500</button>
  <button onclick="spd(1000)">1000</button>
  <button onclick="spd(2000)">2000</button>
</div>
<div id="hint"><kbd>←</kbd> prev  <kbd>→</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>

<script>
// ── Embedded payload (base64) ──
const B64="${b64}";

// ── Constants ──
const BLK=${BLOCK},COLS=${COLS},ROWS=${ROWS},BDR=${BORDER};
const BPF=${BYTES_PER_FRAME};
const MODE=${MODE_ID}; // 0=RGB, 1=Q4

// ── Decode base64 → Uint8Array ──
function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
const data=b2u(B64);
const TF=Math.ceil(data.length/BPF);

let cur=0,playing=false,looping=true,timer=null,speed=500;
const cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');

// ── CRC-32 ──
function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}

// ── Draw helpers ──
function cell(c,r,R,G,B){cx.fillStyle='rgb('+R+','+G+','+B+')';cx.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}

// Q4: encode 6-bit value as RGB (2 bits per channel, levels 0,85,170,255)
function q4cell(c,r,val){
  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);
}

// ── Draw one frame ──
function draw(idx){
  cx.fillStyle='#000';cx.fillRect(0,0,cv.width,cv.height);

  // Sync border (alternating black / magenta cells)
  for(let i=0;i<COLS+2;i++){
    cx.fillStyle=i%2?'#f0f':'#000';
    cx.fillRect(i*BLK,0,BLK,BDR);
    cx.fillRect(i*BLK,BDR+ROWS*BLK,BLK,BDR);
  }
  for(let j=0;j<ROWS;j++){
    cx.fillStyle=j%2?'#f0f':'#000';
    cx.fillRect(0,BDR+j*BLK,BDR,BLK);
    cx.fillRect(BDR+COLS*BLK,BDR+j*BLK,BDR,BLK);
  }

  // Frame payload slice
  const s=idx*BPF, e=Math.min(s+BPF,data.length);
  const fd=data.slice(s,e), dl=fd.length;
  const chk=crc32(fd);

  if(MODE===1){
    // ═══ Q4 HEADER ═══
    // Magic
    q4cell(0,0,${Q4_MAGIC0_VAL}); // (255,85,255)
    q4cell(1,0,${Q4_MAGIC1_VAL}); // (85,255,0)
    // Frame index (18 bits → 3 cells)
    q4cell(2,0,(idx>>12)&0x3F);
    q4cell(3,0,(idx>>6)&0x3F);
    q4cell(4,0,idx&0x3F);
    // Total frames (18 bits → 3 cells)
    q4cell(5,0,(TF>>12)&0x3F);
    q4cell(6,0,(TF>>6)&0x3F);
    q4cell(7,0,TF&0x3F);
    // Data length this frame (18 bits → 3 cells)
    q4cell(8,0,(dl>>12)&0x3F);
    q4cell(9,0,(dl>>6)&0x3F);
    q4cell(10,0,dl&0x3F);
    // CRC32 (32 bits → 6 cells, MSB first)
    q4cell(11,0,(chk>>>26)&0x3F);
    q4cell(12,0,(chk>>>20)&0x3F);
    q4cell(13,0,(chk>>>14)&0x3F);
    q4cell(14,0,(chk>>>8)&0x3F);
    q4cell(15,0,(chk>>>2)&0x3F);
    q4cell(16,0,(chk&0x3)<<4);
    // Grid dims: COLS (2 cells), ROWS (2 cells), block size (1 cell)
    q4cell(17,0,(COLS>>6)&0x3F);
    q4cell(18,0,COLS&0x3F);
    q4cell(19,0,(ROWS>>6)&0x3F);
    q4cell(20,0,ROWS&0x3F);
    q4cell(21,0,BLK&0x3F);
    // Mode marker
    q4cell(22,0,1);
    // Padding
    for(let c=23;c<COLS;c++) q4cell(c,0,0);

    // ═══ Q4 DATA ═══
    // 4 cells → 3 bytes (24 bits → 4×6 bits)
    let bi=0, ci=0;
    const totalCells=COLS*(ROWS-1);
    while(ci<totalCells){
      const b0=bi<dl?fd[bi++]:0;
      const b1=bi<dl?fd[bi++]:0;
      const b2=bi<dl?fd[bi++]:0;
      const v0=b0>>2;
      const v1=((b0&3)<<4)|(b1>>4);
      const v2=((b1&0xF)<<2)|(b2>>6);
      const v3=b2&0x3F;
      const vals=[v0,v1,v2,v3];
      for(let k=0;k<4&&ci<totalCells;k++,ci++){
        const r=Math.floor(ci/COLS)+1;
        const c=ci%COLS;
        q4cell(c,r,vals[k]);
      }
    }
  } else {
    // ═══ RGB HEADER (same as v1) ═══
    cell(0,0,0xDE,0xAD,0x01);
    cell(1,0,0xBE,0xEF,0x02);
    cell(2,0,(idx>>16)&0xFF,(idx>>8)&0xFF,idx&0xFF);
    cell(3,0,(TF>>16)&0xFF,(TF>>8)&0xFF,TF&0xFF);
    cell(4,0,(dl>>16)&0xFF,(dl>>8)&0xFF,dl&0xFF);
    cell(5,0,(chk>>24)&0xFF,(chk>>16)&0xFF,(chk>>8)&0xFF);
    cell(6,0,chk&0xFF,COLS&0xFF,ROWS&0xFF);
    cell(7,0,BLK,0,0);
    for(let c=8;c<COLS;c++) cell(c,0,0x80,0x80,0x80);

    // ═══ RGB DATA ═══
    let bi=0;
    for(let r=1;r<ROWS;r++){
      for(let c=0;c<COLS;c++){
        const R=bi<dl?fd[bi++]:0,G=bi<dl?fd[bi++]:0,B=bi<dl?fd[bi++]:0;
        cell(c,r,R,G,B);
      }
    }
  }

  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';
}

// ── Controls ──
function next(){
  if(cur>=TF-1){
    if(looping){cur=0;draw(0)}
    return;
  }
  cur++;draw(cur);
}
function prev(){cur=Math.max(cur-1,0);draw(cur)}

function togglePlay(){
  playing=!playing;
  document.getElementById('bp').textContent=playing?'⏸ Pause':'▶ Play';
  if(playing){
    timer=setInterval(()=>{
      if(cur>=TF-1){
        if(looping){cur=0;draw(0)}
        else{togglePlay()}
        return;
      }
      next();
    },speed);
  } else clearInterval(timer);
}

function toggleLoop(){
  looping=!looping;
  const bl=document.getElementById('bl');
  bl.classList.toggle('loop-on',looping);
  bl.textContent=looping?'🔁 Loop ON':'🔁 Loop OFF';
}

function spd(ms){
  speed=ms;
  document.querySelectorAll('#ctrl button').forEach(b=>b.classList.remove('active'));
  const b=document.getElementById('s'+ms);if(b)b.classList.add('active');
  if(playing){clearInterval(timer);timer=setInterval(()=>{if(cur>=TF-1){if(looping){cur=0;draw(0)}else{togglePlay()}return}next()},speed)}
}

document.addEventListener('keydown',e=>{
  if(e.key==='ArrowRight')next();
  else if(e.key==='ArrowLeft')prev();
  else if(e.key===' '){e.preventDefault();togglePlay()}
  else if(e.key==='Home'){cur=0;draw(0)}
  else if(e.key==='End'){cur=TF-1;draw(cur)}
  else if(e.key==='l'||e.key==='L')toggleLoop();
});

// Auto-start loop indicator
document.getElementById('bl').classList.add('loop-on');

draw(0);
</script>
</body>
</html>`;

fs.writeFileSync(OUTPUT, html);

const outSize = Buffer.byteLength(html);
console.log('\n✅ ' + OUTPUT + '  (' + (outSize / 1048576).toFixed(2) + ' MB)');
console.log('');
console.log('Next steps:');
console.log('  1. Open ' + OUTPUT + ' in the browser inside the VM');
console.log('  2. Press Play + Loop (or Space + L)');
console.log('  3. On the host, open host-decoder.html');
console.log('  4. Click "Start Capture" and select the VM window');
console.log('  5. Wait for 100% and download the file');