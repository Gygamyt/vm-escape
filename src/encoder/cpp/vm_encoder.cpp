/*
 * ===== VISUAL ENCODER v2 — C++17 port =====
 * Single-file encoder. Faithful port of vm-encoder.js.
 *
 * Compile:
 *   g++ -std=c++17 -O2 -o vm_encoder vm_encoder.cpp -lz
 *
 * Usage:
 *   ./vm_encoder <file> [--mode q4|q2|rgb] [--block N] [--delay N] [--output FILE] [--help]
 */

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

#include <zlib.h>

namespace fs = std::filesystem;

// ── Helpers ──────────────────────────────────────────────

static std::string base64_encode(const std::vector<uint8_t>& data) {
    static const char tab[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((data.size() + 2) / 3) * 4);
    size_t i = 0;
    while (i < data.size()) {
        uint32_t a = data[i++];
        uint32_t b = (i < data.size()) ? data[i++] : 0;
        uint32_t c = (i < data.size()) ? data[i++] : 0;
        uint32_t trip = (a << 16) | (b << 8) | c;
        out.push_back(tab[(trip >> 18) & 0x3F]);
        out.push_back(tab[(trip >> 12) & 0x3F]);
        size_t rem = data.size() - (i - (i < data.size() ? 0 : (b ? 1 : 2)));
        // re-derive pad count
        out.push_back(tab[(trip >> 6) & 0x3F]);
        out.push_back(tab[trip & 0x3F]);
    }
    // Fix up padding
    size_t mod = data.size() % 3;
    if (mod == 1) {
        out[out.size() - 2] = '=';
        out[out.size() - 1] = '=';
    } else if (mod == 2) {
        out[out.size() - 1] = '=';
    }
    return out;
}

static std::vector<uint8_t> read_file(const std::string& path) {
    std::ifstream f(path, std::ios::binary | std::ios::ate);
    if (!f) {
        std::cerr << "Error: file not found: " << path << "\n";
        std::cerr << "Check the path and try again.\n";
        std::exit(1);
    }
    auto sz = f.tellg();
    f.seekg(0);
    std::vector<uint8_t> buf(static_cast<size_t>(sz));
    f.read(reinterpret_cast<char*>(buf.data()), sz);
    return buf;
}

// ── Tar packing ──────────────────────────────────────────

static std::string octal(uint64_t val, int width) {
    std::string s;
    if (val == 0) s = "0";
    else {
        while (val > 0) {
            s.push_back('0' + static_cast<char>(val & 7));
            val >>= 3;
        }
        std::reverse(s.begin(), s.end());
    }
    while (static_cast<int>(s.size()) < width) s.insert(s.begin(), '0');
    return s;
}

static void tar_add_file(std::vector<uint8_t>& tar,
                          const std::string& name,
                          const std::vector<uint8_t>& filedata) {
    // Build 512-byte header
    uint8_t hdr[512];
    std::memset(hdr, 0, 512);

    // name (max 100 bytes)
    size_t nlen = std::min(name.size(), size_t(100));
    std::memcpy(hdr, name.c_str(), nlen);

    // mode
    std::memcpy(hdr + 100, "0100644", 7);
    // uid
    std::memcpy(hdr + 108, "0001750", 7);
    // gid
    std::memcpy(hdr + 116, "0001750", 7);
    // size (octal, 11 chars)
    std::string szStr = octal(filedata.size(), 11);
    std::memcpy(hdr + 124, szStr.c_str(), 11);
    // mtime
    auto now = std::time(nullptr);
    std::string mtStr = octal(static_cast<uint64_t>(now), 11);
    std::memcpy(hdr + 136, mtStr.c_str(), 11);
    // checksum placeholder = spaces
    std::memset(hdr + 148, 0x20, 8);
    // typeflag '0' = regular file
    hdr[156] = 0x30;
    // magic "ustar" (null at 262 already from memset)
    std::memcpy(hdr + 257, "ustar", 5);
    // version "00"
    std::memcpy(hdr + 263, "00", 2);

    // compute checksum
    uint32_t cksum = 0;
    for (int i = 0; i < 512; i++) cksum += hdr[i];
    std::string cs = octal(cksum, 6);
    std::memcpy(hdr + 148, cs.c_str(), 6);
    hdr[154] = 0;     // null terminator
    hdr[155] = 0x20;  // trailing space

    // append header
    tar.insert(tar.end(), hdr, hdr + 512);
    // append data
    tar.insert(tar.end(), filedata.begin(), filedata.end());
    // pad to 512
    size_t pad = (512 - (filedata.size() % 512)) % 512;
    if (pad > 0) tar.insert(tar.end(), pad, 0);
}

