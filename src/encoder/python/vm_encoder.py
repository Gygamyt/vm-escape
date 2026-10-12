#!/usr/bin/env python3
"""Visual encoder for vm-escape: reads any file (or directory as tar),
gzip-compresses, base64-encodes, and generates a self-contained HTML file
with an embedded JS player that renders data as colored pixel blocks."""

import argparse
import base64
import gzip
import math
import os
import sys
import tarfile
import tempfile


def compute_layout(block):
    """Compute canvas layout constants."""
    cols = (1200 - 2 * block) // block
    rows = (700 - 2 * block) // block
    border = block
    canvas_w = cols * block + 2 * border
    canvas_h = rows * block + 2 * border
    data_cells = cols * (rows - 1)
    return cols, rows, border, canvas_w, canvas_h, data_cells


def bytes_per_frame(mode, data_cells):
    """Compute bytes per frame for the given mode."""
    if mode == 'q4':
        return (data_cells // 4) * 3
    elif mode == 'q2':
        return (data_cells // 8) * 3
    else:  # rgb
        return data_cells * 3


def mode_id(mode):
    """Return numeric mode ID."""
    return {'rgb': 0, 'q4': 1, 'q2': 2}[mode]


def is_gzipped(data):
    """Check if data is already gzip-compressed."""
    return len(data) >= 2 and data[0] == 0x1f and data[1] == 0x8b


def prepare_payload(path):
    """Read input file or pack directory as tar, then gzip-compress."""
    if os.path.isdir(path):
        tmp = tempfile.NamedTemporaryFile(suffix='.tar', delete=False)
        tmp.close()
        try:
            with tarfile.open(tmp.name, 'w') as tf:
                tf.add(path, arcname=os.path.basename(path))
            with open(tmp.name, 'rb') as f:
                raw = f.read()
        finally:
            os.unlink(tmp.name)
        print("[dir]  Packed directory as tar: %d bytes" % len(raw))
    else:
        with open(path, 'rb') as f:
            raw = f.read()
        print("[file] Read %d bytes from %s" % (len(raw), path))

    if is_gzipped(raw):
        print("[gzip] Already gzip-compressed, keeping as-is")
        compressed = raw
    else:
        compressed = gzip.compress(raw, compresslevel=9)
        ratio = len(compressed) / len(raw) * 100 if raw else 0
        print("[gzip] Compressed: %d -> %d bytes (%.1f%%)" % (len(raw), len(compressed), ratio))

    return compressed


def build_html(b64, mode, block, delay):
    """Build the complete HTML string."""
    cols, rows, border, canvas_w, canvas_h, data_cells = compute_layout(block)
    bpf = bytes_per_frame(mode, data_cells)
    mid = mode_id(mode)
    mode_upper = mode.upper()

    raw_len = len(base64.b64decode(b64))
    total_frames = max(1, math.ceil(raw_len / bpf))

    badge = {
        'q4':  ('#530', '#fa0'),
        'q2':  ('#350', '#af0'),
        'rgb': ('#035', '#0af'),
    }
    badge_bg, badge_fg = badge[mode]

    # Single template matching the Node.js reference character-for-character.
    # Dynamic values use __MARKER__ placeholders to avoid conflicts with
    # JS curly braces, CSS %, etc.
    tpl = (
        '<!DOCTYPE html>\n'
        '<html lang="en">\n'
        '<head>\n'
        '<meta charset="utf-8">\n'
        '<title>Visual Encoder v2 — __MODE_UPPER__ — __TOTAL_FRAMES__ frames</title>\n'
        '<style>\n'
        '*{margin:0;padding:0;box-sizing:border-box}\n'
        'body{background:#0a0a0a;color:#ccc;font:13px/1.4 monospace;display:flex;flex-direction:column;align-items:center;padding:8px}\n'
        '#info{margin:6px 0;font-size:14px;letter-spacing:.5px}\n'
        'canvas{image-rendering:pixelated;image-rendering:crisp-edges}\n'
        '#ctrl{margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}\n'
        'button{padding:4px 14px;font:13px monospace;cursor:pointer;background:#222;color:#eee;border:1px solid #444;border-radius:3px}\n'
        'button:hover{background:#333}\n'
        'button.active{background:#060;border-color:#0a0}\n'
        'button.loop-on{background:#006;border-color:#00a}\n'
        'kbd{background:#222;padding:1px 5px;border-radius:2px;border:1px solid #444;font-size:12px}\n'
        '#hint{font-size:11px;color:#666;margin-top:4px}\n'
        '#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;\n'
        '  background:__BADGE_BG__;color:__BADGE_FG__}\n'
        '</style>\n'
        '</head>\n'
        '<body>\n'
        '\n'
        '<div id="info">Loading…</div>\n'
        '<div><span id="mode-badge">__MODE_UPPER__ mode</span></div>\n'
        '<canvas id="c" width="__CANVAS_W__" height="__CANVAS_H__"></canvas>\n'
        '<div id="ctrl">\n'
        '  <button onclick="prev()">◀</button>\n'
        '  <button onclick="togglePlay()" id="bp">▶ Play</button>\n'
        '  <button onclick="next()">▶</button>\n'
        '  <button onclick="toggleLoop()" id="bl">\U0001f501 Loop</button>\n'
        '  <span style="margin-left:12px">ms/frame:</span>\n'
        '  <button onclick="spd(50)">50</button>\n'
        '  <button onclick="spd(100)">100</button>\n'
        '  <button onclick="spd(200)">200</button>\n'
        '  <button onclick="spd(300)" id="s300">300</button>\n'
        '  <button onclick="spd(500)" id="s500">500</button>\n'
        '  <button onclick="spd(1000)">1000</button>\n'
        '</div>\n'
        '<div id="hint"><kbd>←</kbd> prev  <kbd>→</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>\n'
        '\n'
        '<script>\n'
        '// ── Embedded payload (base64) ──\n'
        'const B64="__B64__";\n'
        '\n'
        '// ── Constants ──\n'
        'const BLK=__BLK__,COLS=__COLS__,ROWS=__ROWS__,BDR=__BDR__;\n'
        'const BPF=__BPF__;\n'
        'const MODE=__MID__; // 0=RGB, 1=Q4, 2=Q2\n'
        '\n'
        '// ── Decode base64 → Uint8Array ──\n'
        'function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}\n'
        'const data=b2u(B64);\n'
        'const TF=Math.ceil(data.length/BPF);\n'
        '\n'
        'let cur=0,playing=false,looping=true,timer=null,speed=__DELAY__;\n'
        "const cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');\n"
        '\n'
        '// ── Offscreen double buffer (avoids tearing during frame transitions) ──\n'
        "const offCv=document.createElement('canvas');\n"
        'offCv.width=cv.width;offCv.height=cv.height;\n'
        "const off=offCv.getContext('2d');\n"
        '\n'
        '// ── CRC-32 ──\n'
        'function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}\n'
        '\n'
        '// ── Draw helpers ──\n'
        "function cell(c,r,R,G,B){off.fillStyle='rgb('+R+','+G+','+B+')';off.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}\n"
        '\n'
        '// Q4: encode 6-bit value as RGB (2 bits per channel, levels 0,85,170,255)\n'
        'function q4cell(c,r,val){\n'
        '  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);\n'
        '}\n'
        '\n'
        '// Q2: encode 3-bit value as RGB (1 bit per channel, levels 0,255)\n'
        'function q2cell(c,r,val){\n'
        '  cell(c,r,((val>>2)&1)*255,((val>>1)&1)*255,(val&1)*255);\n'
        '}\n'
        '\n'
        '// ── Draw one frame ──\n'
        'function draw(idx){\n'
        "  off.fillStyle='#000';off.fillRect(0,0,offCv.width,offCv.height);\n"
        '\n'
        '  // Sync border (alternating black / magenta cells)\n'
        '  for(let i=0;i<COLS+2;i++){\n'
        "    off.fillStyle=i%2?'#f0f':'#000';\n"
        '    off.fillRect(i*BLK,0,BLK,BDR);\n'
        '    off.fillRect(i*BLK,BDR+ROWS*BLK,BLK,BDR);\n'
        '  }\n'
        '  for(let j=0;j<ROWS;j++){\n'
        "    off.fillStyle=j%2?'#f0f':'#000';\n"
        '    off.fillRect(0,BDR+j*BLK,BDR,BLK);\n'
        '    off.fillRect(BDR+COLS*BLK,BDR+j*BLK,BDR,BLK);\n'
        '  }\n'
        '\n'
        '  // Frame payload slice\n'
        '  const s=idx*BPF, e=Math.min(s+BPF,data.length);\n'
        '  const fd=data.slice(s,e), dl=fd.length;\n'
        '  const chk=crc32(fd);\n'
        '\n'
        '  if(MODE===1){\n'
        '    // ═══ Q4 HEADER ═══\n'
        '    // Magic\n'
        '    q4cell(0,0,55); // (255,85,255)\n'
        '    q4cell(1,0,28); // (85,255,0)\n'
        '    // Frame index (18 bits → 3 cells)\n'
        '    q4cell(2,0,(idx>>12)&0x3F);\n'
        '    q4cell(3,0,(idx>>6)&0x3F);\n'
        '    q4cell(4,0,idx&0x3F);\n'
        '    // Total frames (18 bits → 3 cells)\n'
        '    q4cell(5,0,(TF>>12)&0x3F);\n'
        '    q4cell(6,0,(TF>>6)&0x3F);\n'
        '    q4cell(7,0,TF&0x3F);\n'
        '    // Data length this frame (18 bits → 3 cells)\n'
        '    q4cell(8,0,(dl>>12)&0x3F);\n'
        '    q4cell(9,0,(dl>>6)&0x3F);\n'
        '    q4cell(10,0,dl&0x3F);\n'
        '    // CRC32 (32 bits → 6 cells, MSB first)\n'
        '    q4cell(11,0,(chk>>>26)&0x3F);\n'
        '    q4cell(12,0,(chk>>>20)&0x3F);\n'
        '    q4cell(13,0,(chk>>>14)&0x3F);\n'
        '    q4cell(14,0,(chk>>>8)&0x3F);\n'
        '    q4cell(15,0,(chk>>>2)&0x3F);\n'
        '    q4cell(16,0,(chk&0x3)<<4);\n'
        '    // Grid dims: COLS (2 cells), ROWS (2 cells), block size (1 cell)\n'
        '    q4cell(17,0,(COLS>>6)&0x3F);\n'
        '    q4cell(18,0,COLS&0x3F);\n'
        '    q4cell(19,0,(ROWS>>6)&0x3F);\n'
        '    q4cell(20,0,ROWS&0x3F);\n'
        '    q4cell(21,0,BLK&0x3F);\n'
        '    // Mode marker\n'
        '    q4cell(22,0,1);\n'
        '    // Padding\n'
        '    for(let c=23;c<COLS;c++) q4cell(c,0,0);\n'
        '\n'
        '    // ═══ Q4 DATA ═══\n'
        '    // 4 cells → 3 bytes (24 bits → 4×6 bits)\n'
        '    let bi=0, ci=0;\n'
        '    const totalCells=COLS*(ROWS-1);\n'
        '    while(ci<totalCells){\n'
        '      const b0=bi<dl?fd[bi++]:0;\n'
        '      const b1=bi<dl?fd[bi++]:0;\n'
        '      const b2=bi<dl?fd[bi++]:0;\n'
        '      const v0=b0>>2;\n'
        '      const v1=((b0&3)<<4)|(b1>>4);\n'
        '      const v2=((b1&0xF)<<2)|(b2>>6);\n'
        '      const v3=b2&0x3F;\n'
        '      const vals=[v0,v1,v2,v3];\n'
        '      for(let k=0;k<4&&ci<totalCells;k++,ci++){\n'
        '        const r=Math.floor(ci/COLS)+1;\n'
        '        const c=ci%COLS;\n'
        '        q4cell(c,r,vals[k]);\n'
        '      }\n'
        '    }\n'
        '  } else if(MODE===2){\n'
        '    // ═══ Q2 HEADER ═══\n'
        '    // Q2: 3 bits/cell (1 bit per channel), values 0-7\n'
        '    function q2h(col,val){ q2cell(col,0,val); }\n'
        '\n'
        '    // Magic\n'
        '    q2h(0,5); // (255,0,255) magenta\n'
        '    q2h(1,6); // (255,255,0) yellow\n'
        '    // Frame index (18 bits → 6 cells × 3 bits)\n'
        '    q2h(2,(idx>>15)&7); q2h(3,(idx>>12)&7); q2h(4,(idx>>9)&7);\n'
        '    q2h(5,(idx>>6)&7);  q2h(6,(idx>>3)&7);  q2h(7,idx&7);\n'
        '    // Total frames (18 bits → 6 cells)\n'
        '    q2h(8,(TF>>15)&7);  q2h(9,(TF>>12)&7);  q2h(10,(TF>>9)&7);\n'
        '    q2h(11,(TF>>6)&7);  q2h(12,(TF>>3)&7);  q2h(13,TF&7);\n'
        '    // Data length (18 bits → 6 cells)\n'
        '    q2h(14,(dl>>15)&7); q2h(15,(dl>>12)&7); q2h(16,(dl>>9)&7);\n'
        '    q2h(17,(dl>>6)&7);  q2h(18,(dl>>3)&7);  q2h(19,dl&7);\n'
        '    // CRC32 (32 bits → 11 cells, 33 bits available, MSB first)\n'
        '    q2h(20,(chk>>>30)&7); q2h(21,(chk>>>27)&7); q2h(22,(chk>>>24)&7);\n'
        '    q2h(23,(chk>>>21)&7); q2h(24,(chk>>>18)&7); q2h(25,(chk>>>15)&7);\n'
        '    q2h(26,(chk>>>12)&7); q2h(27,(chk>>>9)&7);  q2h(28,(chk>>>6)&7);\n'
        '    q2h(29,(chk>>>3)&7);  q2h(30,chk&7);\n'
        '    // Grid dims: COLS (4 cells=12 bits), ROWS (4 cells), block (2 cells), mode (1 cell)\n'
        '    q2h(31,(COLS>>9)&7); q2h(32,(COLS>>6)&7); q2h(33,(COLS>>3)&7); q2h(34,COLS&7);\n'
        '    q2h(35,(ROWS>>9)&7); q2h(36,(ROWS>>6)&7); q2h(37,(ROWS>>3)&7); q2h(38,ROWS&7);\n'
        '    q2h(39,(BLK>>3)&7);  q2h(40,BLK&7);\n'
        '    q2h(41,2); // mode marker = 2\n'
        '    // Padding\n'
        '    for(let c=42;c<COLS;c++) q2h(c,0);\n'
        '\n'
        '    // ═══ Q2 DATA ═══\n'
        '    // 8 cells × 3 bits = 24 bits = 3 bytes\n'
        '    let bi=0, ci=0;\n'
        '    const totalCells=COLS*(ROWS-1);\n'
        '    while(ci<totalCells){\n'
        '      const b0=bi<dl?fd[bi++]:0;\n'
        '      const b1=bi<dl?fd[bi++]:0;\n'
        '      const b2=bi<dl?fd[bi++]:0;\n'
        '      // 24 bits → 8 × 3-bit values\n'
        '      const v0=(b0>>5)&7;\n'
        '      const v1=(b0>>2)&7;\n'
        '      const v2=((b0&3)<<1)|(b1>>7);\n'
        '      const v3=(b1>>4)&7;\n'
        '      const v4=(b1>>1)&7;\n'
        '      const v5=((b1&1)<<2)|(b2>>6);\n'
        '      const v6=(b2>>3)&7;\n'
        '      const v7=b2&7;\n'
        '      const vals=[v0,v1,v2,v3,v4,v5,v6,v7];\n'
        '      for(let k=0;k<8&&ci<totalCells;k++,ci++){\n'
        '        const r=Math.floor(ci/COLS)+1;\n'
        '        const c=ci%COLS;\n'
        '        q2cell(c,r,vals[k]);\n'
        '      }\n'
        '    }\n'
        '  } else {\n'
        '    // ═══ RGB HEADER (same as v1) ═══\n'
        '    cell(0,0,0xDE,0xAD,0x01);\n'
        '    cell(1,0,0xBE,0xEF,0x02);\n'
        '    cell(2,0,(idx>>16)&0xFF,(idx>>8)&0xFF,idx&0xFF);\n'
        '    cell(3,0,(TF>>16)&0xFF,(TF>>8)&0xFF,TF&0xFF);\n'
        '    cell(4,0,(dl>>16)&0xFF,(dl>>8)&0xFF,dl&0xFF);\n'
        '    cell(5,0,(chk>>24)&0xFF,(chk>>16)&0xFF,(chk>>8)&0xFF);\n'
        '    cell(6,0,chk&0xFF,COLS&0xFF,ROWS&0xFF);\n'
        '    cell(7,0,BLK,0,0);\n'
        '    for(let c=8;c<COLS;c++) cell(c,0,0x80,0x80,0x80);\n'
        '\n'
        '    // ═══ RGB DATA ═══\n'
        '    let bi=0;\n'
        '    for(let r=1;r<ROWS;r++){\n'
        '      for(let c=0;c<COLS;c++){\n'
        '        const R=bi<dl?fd[bi++]:0,G=bi<dl?fd[bi++]:0,B=bi<dl?fd[bi++]:0;\n'
        '        cell(c,r,R,G,B);\n'
        '      }\n'
        '    }\n'
        '  }\n'
        '\n'
        "  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE===2?'Q2':MODE===1?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';\n"
        '\n'
        '  // Atomic blit: copy completed frame to visible canvas in one operation\n'
        '  cx.drawImage(offCv,0,0);\n'
        '}\n'
        '\n'
        '// ── Controls (rAF-synced playback) ──\n'
        '// rAF-synced: each frame survives at least one vsync before next swap.\n'
        'let rafId=null, lastFrameTime=0;\n'
        '\n'
        'function advance(){\n'
        '  if(cur>=TF-1){\n'
        '    if(looping){cur=0} else {togglePlay();return}\n'
        '  } else {cur++}\n'
        '  draw(cur);\n'
        '}\n'
        '\n'
        'function next(){advance()}\n'
        'function prev(){cur=Math.max(cur-1,0);draw(cur)}\n'
        '\n'
        'function playLoop(ts){\n'
        '  if(!playing) return;\n'
        '  if(ts-lastFrameTime>=speed){\n'
        '    advance();\n'
        '    lastFrameTime=ts;\n'
        '  }\n'
        '  rafId=requestAnimationFrame(playLoop);\n'
        '}\n'
        '\n'
        'function togglePlay(){\n'
        '  playing=!playing;\n'
        "  document.getElementById('bp').textContent=playing?'⏸ Pause':'▶ Play';\n"
        '  if(playing){\n'
        '    lastFrameTime=performance.now();\n'
        '    rafId=requestAnimationFrame(playLoop);\n'
        '  } else {\n'
        '    if(rafId){cancelAnimationFrame(rafId);rafId=null}\n'
        '  }\n'
        '}\n'
        '\n'
        'function toggleLoop(){\n'
        '  looping=!looping;\n'
        "  const bl=document.getElementById('bl');\n"
        "  bl.classList.toggle('loop-on',looping);\n"
        "  bl.textContent=looping?'\U0001f501 Loop ON':'\U0001f501 Loop OFF';\n"
        '}\n'
        '\n'
        'function spd(ms){\n'
        '  speed=ms;\n'
        "  document.querySelectorAll('#ctrl button.active').forEach(b=>{if(b.id!=='bl')b.classList.remove('active')});\n"
        "  event.target.classList.add('active');\n"
        '  // playLoop reads speed live, no restart needed\n'
        '}\n'
        '\n'
        '\n'
        "document.addEventListener('keydown',e=>{\n"
        "  if(e.key==='ArrowRight')next();\n"
        "  else if(e.key==='ArrowLeft')prev();\n"
        "  else if(e.key===' '){e.preventDefault();togglePlay()}\n"
        "  else if(e.key==='Home'){cur=0;draw(0)}\n"
        "  else if(e.key==='End'){cur=TF-1;draw(cur)}\n"
        "  else if(e.key==='l'||e.key==='L')toggleLoop();\n"
        '});\n'
        '\n'
        '// Auto-start loop indicator\n'
        "document.getElementById('bl').classList.add('loop-on');\n"
        '\n'
        '// Mark initial speed button as active\n'
        "const initBtn = document.getElementById('s' + speed);\n"
        "if (initBtn) initBtn.classList.add('active');\n"
        '\n'
        'draw(0);\n'
        '</script>\n'
        '</body>\n'
        '</html>'
    )

    html = (tpl
            .replace('__MODE_UPPER__', mode_upper)
            .replace('__TOTAL_FRAMES__', str(total_frames))
            .replace('__BADGE_BG__', badge_bg)
            .replace('__BADGE_FG__', badge_fg)
            .replace('__CANVAS_W__', str(canvas_w))
            .replace('__CANVAS_H__', str(canvas_h))
            .replace('__B64__', b64)
            .replace('__BLK__', str(block))
            .replace('__COLS__', str(cols))
            .replace('__ROWS__', str(rows))
            .replace('__BDR__', str(border))
            .replace('__BPF__', str(bpf))
            .replace('__MID__', str(mid))
            .replace('__DELAY__', str(delay)))

    return html, total_frames


def main():
    parser = argparse.ArgumentParser(
        description='Visual Encoder v2 — encode files as colored pixel frames in HTML'
    )
    parser.add_argument('file', help='Input file or directory to encode')
    parser.add_argument('--mode', choices=['q4', 'q2', 'rgb'], default='q4',
                        help='Encoding mode (default: q4)')
    parser.add_argument('--block', type=int, default=8,
                        help='Pixel block size (default: 8)')
    parser.add_argument('--delay', type=int, default=300,
                        help='Frame delay in ms (default: 300)')
    parser.add_argument('--output', default='tmp/frames.html',
                        help='Output HTML file (default: tmp/frames.html)')
    args = parser.parse_args()

    if not os.path.exists(args.file):
        print("Error: '%s' not found" % args.file, file=sys.stderr)
        sys.exit(1)

    # Compute layout info for display
    cols, rows, border, canvas_w, canvas_h, data_cells = compute_layout(args.block)
    bpf = bytes_per_frame(args.mode, data_cells)

    print("=== Visual Encoder v2 (Python) ===")
    print("Mode: %s | Block: %d | Delay: %dms" % (args.mode.upper(), args.block, args.delay))
    print("Grid: %d x %d | Data cells: %d | Bytes/frame: %d" % (cols, rows, data_cells, bpf))
    print("Canvas: %d x %d | Border: %d" % (canvas_w, canvas_h, border))
    print()

    # Prepare payload
    compressed = prepare_payload(args.file)

    # Base64 encode
    b64 = base64.b64encode(compressed).decode('ascii')
    print("[b64]  Encoded: %d chars" % len(b64))

    # Build HTML
    html, total_frames = build_html(b64, args.mode, args.block, args.delay)

    html_size = len(html.encode('utf-8'))
    html_mb = html_size / (1024 * 1024)

    if html_mb > 200:
        print("Error: HTML output would be %.1f MB (>200 MB limit)" % html_mb, file=sys.stderr)
        sys.exit(1)
    if html_mb > 50:
        print("[WARN] HTML output is %.1f MB — large file!" % html_mb)

    # Ensure output directory exists
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir)

    with open(args.output, 'w', encoding='utf-8') as f:
        f.write(html)

    print()
    print("Frames: %d | HTML size: %.2f MB" % (total_frames, html_mb))
    print("Written: %s" % args.output)


if __name__ == '__main__':
    main()
