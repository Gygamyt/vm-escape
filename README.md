# vm-escape

Extract data from isolated VMs through visual side channels.

The VM has no network, no clipboard, no shared folders — but it has a screen.
**vm-escape** encodes any file as animated colored pixel grids on an HTML canvas inside the VM, then a decoder on the host captures the screen and reconstructs the original file.

Built for extracting Allure test reports from locked-down CI/CD VMs, but works with any data — tar archives, JSON, text, PDFs, whatever.

## How it works

```
┌─────────── VM (isolated) ───────────┐     ┌─────────── Host ───────────────┐
│                                     │     │                                │
│  any file (json, tar.gz, ...)       │     │  host-decoder.html             │
│       │                             │     │       │                        │
│       ▼                             │     │       ▼                        │
│  vm-encoder.js                      │     │  getDisplayMedia()             │
│       │  (auto-gzip + Q4 encode)    │     │  (auto screen capture)         │
│       ▼                             │     │       │                        │
│  frames.html ──── screen ──────────────────►  decode pixel grid            │
│  (colored pixel grid,               │     │       │                        │
│   plays in browser)                 │     │       ▼                        │
│                                     │     │  original file ✅              │
└─────────────────────────────────────┘     └────────────────────────────────┘
```

## Documentation

| Document | Description |
|----------|-------------|
| [Quick Start](docs/quickstart.md) | Get running in 30 seconds |
| [Encoder Reference](docs/encoders.md) | Build & run instructions for all 6 languages |
| [Decoder Guide](docs/decoder.md) | Host-side decoder setup and tips |
| [Nested VMs](docs/nested-vms.md) | Q2 mode, signal degradation, and test results |
| [Technical Details](docs/technical.md) | Encoding format, grid geometry, pipelines |

## Quick start

> **TL;DR version:** see [Quick Start](docs/quickstart.md) — the whole flow in 30 seconds.

### Prerequisites