static void walk_dir(std::vector<uint8_t>& tar,
                     const fs::path& dir,
                     const std::string& prefix) {
    // Collect and sort entries
    std::vector<fs::directory_entry> entries;
    for (auto& e : fs::directory_iterator(dir))
        entries.push_back(e);
    std::sort(entries.begin(), entries.end(),
              [](const fs::directory_entry& a, const fs::directory_entry& b) {
                  return a.path().filename().string() < b.path().filename().string();
              });
    for (auto& e : entries) {
        std::string name = e.path().filename().string();
        std::string rel = prefix.empty() ? name : prefix + "/" + name;
        if (e.is_directory()) {
            walk_dir(tar, e.path(), rel);
        } else if (e.is_regular_file()) {
            auto fdata = read_file(e.path().string());
            tar_add_file(tar, rel, fdata);
        }
    }
}

// ── Gzip compression ─────────────────────────────────────

static std::vector<uint8_t> gzip_compress(const std::vector<uint8_t>& input) {
    z_stream strm{};
    // windowBits=15+16 for gzip format
    if (deflateInit2(&strm, 9, Z_DEFLATED, 15 + 16, 8, Z_DEFAULT_STRATEGY) != Z_OK) {
        std::cerr << "deflateInit2 failed\n";
        std::exit(1);
    }
    strm.next_in = const_cast<Bytef*>(input.data());
    strm.avail_in = static_cast<uInt>(input.size());

    std::vector<uint8_t> out;
    uint8_t buf[131072];
    int ret;
    do {
        strm.next_out = buf;
        strm.avail_out = sizeof(buf);
        ret = deflate(&strm, Z_FINISH);
        size_t have = sizeof(buf) - strm.avail_out;
        out.insert(out.end(), buf, buf + have);
    } while (ret == Z_OK);
    deflateEnd(&strm);
    if (ret != Z_STREAM_END) {
        std::cerr << "gzip compression failed\n";
        std::exit(1);
    }
    return out;
}

// ── CLI ──────────────────────────────────────────────────

static void show_help() {
    std::cout << R"(
  vm-escape encoder — encode any file into a visual pixel grid (HTML)

  USAGE
    ./vm_encoder <file> [options]

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
    ./vm_encoder allure-small.tar.gz

    # Use RGB mode for lossless screenshot capture
    ./vm_encoder report.tar.gz --mode rgb

    # Custom block size and output path
    ./vm_encoder data.tar.gz --block 10 --output my-frames.html

  WORKFLOW
    1. Run the encoder on the file inside the VM -> produces an HTML file
    2. Open the HTML in a browser inside the VM -> plays animated pixel frames
    3. On the host machine, open src/decoder/host-decoder.html in a browser
    4. Click "Start Capture" -> select the VM window -> wait for 100%
    5. Download the decoded file on the host
)";
}

