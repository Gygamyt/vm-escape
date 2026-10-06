# vm-escape

Extract data from isolated VMs through visual side channels.

The VM has no network, no clipboard, no shared folders — but it has a screen.
**vm-escape** encodes any file as animated colored pixel grids on an HTML canvas inside the VM, then a decoder on the host captures the screen and reconstructs the original file.

Built for extracting Allure test reports from locked-down CI/CD VMs, but works with any data.

## How it works

```
┌─────────── VM (isolated) ───────────┐     ┌─────────── Host ───────────────┐
│                                     │     │                                │
│  file.tar.gz                        │     │  host-decoder.html             │
│       │                             │     │       │                        │
│       ▼                             │     │       ▼                        │
│  vm-encoder.js                      │     │  getDisplayMedia()             │
│       │                             │     │  (auto screen capture)         │
│       ▼                             │     │       │                        │
│  frames.html ──── screen ──────────────────►  decode pixel grid            │
│  (colored pixel grid,               │     │       │                        │
│   plays in browser)                 │     │       ▼                        │
│                                     │     │  file.tar.gz ✅                │
└─────────────────────────────────────┘     └────────────────────────────────┘
```

## Quick start

### Prerequisites

- **VM side:** Node.js (to run the encoder) + any browser (to display frames)
- **Host side:** Any modern browser with `getDisplayMedia` support (Chrome, Edge, Firefox)

### 1. Generate test data (optional)

```bash
# Generate dummy Allure reports for PoC testing
node scripts/generate-dummies.js --preset small

# Or all presets at once
node scripts/generate-dummies.js
```

### 2. Encode a file (inside the VM)

```bash
# Default Q4 mode — resilient to lossy screen capture
node src/encoder/vm-encoder.js dummies/allure-small.tar.gz

# RGB mode — higher throughput, but needs lossless screenshots
node src/encoder/vm-encoder.js dummies/allure-small.tar.gz --mode rgb

# Custom output path
node src/encoder/vm-encoder.js data.tar.gz --output my-frames.html
```

This produces `frames.html` — open it in the VM's browser.

### 3. Decode on the host

1. Open `src/decoder/host-decoder.html` in a browser on the host machine
2. Click **Start Capture**
3. Select the VM window (the browser showing `frames.html`)
4. The encoder auto-plays frames; the decoder auto-captures and decodes them
5. When the progress bar hits 100%, click **Download File**

That's it — you have your file on the host.

## Encoding modes

| Mode | Bits/cell | Throughput/frame | Use case |
|------|-----------|-----------------|----------|
| **Q4** (default) | 6 bits | ~9.1 KB | Lossy capture via `getDisplayMedia`, video streams, screen recordings. Color levels are spaced 85 units apart (0, 85, 170, 255), surviving compression artifacts. |
| **RGB** | 24 bits | ~36.4 KB | Lossless PNG screenshots only. 4x faster but breaks if any pixel value shifts. |

## Encoder options

```
node src/encoder/vm-encoder.js <file> [options]

Options:
  --mode q4|rgb       Encoding mode (default: q4)
  --block N           Pixel block size in px (default: 8)
  --output FILE       Output HTML path (default: frames.html)
  --help              Show detailed help
```

## Decoder features

- **Auto-capture** via `getDisplayMedia` — no manual screenshots needed
- **Auto-detection** of Q4 vs RGB mode
- **CRC32 per-frame verification** with automatic retry/refinement
- **Manual fallback** — drag & drop / Ctrl+V / file picker for individual screenshots
- **Adjustable tolerance** for lossy captures (±3 for PNG, ±10–35 for video)

## Project structure

```
vm-escape/
├── src/
│   ├── encoder/
│   │   └── vm-encoder.js       # CLI encoder (runs inside VM)
│   └── decoder/
│       └── host-decoder.html   # Browser decoder (runs on host)
├── scripts/
│   └── generate-dummies.js     # Test data generator for PoC demos
├── package.json
├── LICENSE
└── README.md
```

## Dummy data generator

Generate realistic test payloads for PoC demos:

```bash
node scripts/generate-dummies.js --help       # show presets and options
node scripts/generate-dummies.js --preset tiny # 10 KB — smoke test
node scripts/generate-dummies.js --preset small # 50 KB — mini Allure report
node scripts/generate-dummies.js              # all presets (tiny → xlarge)
```

| Preset | Raw size | Q4 frames | Est. time (Q4) |
|--------|----------|-----------|-----------------|
| tiny | 10 KB | 1-2 | ~1 sec |
| small | 50 KB | ~6 | ~3 sec |
| medium | 500 KB | ~54 | ~27 sec |
| large | 5 MB | ~540 | ~5 min |
| xlarge | 50 MB | ~5400 | ~45 min |

## Technical details

- Grid: 148×85 cells, 8px blocks, canvas 1200×696
- Q4 encoding: 3 bytes packed into 4 cells (4 × 6-bit values)
- Frame header: magic pattern + frame index + total frames + data length + CRC32
- Auto gzip compression if input isn't already gzipped
- Pure Node.js with zero dependencies

## License

MIT — see [LICENSE](LICENSE)
