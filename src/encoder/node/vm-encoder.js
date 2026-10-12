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
const path = require('path');
const zlib = require('zlib');

// ── Parse args ──────────────────────────────────────────
const args = process.argv.slice(2);

function hasFlag(name) {
    return args.includes('--' + name);
}

function showHelp() {
    console.log(`
  vm-escape encoder — encode any file into a visual pixel grid (HTML)

  USAGE
    node src/encoder/vm-encoder.js <file> [options]
    npm run encode -- <file> [options]

  ARGUMENTS
    <file>              Input file to encode (any format).
                        If not already gzipped, it will be compressed automatically.

  OPTIONS
    --mode q4|q2|rgb    Encoding mode (default: q4)
                          q4  — 4-level quantized, ~9.1 KB/frame. Survives lossy
                                screen capture (getDisplayMedia, screenshots of video).
                          q2  — 2-level quantized (black/white per channel),
                                ~4.5 KB/frame. Ultra-robust for nested VMs or
                                heavily compressed video. Half the bitrate of Q4.
                          rgb — full 24-bit color, ~36.4 KB/frame. Use only with
                                lossless PNG screenshots.
    --block N           Pixel block size in px (default: 8). Larger blocks are easier to
                        capture but reduce throughput.
    --delay N           Frame display interval in ms (default: 300). Lower = faster
                        transfer, but decoder must keep up. Min 50ms.
    --output FILE       Output HTML file path (default: tmp/frames.html)
    --help, -h          Show this help message

  EXAMPLES
    # Encode an Allure report archive (Q4 mode, default)
    node src/encoder/vm-encoder.js dummies/allure-small.tar.gz

    # Same thing via npm script
    npm run encode -- dummies/allure-small.tar.gz

    # Use RGB mode for lossless screenshot capture
    node src/encoder/vm-encoder.js report.tar.gz --mode rgb

    # Custom block size and output path
    node src/encoder/vm-encoder.js data.tar.gz --block 10 --output my-frames.html

  WORKFLOW
    1. Run the encoder on the file inside the VM -> produces an HTML file
    2. Open the HTML in a browser inside the VM -> plays animated pixel frames
    3. On the host machine, open src/decoder/host-decoder.html in a browser
    4. Click "Start Capture" -> select the VM window -> wait for 100%
    5. Download the decoded file on the host
`);
    process.exit(0);
}

if (hasFlag('help') || hasFlag('h') || args.includes('-h')) {
    showHelp();
}

const inputFile = args.find(a => !a.startsWith('--') && a !== '-h');

if (!inputFile) {
    console.error('Error: no input file specified.\n');
    console.error('Usage: node src/encoder/vm-encoder.js <file> [--mode q4|rgb] [--output FILE]');
    console.error('\nRun with --help for full usage information.');
    process.exit(1);
}

function getArg(name, def) {
    const i = args.indexOf('--' + name);
    return i !== -1 && args[i + 1] ? args[i + 1] : def;
}

const MODE   = getArg('mode', 'q4');
const BLOCK  = parseInt(getArg('block', '8'));
const DELAY  = Math.max(50, parseInt(getArg('delay', '300')));
const OUTPUT = getArg('output', 'tmp/frames.html');

