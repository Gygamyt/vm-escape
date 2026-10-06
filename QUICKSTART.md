# vm-escape — Quick Start

## What is this?

You have a VM with no network/clipboard/shared folders. You need a file out of it.
This tool encodes any file as blinking colored pixels → you screen-capture it on the host → the decoder reconstructs the file.

## Step 1: Encode (inside the VM)

```bash
node src/encoder/vm-encoder.js YOUR_FILE
```

A browser page opens with colored pixel noise. Let it play.

**Examples:**
```bash
node src/encoder/vm-encoder.js report.json
node src/encoder/vm-encoder.js results.tar.gz
node src/encoder/vm-encoder.js dummies/dummy.json        # test with a dummy
```

**Speed up** with `--delay`:
```bash
node src/encoder/vm-encoder.js report.json --delay 100   # faster (default 300ms)
```

## Step 2: Decode (on the host machine)

1. Open `src/decoder/host-decoder.html` in Chrome/Edge
2. Hit **Start Capture**
3. Pick the VM window from the share dialog
4. Wait for the progress bar to fill up (it auto-stops)
5. Hit **Download**

Done. The file lands in your Downloads folder.

## That's it

- Works with **any file** — JSON, tar.gz, XML, PDF, text, binary
- The output file gets the **right extension** automatically
- **No installation, no dependencies** on the host side — just open the HTML
- On the VM side, you just need Node.js

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Frames decoding slowly | Lower the delay: `--delay 100` or `--delay 50` |
| "No grid detected" misses | The capture is between frame transitions — they get retried, don't worry |
| Download is wrong format | Make sure you refreshed the decoder page (Ctrl+Shift+R) |
| Encoder too fast for decoder | Increase delay: `--delay 500` |

## File sizes → time estimate (Q4 mode, 300ms delay)

| File size | Frames | Time |
|-----------|--------|------|
| 10 KB | ~2 | ~1 sec |
| 100 KB | ~11 | ~6 sec |
| 1 MB | ~108 | ~1 min |
| 10 MB | ~1,076 | ~6 min |
| 50 MB | ~5,380 | ~27 min |
