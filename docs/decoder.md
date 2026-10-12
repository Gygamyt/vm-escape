# Decoder Guide

The decoder is a single HTML file (`src/decoder/host-decoder.html`) that runs on the **host machine** — the computer that can see the VM's screen.

## Setup

No installation needed. Just open the file in a modern browser:

```
Chrome / Edge / Firefox — any with getDisplayMedia support
```

Double-click `host-decoder.html` or serve it from any local HTTP server. No build step, no dependencies.

## Usage

### Screen capture mode (recommended)

1. Start the encoder inside the VM (the pixel grid should be playing)
2. Open `host-decoder.html` on the host
3. Click **Start Capture**
4. In the share dialog, select the **VM window** (not the whole screen)
5. Watch the progress bar — frames decode automatically
6. When complete (auto-stops), click **Download**

### Manual mode (fallback)

If `getDisplayMedia` doesn't work in your browser:

- **Drag & drop** a screenshot of the encoder output onto the decoder page
- **Ctrl+V** (Cmd+V) to paste a screenshot from clipboard
- **Choose file** to pick a screenshot file

Each screenshot decodes one frame. Repeat for all frames.

## Tips for best results

- **Share the VM window, not the whole screen** — this gives the cleanest capture with minimal scaling
- **Keep the encoder browser tab in focus** and fully visible inside the VM
- **Don't overlap other windows** on top of the encoder
- **Match display scaling** — if possible, set VM display to 100% scaling (no DPI scaling)
- **Use a lower delay** (`--delay 100` or `--delay 50`) for faster transfers, but increase it (`--delay 500`) if you see CRC errors

## What the decoder does automatically

- **Detects the encoding mode** (Q4, Q2, or RGB) from magic pixels
- **Skips duplicate frames** by diffing header pixels between captures
- **Verifies every frame** with CRC32 and retries on mismatch
- **Auto-stops** when the encoder finishes (no new frames for a while)
- **Decompresses** gzip on download
- **Names the file correctly** — detects tar, JSON, XML, ZIP, PDF, or text

## Troubleshooting

| Problem                          | Solution                                                            |
|----------------------------------|---------------------------------------------------------------------|
| "No grid detected"               | Normal during frame transitions — the decoder retries automatically |
| High CRC error rate              | Increase encoder delay (`--delay 500`), or switch to Q2 mode        |
| Decoder doesn't auto-stop        | The encoder may still be playing — wait, or stop manually           |
| Wrong file extension on download | Hard-refresh the decoder page (Ctrl+Shift+R) and try again          |
| Black/blank capture              | Make sure you selected the correct window in the share dialog       |
| "getDisplayMedia not supported"  | Use Chrome or Edge; Firefox may need a flag. Or use manual mode     |