if (MODE !== 'q4' && MODE !== 'q2' && MODE !== 'rgb') {
    console.error('Invalid mode "' + MODE + '". Use q4, q2 or rgb.');
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
    : MODE === 'q2'
    ? Math.floor(CELLS_PER_FRAME / 8) * 3
    : CELLS_PER_FRAME * 3;

const MODE_ID = MODE === 'q4' ? 1 : MODE === 'q2' ? 2 : 0;
const CANVAS_W = COLS * BLOCK + 2 * BORDER;
const CANVAS_H = ROWS * BLOCK + 2 * BORDER;

// ── Read & compress input ───────────────────────────────
if (!fs.existsSync(inputFile)) {
    console.error('Error: file not found: ' + inputFile);
    console.error('Check the path and try again.');
    process.exit(1);
}

let data;
if (fs.statSync(inputFile).isDirectory()) {
    // Directory — pack as tar (pure JS, no external deps)
    console.log('Input is a directory, packing as tar...');
    const tarBufs = [];

    function tarHeader(name, size) {
        const buf = Buffer.alloc(512); // all zeros
        buf.write(name, 0, Math.min(name.length, 100));
        buf.write('0100644', 100, 7);                                // mode
        buf.write('0001750', 108, 7);                                // uid
        buf.write('0001750', 116, 7);                                // gid
        buf.write(size.toString(8).padStart(11, '0'), 124, 11);     // size
        const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, '0');
        buf.write(mtime, 136, 11);                                   // mtime
        buf.fill(0x20, 148, 156);                                    // checksum placeholder = spaces
        buf[156] = 0x30;                                             // typeflag '0' = regular file
        buf.write('ustar', 257, 5);                                  // magic (null already at 262)
        buf.write('00', 263, 2);                                     // version
        // compute checksum
        let cksum = 0;
        for (let i = 0; i < 512; i++) cksum += buf[i];
        const cs = cksum.toString(8).padStart(6, '0');
        buf.write(cs, 148, 6);
        buf[154] = 0;                                                // null terminator
        buf[155] = 0x20;                                             // trailing space
        return buf;
    }
    function walkDir(dir, prefix) {
        const entries = fs.readdirSync(dir).sort();
        for (const e of entries) {
            const full = path.join(dir, e);
            const rel = prefix ? prefix + '/' + e : e;
            const st = fs.statSync(full);
            if (st.isDirectory()) {
                walkDir(full, rel);
            } else if (st.isFile()) {
                const fileData = fs.readFileSync(full);
                tarBufs.push(tarHeader(rel, fileData.length));
                tarBufs.push(fileData);
                const pad = (512 - (fileData.length % 512)) % 512;
                if (pad > 0) tarBufs.push(Buffer.alloc(pad));
            }
        }
    }

    walkDir(path.resolve(inputFile), path.basename(inputFile));
    tarBufs.push(Buffer.alloc(1024)); // end-of-archive marker
    data = Buffer.concat(tarBufs);
    console.log('Input:  ' + inputFile + '/ -> tar (' + (data.length / 1048576).toFixed(2) + ' MB)');
} else {
    data = fs.readFileSync(inputFile);
    console.log('Input:  ' + inputFile + ' (' + (data.length / 1048576).toFixed(2) + ' MB)');
}

if (data[0] !== 0x1f || data[1] !== 0x8b) {
    console.log('Compressing with gzip -9…');
    data = zlib.gzipSync(data, { level: 9 });
    console.log('Compressed: ' + (data.length / 1048576).toFixed(2) + ' MB');
}

const totalFrames = Math.ceil(data.length / BYTES_PER_FRAME);
console.log('Mode:   ' + MODE + (MODE === 'q4' ? ' (4-level quantized, lossy-safe)' : MODE === 'q2' ? ' (2-level quantized, ultra-robust)' : ' (full RGB, lossless only)'));
console.log('Grid:   ' + COLS + '×' + ROWS + ' cells, block=' + BLOCK + 'px, canvas=' + CANVAS_W + '×' + CANVAS_H);
console.log('Payload per frame: ' + (BYTES_PER_FRAME / 1024).toFixed(1) + ' KB (' + CELLS_PER_FRAME + ' data cells)');
console.log('Frames: ' + totalFrames);

const estMinutes = (totalFrames * DELAY / 1000 / 60).toFixed(1);
console.log('Delay:  ' + DELAY + 'ms/frame');
console.log('Est. capture time: ~' + estMinutes + ' min (' + totalFrames + ' frames × ' + DELAY + 'ms)');

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
// Q2 magic: val=5 → (255,0,255) magenta, val=6 → (255,255,0) yellow
const Q2_MAGIC0_VAL = 5;
const Q2_MAGIC1_VAL = 6;

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
  background:${MODE === 'q4' ? '#530' : MODE === 'q2' ? '#350' : '#035'};color:${MODE === 'q4' ? '#fa0' : MODE === 'q2' ? '#af0' : '#0af'}}
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
  <button onclick="spd(50)">50</button>
  <button onclick="spd(100)">100</button>
  <button onclick="spd(200)">200</button>
  <button onclick="spd(300)" id="s300">300</button>
  <button onclick="spd(500)" id="s500">500</button>
  <button onclick="spd(1000)">1000</button>
