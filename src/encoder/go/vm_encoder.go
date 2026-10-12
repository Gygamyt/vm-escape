package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

func main() {
	args := os.Args[1:]

	// ── Parse args ──────────────────────────────────────────
	hasFlag := func(name string) bool {
		for _, a := range args {
			if a == "--"+name {
				return true
			}
		}
		return false
	}

	if hasFlag("help") || hasFlag("h") {
		for _, a := range args {
			if a == "-h" {
				showHelp()
			}
		}
		showHelp()
	}
	for _, a := range args {
		if a == "-h" {
			showHelp()
		}
	}

	var inputFile string
	for _, a := range args {
		if !strings.HasPrefix(a, "--") && a != "-h" {
			inputFile = a
			break
		}
	}

	if inputFile == "" {
		fmt.Fprintln(os.Stderr, "Error: no input file specified.\n")
		fmt.Fprintln(os.Stderr, "Usage: go run vm_encoder.go <file> [--mode q4|rgb] [--output FILE]")
		fmt.Fprintln(os.Stderr, "\nRun with --help for full usage information.")
		os.Exit(1)
	}

	getArg := func(name, def string) string {
		for i, a := range args {
			if a == "--"+name && i+1 < len(args) {
				return args[i+1]
			}
		}
		return def
	}

	MODE := getArg("mode", "q4")
	BLOCK := parseInt(getArg("block", "8"))
	DELAY := parseInt(getArg("delay", "300"))
	if DELAY < 50 {
		DELAY = 50
	}
	OUTPUT := getArg("output", "tmp/frames.html")

	if MODE != "q4" && MODE != "q2" && MODE != "rgb" {
		fmt.Fprintf(os.Stderr, "Invalid mode \"%s\". Use q4, q2 or rgb.\n", MODE)
		os.Exit(1)
	}

	// ── Grid geometry ───────────────────────────────────────
	BORDER := BLOCK
	COLS := (1200 - 2*BORDER) / BLOCK
	ROWS := (700 - 2*BORDER) / BLOCK
	HEADER_ROWS := 1
	DATA_ROWS := ROWS - HEADER_ROWS
	CELLS_PER_FRAME := DATA_ROWS * COLS

	var BYTES_PER_FRAME int
	if MODE == "q4" {
		BYTES_PER_FRAME = (CELLS_PER_FRAME / 4) * 3
	} else if MODE == "q2" {
		BYTES_PER_FRAME = (CELLS_PER_FRAME / 8) * 3
	} else {
		BYTES_PER_FRAME = CELLS_PER_FRAME * 3
	}

	var MODE_ID int
	if MODE == "q4" {
		MODE_ID = 1
	} else if MODE == "q2" {
		MODE_ID = 2
	} else {
		MODE_ID = 0
	}
	CANVAS_W := COLS*BLOCK + 2*BORDER
	CANVAS_H := ROWS*BLOCK + 2*BORDER

	// ── Read & compress input ───────────────────────────────
	fi, err := os.Stat(inputFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error: file not found: %s\n", inputFile)
		fmt.Fprintln(os.Stderr, "Check the path and try again.")
		os.Exit(1)
	}

	var data []byte

	if fi.IsDir() {
		// Directory — pack as tar
		fmt.Println("Input is a directory, packing as tar...")
		data, err = packTar(inputFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error packing directory: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Input:  %s/ -> tar (%.2f MB)\n", inputFile, float64(len(data))/1048576.0)
	} else {
		data, err = os.ReadFile(inputFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading file: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("Input:  %s (%.2f MB)\n", inputFile, float64(len(data))/1048576.0)
	}

	// Gzip if not already gzipped
	if len(data) < 2 || data[0] != 0x1f || data[1] != 0x8b {
		fmt.Println("Compressing with gzip -9…")
		data = gzipCompress(data)
		fmt.Printf("Compressed: %.2f MB\n", float64(len(data))/1048576.0)
	}

	totalFrames := int(math.Ceil(float64(len(data)) / float64(BYTES_PER_FRAME)))

	modeDesc := ""
	if MODE == "q4" {
		modeDesc = " (4-level quantized, lossy-safe)"
	} else if MODE == "q2" {
		modeDesc = " (2-level quantized, ultra-robust)"
	} else {
		modeDesc = " (full RGB, lossless only)"
	}
	fmt.Printf("Mode:   %s%s\n", MODE, modeDesc)
	fmt.Printf("Grid:   %d×%d cells, block=%dpx, canvas=%d×%d\n", COLS, ROWS, BLOCK, CANVAS_W, CANVAS_H)
	fmt.Printf("Payload per frame: %.1f KB (%d data cells)\n", float64(BYTES_PER_FRAME)/1024.0, CELLS_PER_FRAME)
	fmt.Printf("Frames: %d\n", totalFrames)

	estMinutes := float64(totalFrames) * float64(DELAY) / 1000.0 / 60.0
	fmt.Printf("Delay:  %dms/frame\n", DELAY)
	fmt.Printf("Est. capture time: ~%.1f min (%d frames × %dms)\n", estMinutes, totalFrames, DELAY)

	// ── Feasibility check ───────────────────────────────────
	b64 := base64.StdEncoding.EncodeToString(data)
	htmlSizeMB := float64(len(b64)) * 1.05 / 1048576.0
	if htmlSizeMB > 200 {
		fmt.Fprintf(os.Stderr, "\n⚠  HTML will be ~%.0f MB — browser may not handle it.\n", htmlSizeMB)
		os.Exit(1)
	}
	if htmlSizeMB > 50 {
		fmt.Fprintf(os.Stderr, "\n⚠  HTML will be ~%.0f MB — may load slowly.\n", htmlSizeMB)
	}

	// ── Q4/Q2 magic values ──────────────────────────────────
	Q4_MAGIC0_VAL := 55
	Q4_MAGIC1_VAL := 28
	Q2_MAGIC0_VAL := 5
	Q2_MAGIC1_VAL := 6

	// ── Badge colors ────────────────────────────────────────
	var badgeBg, badgeFg string
	if MODE == "q4" {
		badgeBg = "#530"
		badgeFg = "#fa0"
	} else if MODE == "q2" {
		badgeBg = "#350"
		badgeFg = "#af0"
	} else {
		badgeBg = "#035"
		badgeFg = "#0af"
	}

	// ── Generate HTML ───────────────────────────────────────
	var sb strings.Builder
	sb.WriteString(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Visual Encoder v2 — ` + strings.ToUpper(MODE) + ` — ` + strconv.Itoa(totalFrames) + ` frames</title>
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
  background:` + badgeBg + `;color:` + badgeFg + `}
</style>
</head>
<body>

<div id="info">Loading…</div>
<div><span id="mode-badge">` + strings.ToUpper(MODE) + ` mode</span></div>
<canvas id="c" width="` + strconv.Itoa(CANVAS_W) + `" height="` + strconv.Itoa(CANVAS_H) + `"></canvas>
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
const B64="` + b64 + `";

// ── Constants ──
const BLK=` + strconv.Itoa(BLOCK) + `,COLS=` + strconv.Itoa(COLS) + `,ROWS=` + strconv.Itoa(ROWS) + `,BDR=` + strconv.Itoa(BORDER) + `;
const BPF=` + strconv.Itoa(BYTES_PER_FRAME) + `;
const MODE=` + strconv.Itoa(MODE_ID) + `; // 0=RGB, 1=Q4, 2=Q2

// ── Decode base64 → Uint8Array ──
function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
const data=b2u(B64);
const TF=Math.ceil(data.length/BPF);

let cur=0,playing=false,looping=true,timer=null,speed=` + strconv.Itoa(DELAY) + `;
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
    q4cell(0,0,` + strconv.Itoa(Q4_MAGIC0_VAL) + `); // (255,85,255)
    q4cell(1,0,` + strconv.Itoa(Q4_MAGIC1_VAL) + `); // (85,255,0)
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
    q2h(0,` + strconv.Itoa(Q2_MAGIC0_VAL) + `); // (255,0,255) magenta
    q2h(1,` + strconv.Itoa(Q2_MAGIC1_VAL) + `); // (255,255,0) yellow
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
</html>`)

	html := sb.String()

	// Ensure output directory exists
	outDir := filepath.Dir(OUTPUT)
	if outDir != "" && outDir != "." {
		if err := os.MkdirAll(outDir, 0755); err != nil {
			fmt.Fprintf(os.Stderr, "Error creating output directory: %v\n", err)
			os.Exit(1)
		}
	}

	if err := os.WriteFile(OUTPUT, []byte(html), 0644); err != nil {
		fmt.Fprintf(os.Stderr, "Error writing output: %v\n", err)
		os.Exit(1)
	}

	outSize := len(html)
	fmt.Printf("\n✅ %s  (%.2f MB)\n", OUTPUT, float64(outSize)/1048576.0)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  1. Open %s in the browser inside the VM\n", OUTPUT)
	fmt.Println("  2. Press Play + Loop (or Space + L)")
	fmt.Println("  3. On the host, open host-decoder.html")
	fmt.Println("  4. Click \"Start Capture\" and select the VM window")
	fmt.Println("  5. Wait for 100% and download the file")
}

func showHelp() {
	fmt.Print(`
  vm-escape encoder — encode any file into a visual pixel grid (HTML)

  USAGE
    go run vm_encoder.go <file> [options]

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
    go run vm_encoder.go dummies/allure-small.tar.gz

    # Use RGB mode for lossless screenshot capture
    go run vm_encoder.go report.tar.gz --mode rgb

    # Custom block size and output path
    go run vm_encoder.go data.tar.gz --block 10 --output my-frames.html

  WORKFLOW
    1. Run the encoder on the file inside the VM -> produces an HTML file
    2. Open the HTML in a browser inside the VM -> plays animated pixel frames
    3. On the host machine, open src/decoder/host-decoder.html in a browser
    4. Click "Start Capture" -> select the VM window -> wait for 100%
    5. Download the decoded file on the host
`)
	os.Exit(0)
}

func parseInt(s string) int {
	v, err := strconv.Atoi(s)
	if err != nil {
		return 0
	}
	return v
}

func gzipCompress(data []byte) []byte {
	var buf bytes.Buffer
	w, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gzip init error: %v\n", err)
		os.Exit(1)
	}
	if _, err := w.Write(data); err != nil {
		fmt.Fprintf(os.Stderr, "gzip write error: %v\n", err)
		os.Exit(1)
	}
	if err := w.Close(); err != nil {
		fmt.Fprintf(os.Stderr, "gzip close error: %v\n", err)
		os.Exit(1)
	}
	return buf.Bytes()
}

func packTar(inputDir string) ([]byte, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)

	baseName := filepath.Base(inputDir)
	absDir, err := filepath.Abs(inputDir)
	if err != nil {
		return nil, err
	}

	// Collect all entries sorted
	type fileEntry struct {
		relPath string
		absPath string
	}
	var entries []fileEntry

	err = filepath.Walk(absDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if path == absDir {
			return nil
		}
		rel, _ := filepath.Rel(absDir, path)
		fullRel := filepath.Join(baseName, rel)
		// Convert to forward slashes for tar
		fullRel = filepath.ToSlash(fullRel)
		if info.IsDir() {
			return nil // directories are implicit in tar entries
		}
		if info.Mode().IsRegular() {
			entries = append(entries, fileEntry{relPath: fullRel, absPath: path})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	// Sort entries for deterministic output (matching Node's readdirSync().sort())
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].relPath < entries[j].relPath
	})

	now := time.Now()
	for _, entry := range entries {
		fileData, err := os.ReadFile(entry.absPath)
		if err != nil {
			return nil, err
		}
		hdr := &tar.Header{
			Name:    entry.relPath,
			Mode:    0100644,
			Uid:     1000,
			Gid:     1000,
			Size:    int64(len(fileData)),
			ModTime: now,
			Format:  tar.FormatUSTAR,
		}
		if err := tw.WriteHeader(hdr); err != nil {
			return nil, err
		}
		if _, err := tw.Write(fileData); err != nil {
			return nil, err
		}
	}

	if err := tw.Close(); err != nil {
		return nil, err
	}

	return buf.Bytes(), nil
}
