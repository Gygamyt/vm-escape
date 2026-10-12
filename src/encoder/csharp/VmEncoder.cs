using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Text;

class VmEncoder
{
    static string mode = "q4";
    static int block = 8;
    static int delay = 300;
    static string output = "tmp/frames.html";
    static string inputPath = null;

    static int Main(string[] args)
    {
        if (!ParseArgs(args))
            return 1;

        if (inputPath == null)
        {
            PrintHelp();
            return 1;
        }

        byte[] rawData;
        string inputLabel;

        if (Directory.Exists(inputPath))
        {
            inputLabel = inputPath;
            Console.WriteLine("Input:  " + inputPath + " (directory → tar)");
            rawData = PackTar(inputPath);
        }
        else if (File.Exists(inputPath))
        {
            inputLabel = inputPath;
            rawData = File.ReadAllBytes(inputPath);
            Console.WriteLine("Input:  " + inputPath + " (" + FormatSize(rawData.Length) + ")");
        }
        else
        {
            Console.Error.WriteLine("Error: '" + inputPath + "' not found.");
            return 1;
        }

        if (rawData.Length > 200 * 1024 * 1024)
        {
            Console.Error.WriteLine("Error: Input exceeds 200 MB (" + FormatSize(rawData.Length) + "). Aborting.");
            return 1;
        }
        if (rawData.Length > 50 * 1024 * 1024)
        {
            Console.Error.WriteLine("Warning: Input is " + FormatSize(rawData.Length) + " (>50 MB). Output will be very large.");
        }

        // Gzip compress if not already gzipped
        byte[] compressed;
        if (rawData.Length >= 2 && rawData[0] == 0x1f && rawData[1] == 0x8b)
        {
            Console.WriteLine("Compressing: already gzip, skipping");
            compressed = rawData;
        }
        else
        {
            Console.WriteLine("Compressing...");
            compressed = GzipCompress(rawData);
        }
        Console.WriteLine("Compressed: " + FormatSize(compressed.Length));

        string b64 = Convert.ToBase64String(compressed);

        int cols = (1200 - 2 * block) / block;
        int rows = (700 - 2 * block) / block;
        int border = block;
        int dataCells = cols * (rows - 1);

        int bytesPerFrame;
        int modeId;
        string modeLabel;
        switch (mode)
        {
            case "q2":
                bytesPerFrame = (dataCells / 8) * 3;
                modeId = 2;
                modeLabel = "Q2";
                break;
            case "rgb":
                bytesPerFrame = dataCells * 3;
                modeId = 0;
                modeLabel = "RGB";
                break;
            default: // q4
                bytesPerFrame = (dataCells / 4) * 3;
                modeId = 1;
                modeLabel = "Q4";
                break;
        }

        int totalFrames = (int)Math.Ceiling((double)compressed.Length / bytesPerFrame);
        if (totalFrames == 0) totalFrames = 1;

        Console.WriteLine("Mode:   " + modeLabel + " (mode_id=" + modeId + ")");
        Console.WriteLine("Grid:   " + cols + "x" + rows + " (" + block + "px blocks, " + border + "px border)");
        Console.WriteLine("Payload per frame: " + bytesPerFrame + " bytes (" + dataCells + " data cells)");
        Console.WriteLine("Frames: " + totalFrames);
        Console.WriteLine("Delay:  " + delay + " ms");

        double estSeconds = (double)totalFrames * delay / 1000.0;
        string estTime;
        if (estSeconds < 60)
            estTime = estSeconds.ToString("F1") + "s";
        else if (estSeconds < 3600)
            estTime = (estSeconds / 60).ToString("F1") + "m";
        else
            estTime = (estSeconds / 3600).ToString("F1") + "h";
        Console.WriteLine("Est. capture time: ~" + estTime);

        int canvasWidth = cols * block + 2 * border;
        int canvasHeight = rows * block + 2 * border;

        string badgeBg, badgeFg;
        switch (mode)
        {
            case "q2": badgeBg = "#350"; badgeFg = "#af0"; break;
            case "rgb": badgeBg = "#035"; badgeFg = "#0af"; break;
            default: badgeBg = "#530"; badgeFg = "#fa0"; break;
        }

        string html = BuildHtml(b64, block, cols, rows, border, bytesPerFrame, modeId, delay,
                                canvasWidth, canvasHeight, modeLabel, badgeBg, badgeFg, totalFrames);

        string outDir = Path.GetDirectoryName(output);
        if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir))
            Directory.CreateDirectory(outDir);

        File.WriteAllText(output, html, new UTF8Encoding(false));
        Console.WriteLine("✅ " + output + " (" + FormatSize(new FileInfo(output).Length) + ")");
        return 0;
    }

    static bool ParseArgs(string[] args)
    {
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a == "--help" || a == "-h")
            {
                PrintHelp();
                return false;
            }
            else if (a == "--mode" && i + 1 < args.Length)
            {
                mode = args[++i].ToLowerInvariant();
                if (mode != "q4" && mode != "q2" && mode != "rgb")
                {
                    Console.Error.WriteLine("Error: invalid mode '" + mode + "'. Use q4, q2, or rgb.");
                    return false;
                }
            }
            else if (a == "--block" && i + 1 < args.Length)
            {
                if (!int.TryParse(args[++i], out block) || block < 1)
                {
                    Console.Error.WriteLine("Error: invalid block size.");
                    return false;
                }
            }
            else if (a == "--delay" && i + 1 < args.Length)
            {
                if (!int.TryParse(args[++i], out delay) || delay < 1)
                {
                    Console.Error.WriteLine("Error: invalid delay.");
                    return false;
                }
            }
            else if (a == "--output" && i + 1 < args.Length)
            {
                output = args[++i];
            }
            else if (!a.StartsWith("-"))
            {
                inputPath = a;
            }
            else
            {
                Console.Error.WriteLine("Error: unknown option '" + a + "'.");
                return false;
            }
        }
        return true;
    }

    static void PrintHelp()
    {
        Console.WriteLine("Usage: VmEncoder <file|dir> [options]");
        Console.WriteLine();
        Console.WriteLine("Options:");
        Console.WriteLine("  --mode q4|q2|rgb   Encoding mode (default: q4)");
        Console.WriteLine("  --block N          Block size in pixels (default: 8)");
        Console.WriteLine("  --delay N          Frame delay in ms (default: 300)");
        Console.WriteLine("  --output FILE      Output HTML file (default: tmp/frames.html)");
        Console.WriteLine("  --help             Show this help");
    }

    static string FormatSize(long bytes)
    {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024.0).ToString("F1") + " KB";
        return (bytes / (1024.0 * 1024.0)).ToString("F2") + " MB";
    }

    static byte[] GzipCompress(byte[] data)
    {
        using (var ms = new MemoryStream())
        {
            using (var gz = new GZipStream(ms, CompressionLevel.Optimal, true))
            {
                gz.Write(data, 0, data.Length);
            }
            return ms.ToArray();
        }
    }

    static byte[] PackTar(string dirPath)
    {
        dirPath = Path.GetFullPath(dirPath);
        string baseName = Path.GetFileName(dirPath);
        using (var ms = new MemoryStream())
        {
            var files = new List<string>();
            GatherFiles(dirPath, files);
            files.Sort(StringComparer.Ordinal);

            foreach (string fullPath in files)
            {
                string rel = fullPath.Substring(dirPath.Length + 1).Replace('\\', '/');
                string tarName = baseName + "/" + rel;
                byte[] content = File.ReadAllBytes(fullPath);
                WriteTarEntry(ms, tarName, content);
            }

            // End-of-archive marker: 1024 zero bytes
            ms.Write(new byte[1024], 0, 1024);
            return ms.ToArray();
        }
    }

    static void GatherFiles(string dir, List<string> result)
    {
        string[] files = Directory.GetFiles(dir);
        Array.Sort(files, StringComparer.Ordinal);
        foreach (string f in files)
            result.Add(f);

        string[] dirs = Directory.GetDirectories(dir);
        Array.Sort(dirs, StringComparer.Ordinal);
        foreach (string d in dirs)
            GatherFiles(d, result);
    }

    static void WriteTarEntry(MemoryStream ms, string name, byte[] content)
    {
        byte[] header = new byte[512];

        // Name (0, 100)
        byte[] nameBytes = Encoding.ASCII.GetBytes(name);
        int nameLen = Math.Min(nameBytes.Length, 100);
        Array.Copy(nameBytes, 0, header, 0, nameLen);

        // Mode (100, 8)
        WriteOctal(header, 100, 8, "0100644");

        // UID (108, 8)
        WriteOctal(header, 108, 8, "0001750");

        // GID (116, 8)
        WriteOctal(header, 116, 8, "0001750");

        // Size (124, 12)
        WriteOctal(header, 124, 12, Convert.ToString(content.Length, 8).PadLeft(11, '0'));

        // Mtime (136, 12)
        long mtime = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalSeconds;
        WriteOctal(header, 136, 12, Convert.ToString(mtime, 8).PadLeft(11, '0'));

        // Checksum placeholder: spaces (148, 8)
        for (int i = 148; i < 156; i++) header[i] = 0x20;

        // Typeflag (156)
        header[156] = (byte)'0';

        // USTAR magic (257, 6) + version (263, 2)
        byte[] ustar = Encoding.ASCII.GetBytes("ustar\0");
        Array.Copy(ustar, 0, header, 257, 6);
        header[263] = (byte)'0';
        header[264] = (byte)'0';

        // Compute checksum
        long sum = 0;
        for (int i = 0; i < 512; i++) sum += header[i];
        string chkStr = Convert.ToString(sum, 8).PadLeft(6, '0');
        byte[] chkBytes = Encoding.ASCII.GetBytes(chkStr);
        Array.Copy(chkBytes, 0, header, 148, Math.Min(chkBytes.Length, 6));
        header[154] = 0;
        header[155] = 0x20;

        ms.Write(header, 0, 512);
        ms.Write(content, 0, content.Length);

        int pad = (512 - (content.Length % 512)) % 512;
        if (pad > 0) ms.Write(new byte[pad], 0, pad);
    }

    static void WriteOctal(byte[] buf, int offset, int fieldLen, string val)
    {
        byte[] vb = Encoding.ASCII.GetBytes(val);
        int copyLen = Math.Min(vb.Length, fieldLen - 1);
        Array.Copy(vb, 0, buf, offset, copyLen);
        buf[offset + copyLen] = 0;
    }

    static string BuildHtml(string b64, int blk, int cols, int rows, int bdr,
                            int bpf, int modeId, int spd,
                            int cw, int ch, string modeLabel,
                            string badgeBg, string badgeFg, int totalFrames)
    {
        var sb = new StringBuilder(b64.Length + 16384);
        sb.Append("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Visual Encoder v2 — ");
        sb.Append(modeLabel);
        sb.Append(" — ");
        sb.Append(totalFrames);
        sb.Append(" frames</title>\n<style>\n");
        sb.Append("*{margin:0;padding:0;box-sizing:border-box}\n");
        sb.Append("body{background:#0a0a0a;color:#ccc;font:13px/1.4 monospace;display:flex;flex-direction:column;align-items:center;padding:8px}\n");
        sb.Append("#info{margin:6px 0;font-size:14px;letter-spacing:.5px}\n");
        sb.Append("canvas{image-rendering:pixelated;image-rendering:crisp-edges}\n");
        sb.Append("#ctrl{margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}\n");
        sb.Append("button{padding:4px 14px;font:13px monospace;cursor:pointer;background:#222;color:#eee;border:1px solid #444;border-radius:3px}\n");
        sb.Append("button:hover{background:#333}\n");
        sb.Append("button.active{background:#060;border-color:#0a0}\n");
        sb.Append("button.loop-on{background:#006;border-color:#00a}\n");
        sb.Append("kbd{background:#222;padding:1px 5px;border-radius:2px;border:1px solid #444;font-size:12px}\n");
        sb.Append("#hint{font-size:11px;color:#666;margin-top:4px}\n");
        sb.Append("#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;\n  background:");
        sb.Append(badgeBg);
        sb.Append(";color:");
        sb.Append(badgeFg);
        sb.Append("}\n</style>\n</head>\n<body>\n");
        sb.Append("\n<div id=\"info\">Loading…</div>\n");
        sb.Append("<div><span id=\"mode-badge\">");
        sb.Append(modeLabel);
        sb.Append(" mode</span></div>\n");
        sb.Append("<canvas id=\"c\" width=\"");
        sb.Append(cw);
        sb.Append("\" height=\"");
        sb.Append(ch);
        sb.Append("\"></canvas>\n");
        sb.Append("<div id=\"ctrl\">\n");
        sb.Append("  <button onclick=\"prev()\">◀</button>\n");
        sb.Append("  <button onclick=\"togglePlay()\" id=\"bp\">▶ Play</button>\n");
        sb.Append("  <button onclick=\"next()\">▶</button>\n");
        sb.Append("  <button onclick=\"toggleLoop()\" id=\"bl\">\U0001F501 Loop</button>\n");
        sb.Append("  <span style=\"margin-left:12px\">ms/frame:</span>\n");
        sb.Append("  <button onclick=\"spd(50)\">50</button>\n");
        sb.Append("  <button onclick=\"spd(100)\">100</button>\n");
        sb.Append("  <button onclick=\"spd(200)\">200</button>\n");
        sb.Append("  <button onclick=\"spd(300)\" id=\"s300\">300</button>\n");
        sb.Append("  <button onclick=\"spd(500)\" id=\"s500\">500</button>\n");
        sb.Append("  <button onclick=\"spd(1000)\">1000</button>\n");
        sb.Append("</div>\n");
        sb.Append("<div id=\"hint\"><kbd>←</kbd> prev  <kbd>→</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>\n");
        sb.Append("\n<script>\n");
        sb.Append("// ── Embedded payload (base64) ──\n");
        sb.Append("const B64=\"");
        sb.Append(b64);
        sb.Append("\";\n");
        sb.Append("\n// ── Constants ──\n");
        sb.Append("const BLK=");
        sb.Append(blk);
        sb.Append(",COLS=");
        sb.Append(cols);
        sb.Append(",ROWS=");
        sb.Append(rows);
        sb.Append(",BDR=");
        sb.Append(bdr);
        sb.Append(";\nconst BPF=");
        sb.Append(bpf);
        sb.Append(";\nconst MODE=");
        sb.Append(modeId);
        sb.Append("; // 0=RGB, 1=Q4, 2=Q2\n");
        sb.Append("\n// ── Decode base64 → Uint8Array ──\n");
        sb.Append("function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}\n");
        sb.Append("const data=b2u(B64);\nconst TF=Math.ceil(data.length/BPF);\n");
        sb.Append("\nlet cur=0,playing=false,looping=true,timer=null,speed=");
        sb.Append(spd);
        sb.Append(";\nconst cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');\n");
        // The rest of the JS is fixed - no more parameters
        sb.Append("\n// ── Offscreen double buffer (avoids tearing during frame transitions) ──\n");
        sb.Append("const offCv=document.createElement('canvas');\noffCv.width=cv.width;offCv.height=cv.height;\nconst off=offCv.getContext('2d');\n");
        sb.Append("\n// ── CRC-32 ──\n");
        sb.Append("function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}\n");
        sb.Append("\n// ── Draw helpers ──\n");
        sb.Append("function cell(c,r,R,G,B){off.fillStyle='rgb('+R+','+G+','+B+')';off.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}\n");
        sb.Append("\n// Q4: encode 6-bit value as RGB (2 bits per channel, levels 0,85,170,255)\n");
        sb.Append("function q4cell(c,r,val){\n  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);\n}\n");
        sb.Append("\n// Q2: encode 3-bit value as RGB (1 bit per channel, levels 0,255)\n");
        sb.Append("function q2cell(c,r,val){\n  cell(c,r,((val>>2)&1)*255,((val>>1)&1)*255,(val&1)*255);\n}\n");
        sb.Append("\n// ── Draw one frame ──\n");
        sb.Append("function draw(idx){\n  off.fillStyle='#000';off.fillRect(0,0,offCv.width,offCv.height);\n");
        sb.Append("\n  // Sync border (alternating black / magenta cells)\n");
        sb.Append("  for(let i=0;i<COLS+2;i++){\n    off.fillStyle=i%2?'#f0f':'#000';\n    off.fillRect(i*BLK,0,BLK,BDR);\n    off.fillRect(i*BLK,BDR+ROWS*BLK,BLK,BDR);\n  }\n");
        sb.Append("  for(let j=0;j<ROWS;j++){\n    off.fillStyle=j%2?'#f0f':'#000';\n    off.fillRect(0,BDR+j*BLK,BDR,BLK);\n    off.fillRect(BDR+COLS*BLK,BDR+j*BLK,BDR,BLK);\n  }\n");
        sb.Append("\n  // Frame payload slice\n");
        sb.Append("  const s=idx*BPF, e=Math.min(s+BPF,data.length);\n  const fd=data.slice(s,e), dl=fd.length;\n  const chk=crc32(fd);\n");
        sb.Append("\n  if(MODE===1){\n");
        sb.Append("    // ═══ Q4 HEADER ═══\n");
        sb.Append("    // Magic\n");
        sb.Append("    q4cell(0,0,55); // (255,85,255)\n");
        sb.Append("    q4cell(1,0,28); // (85,255,0)\n");
        sb.Append("    // Frame index (18 bits → 3 cells)\n");
        sb.Append("    q4cell(2,0,(idx>>12)&0x3F);\n");
        sb.Append("    q4cell(3,0,(idx>>6)&0x3F);\n");
        sb.Append("    q4cell(4,0,idx&0x3F);\n");
        sb.Append("    // Total frames (18 bits → 3 cells)\n");
        sb.Append("    q4cell(5,0,(TF>>12)&0x3F);\n");
        sb.Append("    q4cell(6,0,(TF>>6)&0x3F);\n");
        sb.Append("    q4cell(7,0,TF&0x3F);\n");
        sb.Append("    // Data length this frame (18 bits → 3 cells)\n");
        sb.Append("    q4cell(8,0,(dl>>12)&0x3F);\n");
        sb.Append("    q4cell(9,0,(dl>>6)&0x3F);\n");
        sb.Append("    q4cell(10,0,dl&0x3F);\n");
        sb.Append("    // CRC32 (32 bits → 6 cells, MSB first)\n");
        sb.Append("    q4cell(11,0,(chk>>>26)&0x3F);\n");
        sb.Append("    q4cell(12,0,(chk>>>20)&0x3F);\n");
        sb.Append("    q4cell(13,0,(chk>>>14)&0x3F);\n");
        sb.Append("    q4cell(14,0,(chk>>>8)&0x3F);\n");
        sb.Append("    q4cell(15,0,(chk>>>2)&0x3F);\n");
        sb.Append("    q4cell(16,0,(chk&0x3)<<4);\n");
        sb.Append("    // Grid dims: COLS (2 cells), ROWS (2 cells), block size (1 cell)\n");
        sb.Append("    q4cell(17,0,(COLS>>6)&0x3F);\n");
        sb.Append("    q4cell(18,0,COLS&0x3F);\n");
        sb.Append("    q4cell(19,0,(ROWS>>6)&0x3F);\n");
        sb.Append("    q4cell(20,0,ROWS&0x3F);\n");
        sb.Append("    q4cell(21,0,BLK&0x3F);\n");
        sb.Append("    // Mode marker\n");
        sb.Append("    q4cell(22,0,1);\n");
        sb.Append("    // Padding\n");
        sb.Append("    for(let c=23;c<COLS;c++) q4cell(c,0,0);\n");
        sb.Append("\n    // ═══ Q4 DATA ═══\n");
        sb.Append("    // 4 cells → 3 bytes (24 bits → 4×6 bits)\n");
        sb.Append("    let bi=0, ci=0;\n");
        sb.Append("    const totalCells=COLS*(ROWS-1);\n");
        sb.Append("    while(ci<totalCells){\n");
        sb.Append("      const b0=bi<dl?fd[bi++]:0;\n");
        sb.Append("      const b1=bi<dl?fd[bi++]:0;\n");
        sb.Append("      const b2=bi<dl?fd[bi++]:0;\n");
        sb.Append("      const v0=b0>>2;\n");
        sb.Append("      const v1=((b0&3)<<4)|(b1>>4);\n");
        sb.Append("      const v2=((b1&0xF)<<2)|(b2>>6);\n");
        sb.Append("      const v3=b2&0x3F;\n");
        sb.Append("      const vals=[v0,v1,v2,v3];\n");
        sb.Append("      for(let k=0;k<4&&ci<totalCells;k++,ci++){\n");
        sb.Append("        const r=Math.floor(ci/COLS)+1;\n");
        sb.Append("        const c=ci%COLS;\n");
        sb.Append("        q4cell(c,r,vals[k]);\n");
        sb.Append("      }\n");
        sb.Append("    }\n");
        sb.Append("  } else if(MODE===2){\n");
        sb.Append("    // ═══ Q2 HEADER ═══\n");
        sb.Append("    // Q2: 3 bits/cell (1 bit per channel), values 0-7\n");
        sb.Append("    function q2h(col,val){ q2cell(col,0,val); }\n");
        sb.Append("\n    // Magic\n");
        sb.Append("    q2h(0,5); // (255,0,255) magenta\n");
        sb.Append("    q2h(1,6); // (255,255,0) yellow\n");
        sb.Append("    // Frame index (18 bits → 6 cells × 3 bits)\n");
        sb.Append("    q2h(2,(idx>>15)&7); q2h(3,(idx>>12)&7); q2h(4,(idx>>9)&7);\n");
        sb.Append("    q2h(5,(idx>>6)&7);  q2h(6,(idx>>3)&7);  q2h(7,idx&7);\n");
        sb.Append("    // Total frames (18 bits → 6 cells)\n");
        sb.Append("    q2h(8,(TF>>15)&7);  q2h(9,(TF>>12)&7);  q2h(10,(TF>>9)&7);\n");
        sb.Append("    q2h(11,(TF>>6)&7);  q2h(12,(TF>>3)&7);  q2h(13,TF&7);\n");
        sb.Append("    // Data length (18 bits → 6 cells)\n");
        sb.Append("    q2h(14,(dl>>15)&7); q2h(15,(dl>>12)&7); q2h(16,(dl>>9)&7);\n");
        sb.Append("    q2h(17,(dl>>6)&7);  q2h(18,(dl>>3)&7);  q2h(19,dl&7);\n");
        sb.Append("    // CRC32 (32 bits → 11 cells, 33 bits available, MSB first)\n");
        sb.Append("    q2h(20,(chk>>>30)&7); q2h(21,(chk>>>27)&7); q2h(22,(chk>>>24)&7);\n");
        sb.Append("    q2h(23,(chk>>>21)&7); q2h(24,(chk>>>18)&7); q2h(25,(chk>>>15)&7);\n");
        sb.Append("    q2h(26,(chk>>>12)&7); q2h(27,(chk>>>9)&7);  q2h(28,(chk>>>6)&7);\n");
        sb.Append("    q2h(29,(chk>>>3)&7);  q2h(30,chk&7);\n");
        sb.Append("    // Grid dims: COLS (4 cells=12 bits), ROWS (4 cells), block (2 cells), mode (1 cell)\n");
        sb.Append("    q2h(31,(COLS>>9)&7); q2h(32,(COLS>>6)&7); q2h(33,(COLS>>3)&7); q2h(34,COLS&7);\n");
        sb.Append("    q2h(35,(ROWS>>9)&7); q2h(36,(ROWS>>6)&7); q2h(37,(ROWS>>3)&7); q2h(38,ROWS&7);\n");
        sb.Append("    q2h(39,(BLK>>3)&7);  q2h(40,BLK&7);\n");
        sb.Append("    q2h(41,2); // mode marker = 2\n");
        sb.Append("    // Padding\n");
        sb.Append("    for(let c=42;c<COLS;c++) q2h(c,0);\n");
        sb.Append("\n    // ═══ Q2 DATA ═══\n");
        sb.Append("    // 8 cells × 3 bits = 24 bits = 3 bytes\n");
        sb.Append("    let bi=0, ci=0;\n");
        sb.Append("    const totalCells=COLS*(ROWS-1);\n");
        sb.Append("    while(ci<totalCells){\n");
        sb.Append("      const b0=bi<dl?fd[bi++]:0;\n");
        sb.Append("      const b1=bi<dl?fd[bi++]:0;\n");
        sb.Append("      const b2=bi<dl?fd[bi++]:0;\n");
        sb.Append("      // 24 bits → 8 × 3-bit values\n");
        sb.Append("      const v0=(b0>>5)&7;\n");
        sb.Append("      const v1=(b0>>2)&7;\n");
        sb.Append("      const v2=((b0&3)<<1)|(b1>>7);\n");
        sb.Append("      const v3=(b1>>4)&7;\n");
        sb.Append("      const v4=(b1>>1)&7;\n");
        sb.Append("      const v5=((b1&1)<<2)|(b2>>6);\n");
        sb.Append("      const v6=(b2>>3)&7;\n");
        sb.Append("      const v7=b2&7;\n");
        sb.Append("      const vals=[v0,v1,v2,v3,v4,v5,v6,v7];\n");
        sb.Append("      for(let k=0;k<8&&ci<totalCells;k++,ci++){\n");
        sb.Append("        const r=Math.floor(ci/COLS)+1;\n");
        sb.Append("        const c=ci%COLS;\n");
        sb.Append("        q2cell(c,r,vals[k]);\n");
        sb.Append("      }\n");
        sb.Append("    }\n");
        sb.Append("  } else {\n");
        sb.Append("    // ═══ RGB HEADER (same as v1) ═══\n");
        sb.Append("    cell(0,0,0xDE,0xAD,0x01);\n");
        sb.Append("    cell(1,0,0xBE,0xEF,0x02);\n");
        sb.Append("    cell(2,0,(idx>>16)&0xFF,(idx>>8)&0xFF,idx&0xFF);\n");
        sb.Append("    cell(3,0,(TF>>16)&0xFF,(TF>>8)&0xFF,TF&0xFF);\n");
        sb.Append("    cell(4,0,(dl>>16)&0xFF,(dl>>8)&0xFF,dl&0xFF);\n");
        sb.Append("    cell(5,0,(chk>>24)&0xFF,(chk>>16)&0xFF,(chk>>8)&0xFF);\n");
        sb.Append("    cell(6,0,chk&0xFF,COLS&0xFF,ROWS&0xFF);\n");
        sb.Append("    cell(7,0,BLK,0,0);\n");
        sb.Append("    for(let c=8;c<COLS;c++) cell(c,0,0x80,0x80,0x80);\n");
        sb.Append("\n    // ═══ RGB DATA ═══\n");
        sb.Append("    let bi=0;\n");
        sb.Append("    for(let r=1;r<ROWS;r++){\n");
        sb.Append("      for(let c=0;c<COLS;c++){\n");
        sb.Append("        const R=bi<dl?fd[bi++]:0,G=bi<dl?fd[bi++]:0,B=bi<dl?fd[bi++]:0;\n");
        sb.Append("        cell(c,r,R,G,B);\n");
        sb.Append("      }\n");
        sb.Append("    }\n");
        sb.Append("  }\n");
        sb.Append("\n  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE===2?'Q2':MODE===1?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';\n");
        sb.Append("\n  // Atomic blit: copy completed frame to visible canvas in one operation\n");
        sb.Append("  cx.drawImage(offCv,0,0);\n}\n");
        sb.Append("\n// ── Controls (rAF-synced playback) ──\n");
        sb.Append("// rAF-synced: each frame survives at least one vsync before next swap.\n");
        sb.Append("let rafId=null, lastFrameTime=0;\n");
        sb.Append("\nfunction advance(){\n");
        sb.Append("  if(cur>=TF-1){\n");
        sb.Append("    if(looping){cur=0} else {togglePlay();return}\n");
        sb.Append("  } else {cur++}\n");
        sb.Append("  draw(cur);\n}\n");
        sb.Append("\nfunction next(){advance()}\n");
        sb.Append("function prev(){cur=Math.max(cur-1,0);draw(cur)}\n");
        sb.Append("\nfunction playLoop(ts){\n");
        sb.Append("  if(!playing) return;\n");
        sb.Append("  if(ts-lastFrameTime>=speed){\n");
        sb.Append("    advance();\n");
        sb.Append("    lastFrameTime=ts;\n");
        sb.Append("  }\n");
        sb.Append("  rafId=requestAnimationFrame(playLoop);\n}\n");
        sb.Append("\nfunction togglePlay(){\n");
        sb.Append("  playing=!playing;\n");
        sb.Append("  document.getElementById('bp').textContent=playing?'⏸ Pause':'▶ Play';\n");
        sb.Append("  if(playing){\n");
        sb.Append("    lastFrameTime=performance.now();\n");
        sb.Append("    rafId=requestAnimationFrame(playLoop);\n");
        sb.Append("  } else {\n");
        sb.Append("    if(rafId){cancelAnimationFrame(rafId);rafId=null}\n");
        sb.Append("  }\n}\n");
        sb.Append("\nfunction toggleLoop(){\n");
        sb.Append("  looping=!looping;\n");
        sb.Append("  const bl=document.getElementById('bl');\n");
        sb.Append("  bl.classList.toggle('loop-on',looping);\n");
        sb.Append("  bl.textContent=looping?'\U0001F501 Loop ON':'\U0001F501 Loop OFF';\n}\n");
        sb.Append("\nfunction spd(ms){\n");
        sb.Append("  speed=ms;\n");
        sb.Append("  document.querySelectorAll('#ctrl button.active').forEach(b=>{if(b.id!=='bl')b.classList.remove('active')});\n");
        sb.Append("  event.target.classList.add('active');\n");
        sb.Append("  // playLoop reads speed live, no restart needed\n}\n");
        sb.Append("\n\ndocument.addEventListener('keydown',e=>{\n");
        sb.Append("  if(e.key==='ArrowRight')next();\n");
        sb.Append("  else if(e.key==='ArrowLeft')prev();\n");
        sb.Append("  else if(e.key===' '){e.preventDefault();togglePlay()}\n");
        sb.Append("  else if(e.key==='Home'){cur=0;draw(0)}\n");
        sb.Append("  else if(e.key==='End'){cur=TF-1;draw(cur)}\n");
        sb.Append("  else if(e.key==='l'||e.key==='L')toggleLoop();\n});\n");
        sb.Append("\n// Auto-start loop indicator\n");
        sb.Append("document.getElementById('bl').classList.add('loop-on');\n");
        sb.Append("\n// Mark initial speed button as active\n");
        sb.Append("const initBtn = document.getElementById('s' + speed);\n");
        sb.Append("if (initBtn) initBtn.classList.add('active');\n");
        sb.Append("\ndraw(0);\n");
        sb.Append("</script>\n</body>\n</html>");
        return sb.ToString();
    }
}