- **VM side:** Any ONE of: Node.js, Java 17+, Python 3.6+, .NET 6+ (C#), C++17 (g++/clang++), or Go 1.18+ + any browser
- **Host side:** Chrome / Edge / Firefox with `getDisplayMedia` support

### 1. Encode a file (inside the VM)

Copy the encoder into the VM — use whichever runtime is available:

**Node.js:**
```bash
node src/encoder/node/vm-encoder.js myfile.json
```

**Java 17+:**
```bash
java src/encoder/java/VmEncoder.java myfile.json
```

**Python 3.6+:**
```bash
python3 src/encoder/python/vm_encoder.py myfile.json
```

**C# (.NET 6+):**
```bash
dotnet run src/encoder/csharp/VmEncoder.cs -- myfile.json
```

**C++17** (compile once, then run):
```bash
g++ -std=c++17 -O2 -o vm_encoder src/encoder/cpp/vm_encoder.cpp -lz
./vm_encoder myfile.json
```

**Go:**
```bash
go run src/encoder/go/vm_encoder.go myfile.json
```

All six produce identical HTML output. Use `--output FILE` for a custom path (default: `tmp/frames.html`).

This produces `tmp/frames.html` — open it in the VM's browser. It starts playing automatically.

### 2. Decode on the host

1. Open `src/decoder/host-decoder.html` in a browser on the host
2. Click **Start Capture** → select the VM window
3. Frames decode automatically. Progress bar shows how many are left
4. When done (or auto-stopped), click **Download**

The decoder detects the file type and names the output accordingly (`decoded.json`, `decoded.tar.gz`, `decoded.xml`, etc).

### 3. Test with dummy data

```bash
# Pre-built dummies are in dummies/
node src/encoder/vm-encoder.js dummies/dummy.json          # ~90 KB JSON
node src/encoder/vm-encoder.js dummies/allure-small.tar.gz # ~24 KB tar

# Or generate fresh ones:
node scripts/generate-dummies.js --preset small
```

## Encoding modes

| Mode             | Bits/cell | Throughput/frame | Use case                                                                                                                                                                        |
|------------------|-----------|------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| **Q4** (default) | 6 bits    | ~9.1 KB          | Lossy capture — getDisplayMedia, video streams, screen recordings. Color levels spaced 85 apart (0, 85, 170, 255), survives compression.                                        |
| **Q2**           | 3 bits    | ~4.6 KB          | Ultra-robust for nested VMs (VM inside VM). Only 2 color levels (0, 255), survives extreme noise (σ≤30) where Q4 breaks at σ≥10. Half the bitrate of Q4 but far more resilient. |
| **RGB**          | 24 bits   | ~36.4 KB         | Lossless PNG screenshots only. 4× faster but breaks if any pixel shifts.                                                                                                        |

## Encoder options

```
node src/encoder/node/vm-encoder.js <file> [options]
java src/encoder/java/VmEncoder.java <file> [options]
python3 src/encoder/python/vm_encoder.py <file> [options]
dotnet run src/encoder/csharp/VmEncoder.cs -- <file> [options]
./vm_encoder <file> [options]                           # C++ (compile first)
go run src/encoder/go/vm_encoder.go <file> [options]

  --mode q4|q2|rgb    Encoding mode (default: q4)
  --block N           Block size in px (default: 8)
  --delay N           Frame interval in ms (default: 300, min 50)
  --output FILE       Output HTML path (default: tmp/frames.html)
  --help              Show help
```

The encoder UI has speed buttons (50–1000ms) and play/pause. It uses **double-buffered rendering** with `requestAnimationFrame` for tear-free display.

## Decoder features

- **Auto-capture** via `getDisplayMedia` — no manual screenshots
- **Smart frame detection** — uses `requestVideoFrameCallback` to grab only when the video frame changes, with header pixel-signature diffing to skip unchanged frames
- **Stale auto-stop** — stops capturing automatically when the encoder finishes (no new frames for a while)
- **Auto file type detection** on download — decompresses gzip, sniffs content (tar/JSON/XML/ZIP/PDF/text), names the file correctly
- **Auto-detection** of Q4, Q2, and RGB modes from the first captured frame
- **CRC32 verification** per frame with automatic retry
- **Manual fallback** — drag & drop / Ctrl+V / file picker for screenshots
- **Adjustable capture rate** and tolerance

## Project structure

```
vm-escape/
├── src/
│   ├── encoder/
│   │   ├── node/
│   │   │   └── vm-encoder.js     # Node.js CLI encoder
│   │   ├── java/
│   │   │   └── VmEncoder.java    # Java 17+ CLI encoder
│   │   ├── python/
│   │   │   └── vm_encoder.py     # Python 3.6+ CLI encoder
│   │   ├── csharp/
│   │   │   └── VmEncoder.cs      # C# (.NET 6+) CLI encoder
│   │   ├── cpp/
│   │   │   └── vm_encoder.cpp    # C++17 CLI encoder
│   │   └── go/
│   │       └── vm_encoder.go     # Go CLI encoder
│   └── decoder/
│       └── host-decoder.html     # Browser decoder (runs on host)
├── scripts/
│   └── generate-dummies.js       # Test data generator
├── dummies/                      # Pre-built test payloads
│   ├── dummy.json                # ~90 KB fake test report
│   ├── allure-tiny.tar.gz        # 2.5 KB
│   ├── allure-small.tar.gz       # 24 KB
│   ├── allure-medium.tar.gz      # 151 KB
│   └── allure-custom.tar.gz      # 743 KB
├── tests/                         # Degradation simulation & test harness
│   ├── degrade.js                # Video degradation functions (chroma, codec, noise)
│   └── test-degradation.js       # CLI test runner with presets & sweeps
├── docs/                          # Documentation
│   ├── quickstart.md             # TL;DR setup guide
│   ├── encoders.md               # Per-language encoder reference
│   ├── decoder.md                # Host decoder guide
│   ├── nested-vms.md             # Nested VM notes & Q2 mode
│   └── technical.md              # Encoding format & internals
├── input_files/                  # Put your files here to encode
├── package.json
├── LICENSE
└── README.md
```

## Dummy data

Pre-built test files sit in `dummies/`. To generate fresh ones:

```bash
node scripts/generate-dummies.js --help         # show presets
node scripts/generate-dummies.js --preset tiny   # 10 KB smoke test
node scripts/generate-dummies.js --preset small  # 50 KB mini report
node scripts/generate-dummies.js                 # all presets at once
```

## Technical details

## Degradation testing

Test harness simulates video quality loss from nested virtualization (VM inside VM).
It generates synthetic Q4 and Q2 frames, applies configurable degradation (chroma subsampling,
codec quantization, noise, scaling artifacts), and checks if the decoder can still read them.

```bash
npm test                                           # run all presets (Q4 + Q2 side-by-side)
npm run test:sweep                                 # find exact breakpoint thresholds
node tests/test-degradation.js --preset nested-vm  # single preset
node tests/test-degradation.js --verbose           # per-channel breakdown
```

Built-in presets: `single-vm`, `nested-vm`, `nested-vm-scaled`, `worst-case`, `chroma-only`, `double-chroma`.

Key findings:
- Both Q4 and Q2 survive chroma subsampling and codec compression (even QP=30)
- Q4 breaks at gaussian noise σ≥10, while Q2 survives to σ=30+ with zero crossings up to σ=24
- Q2 is the recommended mode for nested VMs where signal quality is severely degraded
- The 8px block center-sampling provides the margin for both modes

- **Grid:** 148×85 cells, 8px blocks, canvas 1200×696
- **Q4 encoding:** 3 bytes → 4 cells (4 × 6-bit values via color levels 0/85/170/255)
- **Frame header:** magic pattern + frame index + total frames + data length + CRC32
- **Capture:** `requestVideoFrameCallback` for frame-precise grabs (falls back to jittered `setTimeout` polling)
- **Rendering:** double-buffered offscreen canvas + `requestAnimationFrame`
- **Download:** auto-decompresses gzip, detects tar (ustar magic) / JSON / XML / ZIP / PDF / text
- **Compression:** encoder auto-gzips any non-gzipped input
- **Zero dependencies** — each encoder is a single file with no external packages (C++ needs only zlib), vanilla JS decoder

## Notes

- **Tested on files up to ~100 MB.** Larger files will produce thousands of frames and may take a long time. Stability at scale (10k+ frames) is not guaranteed — YMMV.
- **Six encoder implementations:** Node.js, Java, Python, C#, C++, and Go. All produce identical output. Use whichever runtime your VM has.
- **The decoder is a standalone HTML file** with zero dependencies — it runs in any modern browser, no build step or server needed.
- **Capture quality depends on your screen sharing setup.** For best results, share the VM window (not the whole screen), keep the encoder browser tab in focus and fully visible, and avoid overlapping windows.

## License

MIT — see [LICENSE](LICENSE)