</div>
<div id="hint"><kbd>←</kbd> prev  <kbd>→</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>

<script>
// ── Embedded payload (base64) ──
const B64="${b64}";

// ── Constants ──
const BLK=${BLOCK},COLS=${COLS},ROWS=${ROWS},BDR=${BORDER};
const BPF=${BYTES_PER_FRAME};
const MODE=${MODE_ID}; // 0=RGB, 1=Q4, 2=Q2

// ── Decode base64 → Uint8Array ──
function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
const data=b2u(B64);
const TF=Math.ceil(data.length/BPF);

let cur=0,playing=false,looping=true,timer=null,speed=${DELAY};
const cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');

// ── Offscreen double buffer (avoids tearing during frame transitions) ──
const offCv=document.createElement('canvas');
offCv.width=cv.width;offCv.height=cv.height;
const off=offCv.getContext('2d');

// ── CRC-32 ──
function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}

// ── Draw helpers ──
function cell(c,r,R,G,B){off.fillStyle='rgb('+R+','+G+','+B+')';off.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}

// Q4: encode 6-bit value as RGB (2 bits per channel, levels 0,85,170,255)
function q4cell(c,r,val){
  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);
}

// Q2: encode 3-bit value as RGB (1 bit per channel, levels 0,255)
function q2cell(c,r,val){
  cell(c,r,((val>>2)&1)*255,((val>>1)&1)*255,(val&1)*255);
}

