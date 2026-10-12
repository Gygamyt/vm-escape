# Nested VMs — Signal Degradation and Q2 Mode

## The problem

When you run a VM inside another VM (nested virtualization), the video signal passes through **two layers** of screen capture compression. Each layer adds:

- **Chroma subsampling** (4:2:0) — color resolution is halved in each direction
- **Codec quantization** — lossy compression rounds pixel values
- **Gaussian noise** — random per-pixel errors from encoding artifacts
- **Scaling artifacts** — when display resolution doesn't match 1:1

In a single VM, the default **Q4** mode handles all of this fine. But in nested VMs, the cumulative degradation can push Q4 past its error margin.

## Q4 vs Q2: when to switch

| Scenario                                     | Recommended mode | Why                                   |
|----------------------------------------------|------------------|---------------------------------------|
| Single VM, screen shared via getDisplayMedia | **Q4** (default) | Survives chroma + codec easily        |
| Single VM, recorded to video file            | **Q4**           | Video compression is within tolerance |
| VM inside VM (nested)                        | **Q2**           | Double compression, noise adds up     |
| VM inside VM with display scaling            | **Q2**           | Scaling + double compression          |
| Lossless PNG screenshots (no video)          | **RGB**          | No compression = maximum throughput   |

## How the modes differ

**Q4** uses 4 color levels per channel: `0, 85, 170, 255`. Each cell carries 6 bits. The spacing of 85 between levels gives a ±42 error margin — enough for one round of compression, but not two.

**Q2** uses 2 color levels per channel: `0, 255`. Each cell carries 3 bits. The spacing of 255 between levels gives a ±127 error margin — massive. This survives extreme noise that destroys Q4.

**RGB** uses the full 256 levels per channel: 24 bits per cell. Zero error margin — any pixel shift breaks it. Use only with lossless screenshots.

## Degradation test results

The test harness (`npm test`) simulates video quality loss and checks decoding accuracy:

| Preset             | Description                                    | Q4       | Q2       |
|--------------------|------------------------------------------------|----------|----------|
| `single-vm`        | Chroma 4:2:0 + QP 23                           | **PASS** | **PASS** |
| `nested-vm`        | Double chroma + QP 30 + noise σ=5              | **PASS** | **PASS** |
| `nested-vm-scaled` | Double chroma + QP 30 + noise σ=5 + 0.9× scale | **PASS** | **PASS** |
| `worst-case`       | Double chroma + QP 30 + noise σ=15             | **FAIL** | **PASS** |
| `chroma-only`      | Single chroma pass                             | **PASS** | **PASS** |
| `double-chroma`    | Two chroma passes                              | **PASS** | **PASS** |

### Noise breakpoints

- **Q4** breaks at gaussian noise **σ ≥ 10**
- **Q2** survives to **σ = 30+** with zero crossings up to σ = 24

## How to use Q2

Just add `--mode q2` to any encoder:

```bash
node src/encoder/node/vm-encoder.js myfile.json --mode q2
java src/encoder/java/VmEncoder.java myfile.json --mode q2
python3 src/encoder/python/vm_encoder.py myfile.json --mode q2
dotnet run src/encoder/csharp/VmEncoder.cs -- myfile.json --mode q2
go run src/encoder/go/vm_encoder.go myfile.json --mode q2
./vm_encoder myfile.json --mode q2                    # C++
```

The decoder auto-detects the mode — no changes needed on the host side.

**Trade-off:** Q2 is half the bitrate of Q4 (~4.6 KB/frame vs ~9.1 KB/frame), so transfers take roughly twice as long. Use Q4 when you can, Q2 when you must.

## Running the degradation tests

```bash
npm test                                           # all presets side-by-side
npm run test:sweep                                 # find exact breakpoint thresholds
node tests/test-degradation.js --preset nested-vm  # single preset
node tests/test-degradation.js --verbose           # per-channel breakdown
```

## Why 8px blocks matter

The encoder uses 8×8 pixel blocks for each cell. The decoder reads only the **center pixel** of each block. This means compression artifacts at block edges — which is where chroma subsampling and codec quantization hit hardest — are ignored entirely. The 8px block size provides the margin that makes both Q4 and Q2 robust.
