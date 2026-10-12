# Technical Details

## Encoding format

### Grid geometry

| Parameter       | Value   |
|-----------------|---------|
| Columns         | 148     |
| Rows            | 85      |
| Block size      | 8 px    |
| Border          | 8 px    |
| Canvas width    | 1200 px |
| Canvas height   | 696 px  |
| Cells per frame | 12,580  |

Each cell is an 8×8 pixel block of a single solid color. The decoder reads only the **center pixel** of each block, which provides margin against compression artifacts at block edges.

### Encoding modes

**Q4 (quantized 4-level)**
- Color levels: `0, 85, 170, 255` (4 values per channel)
- Bits per cell: 6 (2 bits × 3 channels)
- Packing: 3 bytes → 4 cells (each byte split into four 6-bit values)
- Bytes per frame: 9,324
- MODE_ID: 1

**Q2 (quantized 2-level)**
- Color levels: `0, 255` (2 values per channel)
- Bits per cell: 3 (1 bit × 3 channels)
- Packing: 3 bytes → 8 cells (each bit → one channel)
- Bytes per frame: 4,662
- MODE_ID: 2

**RGB (raw)**
- Color levels: full 0–255 range
- Bits per cell: 24 (8 bits × 3 channels)
- Packing: 3 bytes → 1 cell
- Bytes per frame: 37,296
- MODE_ID: 0

### Frame structure

Each frame contains a header followed by data cells:

```
[MAGIC0] [MAGIC1] [frame_index: 3 cells] [total_frames: 3 cells] [data_length: 4 cells] [crc32: 4 cells] [data cells...]
```

**Magic pixels** (top-left corner, mode-dependent):

| Mode | MAGIC0                                  | MAGIC1                                 |
|------|-----------------------------------------|----------------------------------------|
| Q4   | cell value 55 → RGB(255, 85, 255)       | cell value 28 → RGB(85, 255, 0)        |
| Q2   | cell value 5 → RGB(255, 0, 255) magenta | cell value 6 → RGB(255, 255, 0) yellow |
| RGB  | `0x76` `0x6D` `0x01` → RGB(118, 109, 1) | (embedded in 3-byte sequence)          |

The decoder identifies the encoding mode by reading the magic pixels from the first captured frame.

### CRC32 verification

Every frame includes a CRC32 checksum of its data payload. The decoder verifies each frame and automatically retries (re-captures) frames with CRC mismatches.

### Compression

The encoder automatically gzip-compresses any non-gzipped input before encoding. This means:

- Already-gzipped files (`.tar.gz`, `.gz`) are encoded as-is
- Everything else is gzipped first to reduce frame count
- The decoder auto-decompresses on download

## Encoder pipeline

```
input file/directory
    │
    ├── directory? → tar pack → .tar.gz
    ├── already gzipped? → use as-is
    └── file? → gzip compress
    │
    ▼
compressed bytes
    │
    ▼
split into frames (bytesPerFrame per mode)
    │
    ▼
for each frame:
    ├── calculate CRC32
    ├── build header (magic + index + total + length + crc)
    └── encode cells (mode-specific quantization)
    │
    ▼
base64-encode all frame data
    │
    ▼
embed into HTML template with JavaScript player
    │
    ▼
tmp/frames.html (self-contained, opens in browser)
```

## Decoder pipeline

```
getDisplayMedia() screen capture
    │
    ▼
requestVideoFrameCallback / setTimeout polling
    │
    ▼
for each video frame:
    ├── read center pixel of each 8×8 block
    ├── detect mode from magic pixels
    ├── dequantize → raw bytes
    ├── extract header (index, total, length, crc)
    ├── verify CRC32
    └── store frame (or retry on CRC mismatch)
    │
    ▼
all frames collected → concatenate data
    │
    ▼
auto-decompress gzip
    │
    ▼
detect file type:
    ├── tar magic ("ustar") → .tar.gz
    ├── JSON (starts with { or [) → .json
    ├── XML (starts with <) → .xml
    ├── ZIP (PK magic) → .zip
    ├── PDF (%PDF magic) → .pdf
    └── fallback → .txt
    │
    ▼
download with correct filename and extension
```

## Decoder features

### Smart frame detection

The decoder uses `requestVideoFrameCallback` (where available) to grab frames only when the video actually changes. It also diffs the header pixels between frames to skip re-captures of the same frame. Falls back to jittered `setTimeout` polling on browsers that don't support `requestVideoFrameCallback`.

### Auto-stop

When no new frames are captured for a configurable stale period, the decoder stops automatically. This means you don't need to manually stop capture — the encoder finishes, the decoder notices, and stops.

### Manual fallback

If `getDisplayMedia` isn't available or doesn't work, the decoder supports:

- **Drag & drop** screenshots onto the page
- **Ctrl+V** to paste screenshots from clipboard
- **File picker** to select screenshot files

### Double-buffered rendering

The encoder uses two offscreen canvases and swaps them with `requestAnimationFrame` for tear-free display. This prevents the decoder from capturing a partially-rendered frame.

## Performance characteristics

### Throughput by mode

| Mode | Bytes/frame | Frame at 300ms delay | Frame at 50ms delay |
|------|-------------|----------------------|---------------------|
| Q4   | 9,324       | ~31 KB/s             | ~186 KB/s           |
| Q2   | 4,662       | ~15 KB/s             | ~93 KB/s            |
| RGB  | 37,296      | ~124 KB/s            | ~745 KB/s           |

### Estimated transfer times (Q4, 300ms delay)

| File size | Frames | Time    |
|-----------|--------|---------|
| 10 KB     | ~2     | ~1 sec  |
| 100 KB    | ~11    | ~6 sec  |
| 1 MB      | ~108   | ~1 min  |
| 10 MB     | ~1,076 | ~6 min  |
| 50 MB     | ~5,380 | ~27 min |

Note: actual times may vary depending on screen capture quality, decoder processing speed, and CRC retry rate.