// ── Draw one frame ──
function draw(idx){
  off.fillStyle='#000';off.fillRect(0,0,offCv.width,offCv.height);

  // Sync border (alternating black / magenta cells)
  for(let i=0;i<COLS+2;i++){
    off.fillStyle=i%2?'#f0f':'#000';
    off.fillRect(i*BLK,0,BLK,BDR);
    off.fillRect(i*BLK,BDR+ROWS*BLK,BLK,BDR);
  }
  for(let j=0;j<ROWS;j++){
    off.fillStyle=j%2?'#f0f':'#000';
    off.fillRect(0,BDR+j*BLK,BDR,BLK);
    off.fillRect(BDR+COLS*BLK,BDR+j*BLK,BDR,BLK);
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
  } else if(MODE===2){
    // ═══ Q2 HEADER ═══
    // Q2: 3 bits/cell (1 bit per channel), values 0-7
    function q2h(col,val){ q2cell(col,0,val); }

    // Magic
    q2h(0,${Q2_MAGIC0_VAL}); // (255,0,255) magenta
    q2h(1,${Q2_MAGIC1_VAL}); // (255,255,0) yellow
    // Frame index (18 bits → 6 cells × 3 bits)
    q2h(2,(idx>>15)&7); q2h(3,(idx>>12)&7); q2h(4,(idx>>9)&7);
    q2h(5,(idx>>6)&7);  q2h(6,(idx>>3)&7);  q2h(7,idx&7);
    // Total frames (18 bits → 6 cells)
    q2h(8,(TF>>15)&7);  q2h(9,(TF>>12)&7);  q2h(10,(TF>>9)&7);
    q2h(11,(TF>>6)&7);  q2h(12,(TF>>3)&7);  q2h(13,TF&7);
    // Data length (18 bits → 6 cells)
    q2h(14,(dl>>15)&7); q2h(15,(dl>>12)&7); q2h(16,(dl>>9)&7);
    q2h(17,(dl>>6)&7);  q2h(18,(dl>>3)&7);  q2h(19,dl&7);
    // CRC32 (32 bits → 11 cells, 33 bits available, MSB first)
    q2h(20,(chk>>>30)&7); q2h(21,(chk>>>27)&7); q2h(22,(chk>>>24)&7);
    q2h(23,(chk>>>21)&7); q2h(24,(chk>>>18)&7); q2h(25,(chk>>>15)&7);
    q2h(26,(chk>>>12)&7); q2h(27,(chk>>>9)&7);  q2h(28,(chk>>>6)&7);
    q2h(29,(chk>>>3)&7);  q2h(30,chk&7);
    // Grid dims: COLS (4 cells=12 bits), ROWS (4 cells), block (2 cells), mode (1 cell)
    q2h(31,(COLS>>9)&7); q2h(32,(COLS>>6)&7); q2h(33,(COLS>>3)&7); q2h(34,COLS&7);
    q2h(35,(ROWS>>9)&7); q2h(36,(ROWS>>6)&7); q2h(37,(ROWS>>3)&7); q2h(38,ROWS&7);
    q2h(39,(BLK>>3)&7);  q2h(40,BLK&7);
    q2h(41,2); // mode marker = 2
    // Padding
    for(let c=42;c<COLS;c++) q2h(c,0);

    // ═══ Q2 DATA ═══
    // 8 cells × 3 bits = 24 bits = 3 bytes
    let bi=0, ci=0;
    const totalCells=COLS*(ROWS-1);
    while(ci<totalCells){
      const b0=bi<dl?fd[bi++]:0;
      const b1=bi<dl?fd[bi++]:0;
      const b2=bi<dl?fd[bi++]:0;
      // 24 bits → 8 × 3-bit values
      const v0=(b0>>5)&7;
      const v1=(b0>>2)&7;
      const v2=((b0&3)<<1)|(b1>>7);
      const v3=(b1>>4)&7;
      const v4=(b1>>1)&7;
      const v5=((b1&1)<<2)|(b2>>6);
      const v6=(b2>>3)&7;
      const v7=b2&7;
      const vals=[v0,v1,v2,v3,v4,v5,v6,v7];
      for(let k=0;k<8&&ci<totalCells;k++,ci++){
        const r=Math.floor(ci/COLS)+1;
        const c=ci%COLS;
        q2cell(c,r,vals[k]);
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

  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE===2?'Q2':MODE===1?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';

  // Atomic blit: copy completed frame to visible canvas in one operation
  cx.drawImage(offCv,0,0);
}

// ── Controls (rAF-synced playback) ──
// rAF-synced: each frame survives at least one vsync before next swap.
let rafId=null, lastFrameTime=0;

function advance(){
  if(cur>=TF-1){
    if(looping){cur=0} else {togglePlay();return}
  } else {cur++}
  draw(cur);
}

function next(){advance()}
function prev(){cur=Math.max(cur-1,0);draw(cur)}

function playLoop(ts){
  if(!playing) return;
  if(ts-lastFrameTime>=speed){
    advance();
    lastFrameTime=ts;
  }
  rafId=requestAnimationFrame(playLoop);
}

function togglePlay(){
  playing=!playing;
  document.getElementById('bp').textContent=playing?'⏸ Pause':'▶ Play';
  if(playing){
    lastFrameTime=performance.now();
    rafId=requestAnimationFrame(playLoop);
  } else {
    if(rafId){cancelAnimationFrame(rafId);rafId=null}
  }
}

function toggleLoop(){
  looping=!looping;
  const bl=document.getElementById('bl');
  bl.classList.toggle('loop-on',looping);
  bl.textContent=looping?'🔁 Loop ON':'🔁 Loop OFF';
}

function spd(ms){
  speed=ms;
  document.querySelectorAll('#ctrl button.active').forEach(b=>{if(b.id!=='bl')b.classList.remove('active')});
  event.target.classList.add('active');
  // playLoop reads speed live, no restart needed
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

// Mark initial speed button as active
const initBtn = document.getElementById('s' + speed);
if (initBtn) initBtn.classList.add('active');

draw(0);
</script>
</body>
</html>`;

// Ensure output directory exists
const outDir = path.dirname(OUTPUT);
if (outDir && outDir !== '.' && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}
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