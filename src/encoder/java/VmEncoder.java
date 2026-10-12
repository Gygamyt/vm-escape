import java.io.*;
import java.nio.file.*;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.*;
import java.util.zip.*;

/**
 * vm-escape Visual Encoder — Java 17+ port.
 *
 * Encodes any file into an animated colored block grid on HTML canvas.
 * Zero external dependencies, single-file application.
 *
 * Modes:
 *   q4  — 4 levels per channel (0,85,170,255), 6 bits/cell, ~9.1 KB/frame.
 *   q2  — 2 levels per channel (0,255), 3 bits/cell, ~4.6 KB/frame.
 *   rgb — classic 3 bytes per cell (lossless screenshots only), ~36.4 KB/frame.
 *
 * Usage:
 *   java VmEncoder.java file.tar.gz
 *   java VmEncoder.java file.tar.gz --mode q2 --block 8 --output frames.html
 */
public class VmEncoder {

    // ── Constants ───────────────────────────────────────────
    private static final int Q4_MAGIC0_VAL = 55;
    private static final int Q4_MAGIC1_VAL = 28;
    private static final int Q2_MAGIC0_VAL = 5;
    private static final int Q2_MAGIC1_VAL = 6;

    // ── CRC-32 lookup table ────────────────────────────────
    private static final int[] CRC_TABLE = new int[256];
    static {
        for (int i = 0; i < 256; i++) {
            int c = i;
            for (int j = 0; j < 8; j++) {
                c = (c & 1) != 0 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
            }
            CRC_TABLE[i] = c;
        }
    }