int main(int argc, char* argv[]) {
    std::vector<std::string> args;
    for (int i = 1; i < argc; i++) args.emplace_back(argv[i]);

    auto hasFlag = [&](const std::string& name) {
        return std::find(args.begin(), args.end(), "--" + name) != args.end();
    };

    if (hasFlag("help") || hasFlag("h") ||
        std::find(args.begin(), args.end(), "-h") != args.end()) {
        show_help();
        return 0;
    }

    // Find input file (first arg not starting with --)
    std::string inputFile;
    for (auto& a : args) {
        if (a != "-h" && a.substr(0, 2) != "--") {
            inputFile = a;
            break;
        }
    }
    if (inputFile.empty()) {
        std::cerr << "Error: no input file specified.\n\n";
        std::cerr << "Usage: ./vm_encoder <file> [--mode q4|rgb] [--output FILE]\n";
        std::cerr << "\nRun with --help for full usage information.\n";
        return 1;
    }

    auto getArg = [&](const std::string& name, const std::string& def) -> std::string {
        auto it = std::find(args.begin(), args.end(), "--" + name);
        if (it != args.end() && (it + 1) != args.end())
            return *(it + 1);
        return def;
    };

    std::string MODE = getArg("mode", "q4");
    int BLOCK = std::stoi(getArg("block", "8"));
    int DELAY = std::max(50, std::stoi(getArg("delay", "300")));
    std::string OUTPUT = getArg("output", "tmp/frames.html");

    if (MODE != "q4" && MODE != "q2" && MODE != "rgb") {
        std::cerr << "Invalid mode \"" << MODE << "\". Use q4, q2 or rgb.\n";
        return 1;
    }

    // ── Grid geometry ───────────────────────────────────────
    int BORDER = BLOCK;
    int COLS = (1200 - 2 * BORDER) / BLOCK;
    int ROWS = (700 - 2 * BORDER) / BLOCK;
    int HEADER_ROWS = 1;
    int DATA_ROWS = ROWS - HEADER_ROWS;
    int CELLS_PER_FRAME = DATA_ROWS * COLS;

    int BYTES_PER_FRAME;
    if (MODE == "q4")
        BYTES_PER_FRAME = (CELLS_PER_FRAME / 4) * 3;
    else if (MODE == "q2")
        BYTES_PER_FRAME = (CELLS_PER_FRAME / 8) * 3;
    else
        BYTES_PER_FRAME = CELLS_PER_FRAME * 3;

    int MODE_ID = (MODE == "q4") ? 1 : (MODE == "q2") ? 2 : 0;
    int CANVAS_W = COLS * BLOCK + 2 * BORDER;
    int CANVAS_H = ROWS * BLOCK + 2 * BORDER;

    // ── Read & compress input ───────────────────────────────
    if (!fs::exists(inputFile)) {
        std::cerr << "Error: file not found: " << inputFile << "\n";
        std::cerr << "Check the path and try again.\n";
        return 1;
    }

    std::vector<uint8_t> data;
    if (fs::is_directory(inputFile)) {
        std::cout << "Input is a directory, packing as tar...\n";
        fs::path resolved = fs::canonical(inputFile);
        std::string basename = resolved.filename().string();
        walk_dir(data, resolved, basename);
        // end-of-archive marker (1024 zero bytes)
        data.insert(data.end(), 1024, 0);
        char buf[128];
        std::snprintf(buf, sizeof(buf), "Input:  %s/ -> tar (%.2f MB)",
                      inputFile.c_str(), data.size() / 1048576.0);
        std::cout << buf << "\n";
    } else {
        data = read_file(inputFile);
        char buf[128];
        std::snprintf(buf, sizeof(buf), "Input:  %s (%.2f MB)",
                      inputFile.c_str(), data.size() / 1048576.0);
        std::cout << buf << "\n";
    }

    // Gzip if not already gzipped
    if (data.size() < 2 || data[0] != 0x1f || data[1] != 0x8b) {
        std::cout << "Compressing with gzip -9...\n";
        data = gzip_compress(data);
        char buf[64];
        std::snprintf(buf, sizeof(buf), "Compressed: %.2f MB", data.size() / 1048576.0);
        std::cout << buf << "\n";
    }

    int totalFrames = static_cast<int>((data.size() + BYTES_PER_FRAME - 1) / BYTES_PER_FRAME);

    std::cout << "Mode:   " << MODE
              << (MODE == "q4" ? " (4-level quantized, lossy-safe)"
                               : MODE == "q2" ? " (2-level quantized, ultra-robust)"
                                               : " (full RGB, lossless only)")
              << "\n";
    {
        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "Grid:   %dx%d cells, block=%dpx, canvas=%dx%d",
                      COLS, ROWS, BLOCK, CANVAS_W, CANVAS_H);
        std::cout << buf << "\n";
    }
    {
        char buf[128];
        std::snprintf(buf, sizeof(buf),
                      "Payload per frame: %.1f KB (%d data cells)",
                      BYTES_PER_FRAME / 1024.0, CELLS_PER_FRAME);
        std::cout << buf << "\n";
    }
    std::cout << "Frames: " << totalFrames << "\n";
    {
        double estMinutes = totalFrames * DELAY / 1000.0 / 60.0;
        char buf[128];
        std::snprintf(buf, sizeof(buf),
                      "Delay:  %dms/frame\nEst. capture time: ~%.1f min (%d frames x %dms)",
                      DELAY, estMinutes, totalFrames, DELAY);
        std::cout << buf << "\n";
    }

    // ── Feasibility check ───────────────────────────────────
    std::string b64 = base64_encode(data);
    double htmlSizeMB = (b64.size() * 1.05) / 1048576.0;
    if (htmlSizeMB > 200) {
        char buf[128];
        std::snprintf(buf, sizeof(buf),
                      "\nWarning: HTML will be ~%.0f MB -- browser may not handle it.", htmlSizeMB);
        std::cerr << buf << "\n";
        return 1;
    }
    if (htmlSizeMB > 50) {
        char buf[128];
        std::snprintf(buf, sizeof(buf),
                      "\nWarning: HTML will be ~%.0f MB -- may load slowly.", htmlSizeMB);
        std::cerr << buf << "\n";
    }

    // ── Magic values ────────────────────────────────────────
    int Q4_MAGIC0_VAL = 55;
    int Q4_MAGIC1_VAL = 28;
    int Q2_MAGIC0_VAL = 5;
    int Q2_MAGIC1_VAL = 6;

    // ── Badge colors ────────────────────────────────────────
    std::string badgeBg, badgeFg;
    if (MODE == "q4")       { badgeBg = "#530"; badgeFg = "#fa0"; }
    else if (MODE == "q2")  { badgeBg = "#350"; badgeFg = "#af0"; }
    else                    { badgeBg = "#035"; badgeFg = "#0af"; }

    std::string modeUpper = MODE;
    for (auto& c : modeUpper) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));

    // ── Generate HTML ───────────────────────────────────────
    std::ostringstream html;
    html << "<!DOCTYPE html>\n"
            "<html lang=\"en\">\n"
            "<head>\n"
            "<meta charset=\"utf-8\">\n"
            "<title>Visual Encoder v2 \\u2014 " << modeUpper << " \\u2014 " << totalFrames << " frames</title>\n"
            "<style>\n"
            "*{margin:0;padding:0;box-sizing:border-box}\n"
            "body{background:#0a0a0a;color:#ccc;font:13px/1.4 monospace;display:flex;flex-direction:column;align-items:center;padding:8px}\n"
            "#info{margin:6px 0;font-size:14px;letter-spacing:.5px}\n"
            "canvas{image-rendering:pixelated;image-rendering:crisp-edges}\n"
            "#ctrl{margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}\n"
            "button{padding:4px 14px;font:13px monospace;cursor:pointer;background:#222;color:#eee;border:1px solid #444;border-radius:3px}\n"
            "button:hover{background:#333}\n"
            "button.active{background:#060;border-color:#0a0}\n"
            "button.loop-on{background:#006;border-color:#00a}\n"
            "kbd{background:#222;padding:1px 5px;border-radius:2px;border:1px solid #444;font-size:12px}\n"
            "#hint{font-size:11px;color:#666;margin-top:4px}\n"
            "#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;\n"
            "  background:" << badgeBg << ";color:" << badgeFg << "}\n"
            "</style>\n"
            "</head>\n"
            "<body>\n"
            "\n"
            "<div id=\"info\">Loading\\u2026</div>\n"
            "<div><span id=\"mode-badge\">" << modeUpper << " mode</span></div>\n"
            "<canvas id=\"c\" width=\"" << CANVAS_W << "\" height=\"" << CANVAS_H << "\"></canvas>\n"
            "<div id=\"ctrl\">\n"
            "  <button onclick=\"prev()\">\\u25C0</button>\n"
            "  <button onclick=\"togglePlay()\" id=\"bp\">\\u25B6 Play</button>\n"
            "  <button onclick=\"next()\">\\u25B6</button>\n"
            "  <button onclick=\"toggleLoop()\" id=\"bl\">\\uD83D\\uDD01 Loop</button>\n"
            "  <span style=\"margin-left:12px\">ms/frame:</span>\n"
            "  <button onclick=\"spd(50)\">50</button>\n"
            "  <button onclick=\"spd(100)\">100</button>\n"
            "  <button onclick=\"spd(200)\">200</button>\n"
            "  <button onclick=\"spd(300)\" id=\"s300\">300</button>\n"
            "  <button onclick=\"spd(500)\" id=\"s500\">500</button>\n"
            "  <button onclick=\"spd(1000)\">1000</button>\n"
            "</div>\n"
            "<div id=\"hint\"><kbd>\\u2190</kbd> prev  <kbd>\\u2192</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>\n"
            "\n";

    // Stop — the Node.js source uses literal Unicode characters in the template,
    // not escape sequences. We must output them byte-for-byte.
    // Let me re-examine: the JS template uses backtick strings with literal chars.
    // The title uses — (em dash), the buttons use literal Unicode chars.
    // We need to output the exact UTF-8 bytes.

    // Actually, re-reading the Node source: it uses template literals.
    // The title: "Visual Encoder v2 — ${MODE.toUpperCase()} — ${totalFrames} frames"
    // The — is a literal em dash U+2014 (UTF-8: E2 80 94)
    // The ◀ is U+25C0, ▶ is U+25B6, 🔁 is U+1F501
    // The … in "Loading…" is U+2026
    // The ← is U+2190, → is U+2192
    // The ⏸ is U+23F8

    // I need to redo the HTML output with actual UTF-8 characters.

    // Let me rebuild this properly.
    html.str("");
    html.clear();

    // Em dash: \xE2\x80\x94
    // Ellipsis: \xE2\x80\xA6
    // ◀: \xE2\x97\x80
    // ▶: \xE2\x96\xB6
    // 🔁: \xF0\x9F\x94\x81
    // ⏸: \xE2\x8F\xB8
    // ←: \xE2\x86\x90
    // →: \xE2\x86\x92

    html << "<!DOCTYPE html>\n"
            "<html lang=\"en\">\n"
            "<head>\n"
            "<meta charset=\"utf-8\">\n"
            "<title>Visual Encoder v2 \xE2\x80\x94 " << modeUpper << " \xE2\x80\x94 " << totalFrames << " frames</title>\n"
            "<style>\n"
            "*{margin:0;padding:0;box-sizing:border-box}\n"
            "body{background:#0a0a0a;color:#ccc;font:13px/1.4 monospace;display:flex;flex-direction:column;align-items:center;padding:8px}\n"
            "#info{margin:6px 0;font-size:14px;letter-spacing:.5px}\n"
            "canvas{image-rendering:pixelated;image-rendering:crisp-edges}\n"
            "#ctrl{margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:center}\n"
            "button{padding:4px 14px;font:13px monospace;cursor:pointer;background:#222;color:#eee;border:1px solid #444;border-radius:3px}\n"
            "button:hover{background:#333}\n"
            "button.active{background:#060;border-color:#0a0}\n"
            "button.loop-on{background:#006;border-color:#00a}\n"
            "kbd{background:#222;padding:1px 5px;border-radius:2px;border:1px solid #444;font-size:12px}\n"
            "#hint{font-size:11px;color:#666;margin-top:4px}\n"
            "#mode-badge{display:inline-block;padding:2px 8px;border-radius:3px;font-weight:bold;margin:4px;font-size:12px;\n"
            "  background:" << badgeBg << ";color:" << badgeFg << "}\n"
            "</style>\n"
            "</head>\n"
            "<body>\n"
            "\n"
            "<div id=\"info\">Loading\xE2\x80\xA6</div>\n"
            "<div><span id=\"mode-badge\">" << modeUpper << " mode</span></div>\n"
            "<canvas id=\"c\" width=\"" << CANVAS_W << "\" height=\"" << CANVAS_H << "\"></canvas>\n"
            "<div id=\"ctrl\">\n"
            "  <button onclick=\"prev()\">\xE2\x97\x80</button>\n"
            "  <button onclick=\"togglePlay()\" id=\"bp\">\xE2\x96\xB6 Play</button>\n"
            "  <button onclick=\"next()\">\xE2\x96\xB6</button>\n"
            "  <button onclick=\"toggleLoop()\" id=\"bl\">\xF0\x9F\x94\x81 Loop</button>\n"
            "  <span style=\"margin-left:12px\">ms/frame:</span>\n"
            "  <button onclick=\"spd(50)\">50</button>\n"
            "  <button onclick=\"spd(100)\">100</button>\n"
            "  <button onclick=\"spd(200)\">200</button>\n"
            "  <button onclick=\"spd(300)\" id=\"s300\">300</button>\n"
            "  <button onclick=\"spd(500)\" id=\"s500\">500</button>\n"
            "  <button onclick=\"spd(1000)\">1000</button>\n"
            "</div>\n"
            "<div id=\"hint\"><kbd>\xE2\x86\x90</kbd> prev  <kbd>\xE2\x86\x92</kbd> next  <kbd>Space</kbd> play/pause  <kbd>L</kbd> loop  <kbd>Home</kbd> first  <kbd>End</kbd> last</div>\n"
            "\n"
            "<script>\n"
            "// \xE2\x94\x80\xE2\x94\x80 Embedded payload (base64) \xE2\x94\x80\xE2\x94\x80\n"
            "const B64=\"" << b64 << "\";\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Constants \xE2\x94\x80\xE2\x94\x80\n"
            "const BLK=" << BLOCK << ",COLS=" << COLS << ",ROWS=" << ROWS << ",BDR=" << BORDER << ";\n"
            "const BPF=" << BYTES_PER_FRAME << ";\n"
            "const MODE=" << MODE_ID << "; // 0=RGB, 1=Q4, 2=Q2\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Decode base64 \xE2\x86\x92 Uint8Array \xE2\x94\x80\xE2\x94\x80\n"
            "function b2u(s){const b=atob(s),u=new Uint8Array(b.length);for(let i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u}\n"
            "const data=b2u(B64);\n"
            "const TF=Math.ceil(data.length/BPF);\n"
            "\n"
            "let cur=0,playing=false,looping=true,timer=null,speed=" << DELAY << ";\n"
            "const cv=document.getElementById('c'),cx=cv.getContext('2d'),info=document.getElementById('info');\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Offscreen double buffer (avoids tearing during frame transitions) \xE2\x94\x80\xE2\x94\x80\n"
            "const offCv=document.createElement('canvas');\n"
            "offCv.width=cv.width;offCv.height=cv.height;\n"
            "const off=offCv.getContext('2d');\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 CRC-32 \xE2\x94\x80\xE2\x94\x80\n"
            "function crc32(buf){let c=0xFFFFFFFF;for(let i=0;i<buf.length;i++){c^=buf[i];for(let j=0;j<8;j++)c=(c>>>1)^(c&1?0xEDB88320:0)}return(c^0xFFFFFFFF)>>>0}\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Draw helpers \xE2\x94\x80\xE2\x94\x80\n"
            "function cell(c,r,R,G,B){off.fillStyle='rgb('+R+','+G+','+B+')';off.fillRect(BDR+c*BLK,BDR+r*BLK,BLK,BLK)}\n"
            "\n"
            "// Q4: encode 6-bit value as RGB (2 bits per channel, levels 0,85,170,255)\n"
            "function q4cell(c,r,val){\n"
            "  cell(c,r,((val>>4)&3)*85,((val>>2)&3)*85,(val&3)*85);\n"
            "}\n"
            "\n"
            "// Q2: encode 3-bit value as RGB (1 bit per channel, levels 0,255)\n"
            "function q2cell(c,r,val){\n"
            "  cell(c,r,((val>>2)&1)*255,((val>>1)&1)*255,(val&1)*255);\n"
            "}\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Draw one frame \xE2\x94\x80\xE2\x94\x80\n"
            "function draw(idx){\n"
            "  off.fillStyle='#000';off.fillRect(0,0,offCv.width,offCv.height);\n"
            "\n"
            "  // Sync border (alternating black / magenta cells)\n"
            "  for(let i=0;i<COLS+2;i++){\n"
            "    off.fillStyle=i%2?'#f0f':'#000';\n"
            "    off.fillRect(i*BLK,0,BLK,BDR);\n"
            "    off.fillRect(i*BLK,BDR+ROWS*BLK,BLK,BDR);\n"
            "  }\n"
            "  for(let j=0;j<ROWS;j++){\n"
            "    off.fillStyle=j%2?'#f0f':'#000';\n"
            "    off.fillRect(0,BDR+j*BLK,BDR,BLK);\n"
            "    off.fillRect(BDR+COLS*BLK,BDR+j*BLK,BDR,BLK);\n"
            "  }\n"
            "\n"
            "  // Frame payload slice\n"
            "  const s=idx*BPF, e=Math.min(s+BPF,data.length);\n"
            "  const fd=data.slice(s,e), dl=fd.length;\n"
            "  const chk=crc32(fd);\n"
            "\n"
            "  if(MODE===1){\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 Q4 HEADER \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    // Magic\n"
            "    q4cell(0,0," << Q4_MAGIC0_VAL << "); // (255,85,255)\n"
            "    q4cell(1,0," << Q4_MAGIC1_VAL << "); // (85,255,0)\n"
            "    // Frame index (18 bits \xE2\x86\x92 3 cells)\n"
            "    q4cell(2,0,(idx>>12)&0x3F);\n"
            "    q4cell(3,0,(idx>>6)&0x3F);\n"
            "    q4cell(4,0,idx&0x3F);\n"
            "    // Total frames (18 bits \xE2\x86\x92 3 cells)\n"
            "    q4cell(5,0,(TF>>12)&0x3F);\n"
            "    q4cell(6,0,(TF>>6)&0x3F);\n"
            "    q4cell(7,0,TF&0x3F);\n"
            "    // Data length this frame (18 bits \xE2\x86\x92 3 cells)\n"
            "    q4cell(8,0,(dl>>12)&0x3F);\n"
            "    q4cell(9,0,(dl>>6)&0x3F);\n"
            "    q4cell(10,0,dl&0x3F);\n"
            "    // CRC32 (32 bits \xE2\x86\x92 6 cells, MSB first)\n"
            "    q4cell(11,0,(chk>>>26)&0x3F);\n"
            "    q4cell(12,0,(chk>>>20)&0x3F);\n"
            "    q4cell(13,0,(chk>>>14)&0x3F);\n"
            "    q4cell(14,0,(chk>>>8)&0x3F);\n"
            "    q4cell(15,0,(chk>>>2)&0x3F);\n"
            "    q4cell(16,0,(chk&0x3)<<4);\n"
            "    // Grid dims: COLS (2 cells), ROWS (2 cells), block size (1 cell)\n"
            "    q4cell(17,0,(COLS>>6)&0x3F);\n"
            "    q4cell(18,0,COLS&0x3F);\n"
            "    q4cell(19,0,(ROWS>>6)&0x3F);\n"
            "    q4cell(20,0,ROWS&0x3F);\n"
            "    q4cell(21,0,BLK&0x3F);\n"
            "    // Mode marker\n"
            "    q4cell(22,0,1);\n"
            "    // Padding\n"
            "    for(let c=23;c<COLS;c++) q4cell(c,0,0);\n"
            "\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 Q4 DATA \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    // 4 cells \xE2\x86\x92 3 bytes (24 bits \xE2\x86\x92 4\xC3\x97" "6 bits)\n"
            "    let bi=0, ci=0;\n"
            "    const totalCells=COLS*(ROWS-1);\n"
            "    while(ci<totalCells){\n"
            "      const b0=bi<dl?fd[bi++]:0;\n"
            "      const b1=bi<dl?fd[bi++]:0;\n"
            "      const b2=bi<dl?fd[bi++]:0;\n"
            "      const v0=b0>>2;\n"
            "      const v1=((b0&3)<<4)|(b1>>4);\n"
            "      const v2=((b1&0xF)<<2)|(b2>>6);\n"
            "      const v3=b2&0x3F;\n"
            "      const vals=[v0,v1,v2,v3];\n"
            "      for(let k=0;k<4&&ci<totalCells;k++,ci++){\n"
            "        const r=Math.floor(ci/COLS)+1;\n"
            "        const c=ci%COLS;\n"
            "        q4cell(c,r,vals[k]);\n"
            "      }\n"
            "    }\n"
            "  } else if(MODE===2){\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 Q2 HEADER \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    // Q2: 3 bits/cell (1 bit per channel), values 0-7\n"
            "    function q2h(col,val){ q2cell(col,0,val); }\n"
            "\n"
            "    // Magic\n"
            "    q2h(0," << Q2_MAGIC0_VAL << "); // (255,0,255) magenta\n"
            "    q2h(1," << Q2_MAGIC1_VAL << "); // (255,255,0) yellow\n"
            "    // Frame index (18 bits \xE2\x86\x92 6 cells \xC3\x97" " 3 bits)\n"
            "    q2h(2,(idx>>15)&7); q2h(3,(idx>>12)&7); q2h(4,(idx>>9)&7);\n"
            "    q2h(5,(idx>>6)&7);  q2h(6,(idx>>3)&7);  q2h(7,idx&7);\n"
            "    // Total frames (18 bits \xE2\x86\x92 6 cells)\n"
            "    q2h(8,(TF>>15)&7);  q2h(9,(TF>>12)&7);  q2h(10,(TF>>9)&7);\n"
            "    q2h(11,(TF>>6)&7);  q2h(12,(TF>>3)&7);  q2h(13,TF&7);\n"
            "    // Data length (18 bits \xE2\x86\x92 6 cells)\n"
            "    q2h(14,(dl>>15)&7); q2h(15,(dl>>12)&7); q2h(16,(dl>>9)&7);\n"
            "    q2h(17,(dl>>6)&7);  q2h(18,(dl>>3)&7);  q2h(19,dl&7);\n"
            "    // CRC32 (32 bits \xE2\x86\x92 11 cells, 33 bits available, MSB first)\n"
            "    q2h(20,(chk>>>30)&7); q2h(21,(chk>>>27)&7); q2h(22,(chk>>>24)&7);\n"
            "    q2h(23,(chk>>>21)&7); q2h(24,(chk>>>18)&7); q2h(25,(chk>>>15)&7);\n"
            "    q2h(26,(chk>>>12)&7); q2h(27,(chk>>>9)&7);  q2h(28,(chk>>>6)&7);\n"
            "    q2h(29,(chk>>>3)&7);  q2h(30,chk&7);\n"
            "    // Grid dims: COLS (4 cells=12 bits), ROWS (4 cells), block (2 cells), mode (1 cell)\n"
            "    q2h(31,(COLS>>9)&7); q2h(32,(COLS>>6)&7); q2h(33,(COLS>>3)&7); q2h(34,COLS&7);\n"
            "    q2h(35,(ROWS>>9)&7); q2h(36,(ROWS>>6)&7); q2h(37,(ROWS>>3)&7); q2h(38,ROWS&7);\n"
            "    q2h(39,(BLK>>3)&7);  q2h(40,BLK&7);\n"
            "    q2h(41,2); // mode marker = 2\n"
            "    // Padding\n"
            "    for(let c=42;c<COLS;c++) q2h(c,0);\n"
            "\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 Q2 DATA \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    // 8 cells \xC3\x97" " 3 bits = 24 bits = 3 bytes\n"
            "    let bi=0, ci=0;\n"
            "    const totalCells=COLS*(ROWS-1);\n"
            "    while(ci<totalCells){\n"
            "      const b0=bi<dl?fd[bi++]:0;\n"
            "      const b1=bi<dl?fd[bi++]:0;\n"
            "      const b2=bi<dl?fd[bi++]:0;\n"
            "      // 24 bits \xE2\x86\x92 8 \xC3\x97" " 3-bit values\n"
            "      const v0=(b0>>5)&7;\n"
            "      const v1=(b0>>2)&7;\n"
            "      const v2=((b0&3)<<1)|(b1>>7);\n"
            "      const v3=(b1>>4)&7;\n"
            "      const v4=(b1>>1)&7;\n"
            "      const v5=((b1&1)<<2)|(b2>>6);\n"
            "      const v6=(b2>>3)&7;\n"
            "      const v7=b2&7;\n"
            "      const vals=[v0,v1,v2,v3,v4,v5,v6,v7];\n"
            "      for(let k=0;k<8&&ci<totalCells;k++,ci++){\n"
            "        const r=Math.floor(ci/COLS)+1;\n"
            "        const c=ci%COLS;\n"
            "        q2cell(c,r,vals[k]);\n"
            "      }\n"
            "    }\n"
            "  } else {\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 RGB HEADER (same as v1) \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    cell(0,0,0xDE,0xAD,0x01);\n"
            "    cell(1,0,0xBE,0xEF,0x02);\n"
            "    cell(2,0,(idx>>16)&0xFF,(idx>>8)&0xFF,idx&0xFF);\n"
            "    cell(3,0,(TF>>16)&0xFF,(TF>>8)&0xFF,TF&0xFF);\n"
            "    cell(4,0,(dl>>16)&0xFF,(dl>>8)&0xFF,dl&0xFF);\n"
            "    cell(5,0,(chk>>24)&0xFF,(chk>>16)&0xFF,(chk>>8)&0xFF);\n"
            "    cell(6,0,chk&0xFF,COLS&0xFF,ROWS&0xFF);\n"
            "    cell(7,0,BLK,0,0);\n"
            "    for(let c=8;c<COLS;c++) cell(c,0,0x80,0x80,0x80);\n"
            "\n"
            "    // \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90 RGB DATA \xE2\x95\x90\xE2\x95\x90\xE2\x95\x90\n"
            "    let bi=0;\n"
            "    for(let r=1;r<ROWS;r++){\n"
            "      for(let c=0;c<COLS;c++){\n"
            "        const R=bi<dl?fd[bi++]:0,G=bi<dl?fd[bi++]:0,B=bi<dl?fd[bi++]:0;\n"
            "        cell(c,r,R,G,B);\n"
            "      }\n"
            "    }\n"
            "  }\n"
            "\n"
            "  info.textContent='Frame '+(idx+1)+'/'+TF+'  |  '+dl+' B  |  CRC 0x'+chk.toString(16).toUpperCase().padStart(8,'0')+'  |  '+(MODE===2?'Q2':MODE===1?'Q4':'RGB')+'  |  Total '+(data.length/1048576).toFixed(2)+' MB';\n"
            "\n"
            "  // Atomic blit: copy completed frame to visible canvas in one operation\n"
            "  cx.drawImage(offCv,0,0);\n"
            "}\n"
            "\n"
            "// \xE2\x94\x80\xE2\x94\x80 Controls (rAF-synced playback) \xE2\x94\x80\xE2\x94\x80\n"
            "// rAF-synced: each frame survives at least one vsync before next swap.\n"
            "let rafId=null, lastFrameTime=0;\n"
            "\n"
            "function advance(){\n"
            "  if(cur>=TF-1){\n"
            "    if(looping){cur=0} else {togglePlay();return}\n"
            "  } else {cur++}\n"
            "  draw(cur);\n"
            "}\n"
            "\n"
            "function next(){advance()}\n"
            "function prev(){cur=Math.max(cur-1,0);draw(cur)}\n"
            "\n"
            "function playLoop(ts){\n"
            "  if(!playing) return;\n"
            "  if(ts-lastFrameTime>=speed){\n"
            "    advance();\n"
            "    lastFrameTime=ts;\n"
            "  }\n"
            "  rafId=requestAnimationFrame(playLoop);\n"
            "}\n"
            "\n"
            "function togglePlay(){\n"
            "  playing=!playing;\n"
            "  document.getElementById('bp').textContent=playing?'\xE2\x8F\xB8 Pause':'\xE2\x96\xB6 Play';\n"
            "  if(playing){\n"
            "    lastFrameTime=performance.now();\n"
            "    rafId=requestAnimationFrame(playLoop);\n"
            "  } else {\n"
            "    if(rafId){cancelAnimationFrame(rafId);rafId=null}\n"
            "  }\n"
            "}\n"
            "\n"
            "function toggleLoop(){\n"
            "  looping=!looping;\n"
            "  const bl=document.getElementById('bl');\n"
            "  bl.classList.toggle('loop-on',looping);\n"
            "  bl.textContent=looping?'\xF0\x9F\x94\x81 Loop ON':'\xF0\x9F\x94\x81 Loop OFF';\n"
            "}\n"
            "\n"
            "function spd(ms){\n"
            "  speed=ms;\n"
            "  document.querySelectorAll('#ctrl button.active').forEach(b=>{if(b.id!=='bl')b.classList.remove('active')});\n"
            "  event.target.classList.add('active');\n"
            "  // playLoop reads speed live, no restart needed\n"
            "}\n"
            "\n"
            "\n"
            "document.addEventListener('keydown',e=>{\n"
            "  if(e.key==='ArrowRight')next();\n"
            "  else if(e.key==='ArrowLeft')prev();\n"
            "  else if(e.key===' '){e.preventDefault();togglePlay()}\n"
            "  else if(e.key==='Home'){cur=0;draw(0)}\n"
            "  else if(e.key==='End'){cur=TF-1;draw(cur)}\n"
            "  else if(e.key==='l'||e.key==='L')toggleLoop();\n"
            "});\n"
            "\n"
            "// Auto-start loop indicator\n"
            "document.getElementById('bl').classList.add('loop-on');\n"
            "\n"
            "// Mark initial speed button as active\n"
            "const initBtn = document.getElementById('s' + speed);\n"
            "if (initBtn) initBtn.classList.add('active');\n"
            "\n"
            "draw(0);\n"
            "</script>\n"
            "</body>\n"
            "</html>";

    std::string htmlStr = html.str();

    // Ensure output directory exists
    fs::path outPath(OUTPUT);
    if (outPath.has_parent_path()) {
        fs::create_directories(outPath.parent_path());
    }

    {
        std::ofstream out(OUTPUT, std::ios::binary);
        if (!out) {
            std::cerr << "Error: cannot write to " << OUTPUT << "\n";
            return 1;
        }
        out.write(htmlStr.data(), static_cast<std::streamsize>(htmlStr.size()));
    }

    double outSizeMB = htmlStr.size() / 1048576.0;
    std::cout << "\n" << OUTPUT << "  (" << std::fixed;
    std::cout.precision(2);
    std::cout << outSizeMB << " MB)\n\n";
    std::cout << "Next steps:\n"
              << "  1. Open " << OUTPUT << " in the browser inside the VM\n"
              << "  2. Press Play + Loop (or Space + L)\n"
              << "  3. On the host, open host-decoder.html\n"
              << "  4. Click \"Start Capture\" and select the VM window\n"
              << "  5. Wait for 100% and download the file\n";

    return 0;
}
