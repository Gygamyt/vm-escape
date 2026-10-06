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

## Quick start

> **TL;DR version:** see [QUICKSTART.md](QUICKSTART.md) — the whole flow in 30 seconds.

### Prerequisites

- **VM side:** Node.js + any browser
- **Host side:** Chrome / Edge / Firefox with `getDisplayMedia` support

### 1. Encode a file (inside the VM)

Copy the project (or just `src/encoder/vm-encoder.js`) into the VM, then:

```bash
# Encode any file — it gets gzipped automatically if needed
node src/encoder/vm-encoder.js myfile.json

# With custom speed (ms between frames, default 300)
node src/encoder/vm-encoder.js report.tar.gz --delay 100

# Custom output path
node src/encoder/vm-encoder.js data.tar.gz --output my-frames.html
```

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

| Mode | Bits/cell | Throughput/frame | Use case |
|------|-----------|-----------------|----------|
| **Q4** (default) | 6 bits | ~9.1 KB | Lossy capture — getDisplayMedia, video streams, screen recordings. Color levels spaced 85 apart (0, 85, 170, 255), survives compression. |
| **RGB** | 24 bits | ~36.4 KB | Lossless PNG screenshots only. 4× faster but breaks if any pixel shifts. |

## Encoder options

```
node src/encoder/vm-encoder.js <file> [options]

  --mode q4|rgb       Encoding mode (default: q4)
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
- **Auto-detection** of Q4 vs RGB mode from the first captured frame
- **CRC32 verification** per frame with automatic retry
- **Manual fallback** — drag & drop / Ctrl+V / file picker for screenshots
- **Adjustable capture rate** and tolerance

## Project structure

```
vm-escape/
├── src/
│   ├── encoder/
│   │   └── vm-encoder.js         # CLI encoder (runs inside VM)
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
├── input_files/                  # Put your files here to encode
├── QUICKSTART.md                 # TL;DR setup guide
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

- **Grid:** 148×85 cells, 8px blocks, canvas 1200×696
- **Q4 encoding:** 3 bytes → 4 cells (4 × 6-bit values via color levels 0/85/170/255)
- **Frame header:** magic pattern + frame index + total frames + data length + CRC32
- **Capture:** `requestVideoFrameCallback` for frame-precise grabs (falls back to jittered `setTimeout` polling)
- **Rendering:** double-buffered offscreen canvas + `requestAnimationFrame`
- **Download:** auto-decompresses gzip, detects tar (ustar magic) / JSON / XML / ZIP / PDF / text
- **Compression:** encoder auto-gzips any non-gzipped input
- **Zero dependencies** — pure Node.js encoder, vanilla JS decoder

## Notes

- **Tested on files up to ~100 MB.** Larger files will produce thousands of frames and may take a long time. Stability at scale (10k+ frames) is not guaranteed — YMMV.
- **The encoder is currently Node.js only**, but the encoding format is simple enough to implement in any language the VM supports (Python, C#, PowerShell, etc). Alternative encoder implementations are planned.
- **The decoder is a standalone HTML file** with zero dependencies — it runs in any modern browser, no build step or server needed.
- **Capture quality depends on your screen sharing setup.** For best results, share the VM window (not the whole screen), keep the encoder browser tab in focus and fully visible, and avoid overlapping windows.

## License

MIT — see [LICENSE](LICENSE)