    private static int crc32(byte[] buf, int off, int len) {
        int c = 0xFFFFFFFF;
        for (int i = off; i < off + len; i++) {
            c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xFF];
        }
        return c ^ 0xFFFFFFFF;
    }

    // ── CLI arg helpers ────────────────────────────────────
    private static String getArg(String[] args, String name, String def) {
        for (int i = 0; i < args.length - 1; i++) {
            if (args[i].equals("--" + name)) return args[i + 1];
        }
        return def;
    }

    private static boolean hasFlag(String[] args, String name) {
        for (String a : args) {
            if (a.equals("--" + name) || a.equals("-" + name)) return true;
        }
        return false;
    }

    // ── Tar packer (for directory input) ───────────────────
    private static byte[] tarHeader(String name, long size) {
        byte[] buf = new byte[512];
        byte[] nameBytes = name.getBytes();
        System.arraycopy(nameBytes, 0, buf, 0, Math.min(nameBytes.length, 100));
        System.arraycopy("0100644\0".getBytes(), 0, buf, 100, 8);
        System.arraycopy("0001750\0".getBytes(), 0, buf, 108, 8);
        System.arraycopy("0001750\0".getBytes(), 0, buf, 116, 8);
        byte[] sizeStr = String.format("%011o", size).getBytes();
        System.arraycopy(sizeStr, 0, buf, 124, 11);
        long mtime = System.currentTimeMillis() / 1000;
        byte[] mtimeStr = String.format("%011o", mtime).getBytes();
        System.arraycopy(mtimeStr, 0, buf, 136, 11);
        Arrays.fill(buf, 148, 156, (byte) 0x20); // checksum placeholder
        buf[156] = '0'; // typeflag: regular file
        System.arraycopy("ustar\0".getBytes(), 0, buf, 257, 6);
        System.arraycopy("00".getBytes(), 0, buf, 263, 2);
        // compute checksum
        int cksum = 0;
        for (int i = 0; i < 512; i++) cksum += (buf[i] & 0xFF);
        byte[] cs = String.format("%06o\0 ", cksum).getBytes();
        System.arraycopy(cs, 0, buf, 148, 8);
        return buf;
    }

    private static byte[] packTar(Path dir) throws IOException {
        var out = new ByteArrayOutputStream();
        String base = dir.getFileName().toString();
        Files.walkFileTree(dir, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                String rel = base + "/" + dir.relativize(file).toString().replace('\\', '/');
                byte[] data = Files.readAllBytes(file);
                out.write(tarHeader(rel, data.length));
                out.write(data);
                int pad = (512 - (int)(data.length % 512)) % 512;
                if (pad > 0) out.write(new byte[pad]);
                return FileVisitResult.CONTINUE;
            }
        });
        out.write(new byte[1024]); // end-of-archive
        return out.toByteArray();
    }

    // ── Gzip compression ───────────────────────────────────
    private static byte[] gzipCompress(byte[] data) throws IOException {
        var bos = new ByteArrayOutputStream();
        try (var gz = new GZIPOutputStream(bos) {{ def.setLevel(Deflater.BEST_COMPRESSION); }}) {
            gz.write(data);
        }
        return bos.toByteArray();
    }

    // ── Help text ──────────────────────────────────────────
    private static void showHelp() {
        System.out.println("""

          vm-escape encoder (Java) — encode any file into a visual pixel grid (HTML)

          USAGE
            java VmEncoder.java <file> [options]

          ARGUMENTS
            <file>              Input file or directory to encode.
                                If not already gzipped, it will be compressed automatically.
                                Directories are packed as tar before compression.

          OPTIONS
            --mode q4|q2|rgb    Encoding mode (default: q4)
                                  q4  — 4-level quantized, ~9.1 KB/frame. Survives lossy
                                        screen capture (getDisplayMedia, screenshots of video).
                                  q2  — 2-level quantized (black/white per channel),
                                        ~4.5 KB/frame. Ultra-robust for nested VMs or
                                        heavily compressed video. Half the bitrate of Q4.
                                  rgb — full 24-bit color, ~36.4 KB/frame. Use only with
                                        lossless PNG screenshots.
            --block N           Pixel block size in px (default: 8).
            --delay N           Frame display interval in ms (default: 300). Min 50ms.
            --output FILE       Output HTML file path (default: tmp/frames.html)
            --help, -h          Show this help message

          EXAMPLES
            java VmEncoder.java data.tar.gz
            java VmEncoder.java data.tar.gz --mode q2 --block 8 --output frames.html
            java VmEncoder.java mydir/ --mode q4
        """);
        System.exit(0);
    }

    // ── Main ───────────────────────────────────────────────
    public static void main(String[] args) throws Exception {
        if (args.length == 0 || hasFlag(args, "help") || hasFlag(args, "h")) {
            showHelp();
        }

        // Find input file (first arg that doesn't start with --)
        String inputFile = null;
        for (String a : args) {
            if (!a.startsWith("--") && !a.equals("-h")) { inputFile = a; break; }
        }
        if (inputFile == null) {
            System.err.println("Error: no input file specified.");
            System.err.println("Usage: java VmEncoder.java <file> [--mode q4|q2|rgb] [--output FILE]");
            System.exit(1);
        }

        String mode = getArg(args, "mode", "q4");
        int block = Integer.parseInt(getArg(args, "block", "8"));
        int delay = Math.max(50, Integer.parseInt(getArg(args, "delay", "300")));
        String output = getArg(args, "output", "tmp/frames.html");

        if (!mode.equals("q4") && !mode.equals("q2") && !mode.equals("rgb")) {
            System.err.println("Invalid mode \"" + mode + "\". Use q4, q2 or rgb.");
            System.exit(1);
        }

        // ── Grid geometry ──────────────────────────────────
        int border = block;
        int cols = (1200 - 2 * border) / block;
        int rows = (700 - 2 * border) / block;
        int dataCells = cols * (rows - 1); // first row = header

        int bytesPerFrame = switch (mode) {
            case "q4"  -> (dataCells / 4) * 3;
            case "q2"  -> (dataCells / 8) * 3;
            default    -> dataCells * 3; // rgb
        };

        int modeId = switch (mode) {
            case "q4"  -> 1;
            case "q2"  -> 2;
            default    -> 0;
        };

        int canvasW = cols * block + 2 * border;
        int canvasH = rows * block + 2 * border;

        // ── Read & compress input ──────────────────────────
        Path inputPath = Path.of(inputFile);
        if (!Files.exists(inputPath)) {
            System.err.println("Error: file not found: " + inputFile);
            System.exit(1);
        }

        byte[] data;
        if (Files.isDirectory(inputPath)) {
            System.out.println("Input is a directory, packing as tar...");
            data = packTar(inputPath.toAbsolutePath());
            System.out.printf("Input:  %s/ -> tar (%.2f MB)%n", inputFile, data.length / 1048576.0);
        } else {
            data = Files.readAllBytes(inputPath);
            System.out.printf("Input:  %s (%.2f MB)%n", inputFile, data.length / 1048576.0);
        }

        // Gzip if not already
        if (data.length < 2 || (data[0] & 0xFF) != 0x1F || (data[1] & 0xFF) != 0x8B) {
            System.out.println("Compressing with gzip -9…");
            data = gzipCompress(data);
            System.out.printf("Compressed: %.2f MB%n", data.length / 1048576.0);
        }

        int totalFrames = (int) Math.ceil((double) data.length / bytesPerFrame);
        String modeDesc = switch (mode) {
            case "q4"  -> "q4 (4-level quantized, lossy-safe)";
            case "q2"  -> "q2 (2-level quantized, ultra-robust)";
            default    -> "rgb (full RGB, lossless only)";
        };
        System.out.println("Mode:   " + modeDesc);
        System.out.printf("Grid:   %d×%d cells, block=%dpx, canvas=%d×%d%n", cols, rows, block, canvasW, canvasH);
        System.out.printf("Payload per frame: %.1f KB (%d data cells)%n", bytesPerFrame / 1024.0, dataCells);
        System.out.println("Frames: " + totalFrames);
        double estMinutes = totalFrames * delay / 1000.0 / 60.0;
        System.out.println("Delay:  " + delay + "ms/frame");
        System.out.printf("Est. capture time: ~%.1f min (%d frames × %dms)%n", estMinutes, totalFrames, delay);

        // ── Feasibility check ──────────────────────────────
        String b64 = Base64.getEncoder().encodeToString(data);
        double htmlSizeMB = b64.length() * 1.05 / 1048576.0;
        if (htmlSizeMB > 200) {
            System.err.printf("%n⚠  HTML will be ~%.0f MB — browser may not handle it.%n", htmlSizeMB);
            System.exit(1);
        }
        if (htmlSizeMB > 50) {
            System.err.printf("%n⚠  HTML will be ~%.0f MB — may load slowly.%n", htmlSizeMB);
        }

        // ── Badge colors ───────────────────────────────────
        String badgeBg = switch (mode) {
            case "q4"  -> "#530";
            case "q2"  -> "#350";
            default    -> "#035";
        };
        String badgeFg = switch (mode) {
            case "q4"  -> "#fa0";
            case "q2"  -> "#af0";
            default    -> "#0af";
        };

        // ── Generate HTML ──────────────────────────────────
        var sb = new StringBuilder(b64.length() + 8192);
        sb.append("""
                <!DOCTYPE html>
                <html lang="en">
                <head>
                <meta charset="utf-8">
                """);
        sb.append("<title>Visual Encoder v2 — ").append(mode.toUpperCase())
          .append(" — ").append(totalFrames).append(" frames</title>\n");
        sb.append("""
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
                """);
        sb.append("#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;\n");
        sb.append("  background:").append(badgeBg).append(";color:").append(badgeFg).append("}\n");
        sb.append("""
                </style>
                </head>
                <body>

                <div id="info">Loading…</div>
                """);
        sb.append("<div><span id=\"mode-badge\">").append(mode.toUpperCase()).append(" mode</span></div>\n");
        sb.append("<canvas id=\"c\" width=\"").append(canvasW).append("\" height=\"").append(canvasH).append("\"></canvas>\n");
        sb.append("""
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
                """);

        // Embedded payload
        sb.append("const B64=\"").append(b64).append("\";\n");

        // Constants
        sb.append("const BLK=").append(block).append(",COLS=").append(cols)
          .append(",ROWS=").append(rows).append(",BDR=").append(border).append(";\n");
        sb.append("const BPF=").append(bytesPerFrame).append(";\n");
        sb.append("const MODE=").append(modeId).append(";\n");

        // The rest of the JS is identical to Node encoder output
        sb.append("""
                function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}
                const data=b2u(B64);
                const TF=Math.ceil(data.length/BPF);

                let cur=0,playing=false,looping=true,timer=null,speed=%DELAY%;
                const cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');

                const offCv=document.createElement('canvas');
                offCv.width=cv.width;offCv.height=cv.height;
                const off=offCv.getContext('2d');

                function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}

                function cell(c,r,R,G,B){off.fillStyle='rgb('+R+','+G+','+B+')';off.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}

                function q4cell(c,r,val){
                  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);
                }

                function q2cell(c,r,val){
                  cell(c,r,((val>>2)&1)*255,((val>>1)&1)*255,(val&1)*255);
                }

                function draw(idx){
                  off.fillStyle='#000';off.fillRect(0,0,offCv.width,offCv.height);

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

                  const s=idx*BPF, e=Math.min(s+BPF,data.length);
                  const fd=data.slice(s,e), dl=fd.length;
                  const chk=crc32(fd);

                  if(MODE===1){
                    q4cell(0,0,%Q4M0%);q4cell(1,0,%Q4M1%);
                    q4cell(2,0,(idx>>12)&0x3F);q4cell(3,0,(idx>>6)&0x3F);q4cell(4,0,idx&0x3F);
                    q4cell(5,0,(TF>>12)&0x3F);q4cell(6,0,(TF>>6)&0x3F);q4cell(7,0,TF&0x3F);
                    q4cell(8,0,(dl>>12)&0x3F);q4cell(9,0,(dl>>6)&0x3F);q4cell(10,0,dl&0x3F);
                    q4cell(11,0,(chk>>>26)&0x3F);q4cell(12,0,(chk>>>20)&0x3F);q4cell(13,0,(chk>>>14)&0x3F);
                    q4cell(14,0,(chk>>>8)&0x3F);q4cell(15,0,(chk>>>2)&0x3F);q4cell(16,0,(chk&0x3)<<4);
                    q4cell(17,0,(COLS>>6)&0x3F);q4cell(18,0,COLS&0x3F);
                    q4cell(19,0,(ROWS>>6)&0x3F);q4cell(20,0,ROWS&0x3F);
                    q4cell(21,0,BLK&0x3F);
                    q4cell(22,0,1);
                    for(let c=23;c<COLS;c++) q4cell(c,0,0);

                    let bi=0,ci=0;const totalCells=COLS*(ROWS-1);
                    while(ci<totalCells){
                      const b0=bi<dl?fd[bi++]:0;const b1=bi<dl?fd[bi++]:0;const b2=bi<dl?fd[bi++]:0;
                      const v0=b0>>2;const v1=((b0&3)<<4)|(b1>>4);const v2=((b1&0xF)<<2)|(b2>>6);const v3=b2&0x3F;
                      const vals=[v0,v1,v2,v3];
                      for(let k=0;k<4&&ci<totalCells;k++,ci++){
                        const r=Math.floor(ci/COLS)+1;const c=ci%COLS;q4cell(c,r,vals[k]);
                      }
                    }
                  } else if(MODE===2){
                    function q2h(col,val){ q2cell(col,0,val); }
                    q2h(0,%Q2M0%);q2h(1,%Q2M1%);
                    q2h(2,(idx>>15)&7);q2h(3,(idx>>12)&7);q2h(4,(idx>>9)&7);
                    q2h(5,(idx>>6)&7);q2h(6,(idx>>3)&7);q2h(7,idx&7);
                    q2h(8,(TF>>15)&7);q2h(9,(TF>>12)&7);q2h(10,(TF>>9)&7);
                    q2h(11,(TF>>6)&7);q2h(12,(TF>>3)&7);q2h(13,TF&7);
                    q2h(14,(dl>>15)&7);q2h(15,(dl>>12)&7);q2h(16,(dl>>9)&7);
                    q2h(17,(dl>>6)&7);q2h(18,(dl>>3)&7);q2h(19,dl&7);
                    q2h(20,(chk>>>30)&7);q2h(21,(chk>>>27)&7);q2h(22,(chk>>>24)&7);
                    q2h(23,(chk>>>21)&7);q2h(24,(chk>>>18)&7);q2h(25,(chk>>>15)&7);
                    q2h(26,(chk>>>12)&7);q2h(27,(chk>>>9)&7);q2h(28,(chk>>>6)&7);
                    q2h(29,(chk>>>3)&7);q2h(30,chk&7);
                    q2h(31,(COLS>>9)&7);q2h(32,(COLS>>6)&7);q2h(33,(COLS>>3)&7);q2h(34,COLS&7);
                    q2h(35,(ROWS>>9)&7);q2h(36,(ROWS>>6)&7);q2h(37,(ROWS>>3)&7);q2h(38,ROWS&7);
                    q2h(39,(BLK>>3)&7);q2h(40,BLK&7);
                    q2h(41,2);
                    for(let c=42;c<COLS;c++) q2h(c,0);

                    let bi=0,ci=0;const totalCells=COLS*(ROWS-1);
                    while(ci<totalCells){
                      const b0=bi<dl?fd[bi++]:0;const b1=bi<dl?fd[bi++]:0;const b2=bi<dl?fd[bi++]:0;
                      const v0=(b0>>5)&7;const v1=(b0>>2)&7;const v2=((b0&3)<<1)|(b1>>7);
                      const v3=(b1>>4)&7;const v4=(b1>>1)&7;const v5=((b1&1)<<2)|(b2>>6);
                      const v6=(b2>>3)&7;const v7=b2&7;
                      const vals=[v0,v1,v2,v3,v4,v5,v6,v7];
                      for(let k=0;k<8&&ci<totalCells;k++,ci++){
                        const r=Math.floor(ci/COLS)+1;const c=ci%COLS;q2cell(c,r,vals[k]);
                      }
                    }
                  } else {
                    cell(0,0,0xDE,0xAD,0x01);cell(1,0,0xBE,0xEF,0x02);
                    cell(2,0,(idx>>16)&0xFF,(idx>>8)&0xFF,idx&0xFF);
                    cell(3,0,(TF>>16)&0xFF,(TF>>8)&0xFF,TF&0xFF);
                    cell(4,0,(dl>>16)&0xFF,(dl>>8)&0xFF,dl&0xFF);
                    cell(5,0,(chk>>24)&0xFF,(chk>>16)&0xFF,(chk>>8)&0xFF);
                    cell(6,0,chk&0xFF,COLS&0xFF,ROWS&0xFF);
                    cell(7,0,BLK,0,0);
                    for(let c=8;c<COLS;c++) cell(c,0,0x80,0x80,0x80);

                    let bi=0;
                    for(let r=1;r<ROWS;r++){
                      for(let c=0;c<COLS;c++){
                        const R=bi<dl?fd[bi++]:0,G=bi<dl?fd[bi++]:0,B=bi<dl?fd[bi++]:0;
                        cell(c,r,R,G,B);
                      }
                    }
                  }

                  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE===2?'Q2':MODE===1?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';
                  cx.drawImage(offCv,0,0);
                }

                let rafId=null,lastFrameTime=0;

                function advance(){
                  if(cur>=TF-1){if(looping){cur=0}else{togglePlay();return}}else{cur++}
                  draw(cur);
                }
                function next(){advance()}
                function prev(){cur=Math.max(cur-1,0);draw(cur)}

                function playLoop(ts){
                  if(!playing)return;
                  if(ts-lastFrameTime>=speed){advance();lastFrameTime=ts;}
                  rafId=requestAnimationFrame(playLoop);
                }

                function togglePlay(){
                  playing=!playing;
                  document.getElementById('bp').textContent=playing?'⏸ Pause':'▶ Play';
                  if(playing){lastFrameTime=performance.now();rafId=requestAnimationFrame(playLoop);}
                  else{if(rafId){cancelAnimationFrame(rafId);rafId=null}}
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
                }

                document.addEventListener('keydown',e=>{
                  if(e.key==='ArrowRight')next();
                  else if(e.key==='ArrowLeft')prev();
                  else if(e.key===' '){e.preventDefault();togglePlay()}
                  else if(e.key==='Home'){cur=0;draw(0)}
                  else if(e.key==='End'){cur=TF-1;draw(cur)}
                  else if(e.key==='l'||e.key==='L')toggleLoop();
                });

                document.getElementById('bl').classList.add('loop-on');
                const initBtn=document.getElementById('s'+speed);
                if(initBtn)initBtn.classList.add('active');
                draw(0);
                """.replace("%DELAY%", String.valueOf(delay))
                   .replace("%Q4M0%", String.valueOf(Q4_MAGIC0_VAL))
                   .replace("%Q4M1%", String.valueOf(Q4_MAGIC1_VAL))
                   .replace("%Q2M0%", String.valueOf(Q2_MAGIC0_VAL))
                   .replace("%Q2M1%", String.valueOf(Q2_MAGIC1_VAL)));

        sb.append("</script>\n</body>\n</html>");

        String html = sb.toString();

        // ── Write output ───────────────────────────────────
        Path outPath = Path.of(output);
        Path outDir = outPath.getParent();
        if (outDir != null) Files.createDirectories(outDir);
        Files.writeString(outPath, html);

        long outSize = Files.size(outPath);
        System.out.printf("%n✅ %s  (%.2f MB)%n%n", output, outSize / 1048576.0);
        System.out.println("Next steps:");
        System.out.println("  1. Open " + output + " in the browser inside the VM");
        System.out.println("  2. Press Play + Loop (or Space + L)");
        System.out.println("  3. On the host, open host-decoder.html");
        System.out.println("  4. Click \"Start Capture\" and select the VM window");
        System.out.println("  5. Wait for 100% and download the file");
    }
}
