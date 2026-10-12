# Encoder Reference — All Languages

All six encoders accept the same CLI arguments and produce **identical HTML output**. Pick whichever runtime your VM has.

## Common options

```
<encoder> <file> [options]

  --mode q4|q2|rgb    Encoding mode (default: q4)
  --block N           Block size in px (default: 8)
  --delay N           Frame interval in ms (default: 300, min 50)
  --output FILE       Output HTML path (default: tmp/frames.html)
  --help              Show help
```

If `<file>` is a directory, the encoder packs it into a tar archive automatically.

---

## Node.js

**Requirements:** Node.js (any recent version)

**Run:**
```bash
node src/encoder/node/vm-encoder.js <file> [options]
```

**Examples:**
```bash
node src/encoder/node/vm-encoder.js report.json
node src/encoder/node/vm-encoder.js results/ --delay 100
node src/encoder/node/vm-encoder.js archive.tar.gz --mode q2 --output out.html
```

**Notes:** This is the reference implementation. Zero dependencies — uses only Node.js built-ins (`fs`, `zlib`, `path`, `child_process`). Opens the generated HTML in the default browser automatically.

---

## Java

**Requirements:** Java 17+ (single-file execution via `java` command)

**Run:**
```bash
java src/encoder/java/VmEncoder.java <file> [options]
```

**Examples:**
```bash
java src/encoder/java/VmEncoder.java report.json
java src/encoder/java/VmEncoder.java results/ --delay 100
java src/encoder/java/VmEncoder.java archive.tar.gz --mode q2
```

**Notes:** Single-file source-code execution (no compilation step needed with Java 17+). Zero dependencies — uses only `java.util`, `java.io`, `java.nio`, `java.util.zip`. Opens the generated HTML via `Desktop.browse()`.

---

## Python

**Requirements:** Python 3.6+

**Run:**
```bash
python3 src/encoder/python/vm_encoder.py <file> [options]
```

**Examples:**
```bash
python3 src/encoder/python/vm_encoder.py report.json
python3 src/encoder/python/vm_encoder.py results/ --delay 100
python3 src/encoder/python/vm_encoder.py archive.tar.gz --mode q2
```

**Notes:** Zero dependencies — uses only the standard library (`gzip`, `tarfile`, `base64`, `struct`, `argparse`, etc.). Opens the generated HTML via `webbrowser.open()`. Works on Python 3.6+ (uses f-strings).

---

## C# (.NET)

**Requirements:** .NET 6+ SDK

**Build and run:**
```bash
# Option 1: dotnet run (from the csharp directory)
cd src/encoder/csharp
dotnet run -- <file> [options]

# Option 2: dotnet run with project path
dotnet run --project src/encoder/csharp/VmEncoder.csproj -- <file> [options]
```

**Examples:**
```bash
dotnet run --project src/encoder/csharp/VmEncoder.csproj -- report.json
dotnet run --project src/encoder/csharp/VmEncoder.csproj -- results/ --delay 100
dotnet run --project src/encoder/csharp/VmEncoder.csproj -- archive.tar.gz --mode q2
```

**Notes:** Single `.cs` file + `.csproj` for the `dotnet` CLI. Zero NuGet dependencies — uses only `System.IO.Compression`, `System.Security.Cryptography`, etc. Opens the generated HTML via `Process.Start`. Also works with Mono: `mcs VmEncoder.cs && mono VmEncoder.exe <file>`.

---

## C++

**Requirements:** C++17 compiler (g++, clang++) + zlib (`-lz`)

**Compile:**
```bash
# Using make
cd src/encoder/cpp
make

# Or manually
g++ -std=c++17 -O2 -o vm_encoder src/encoder/cpp/vm_encoder.cpp -lz
```

**Run:**
```bash
./vm_encoder <file> [options]

# Or from the source directory after make
src/encoder/cpp/vm_encoder <file> [options]
```

**Examples:**
```bash
./vm_encoder report.json
./vm_encoder results/ --delay 100
./vm_encoder archive.tar.gz --mode q2
```

**Notes:** Single `.cpp` file. The only external dependency is **zlib** (available on virtually every system). Includes a `Makefile` for convenience. Directory tar-packing uses POSIX `tar` via `popen()`. Opens the generated HTML via `xdg-open` / `open` / `start`.

---

## Go

**Requirements:** Go 1.18+

**Run:**
```bash
go run src/encoder/go/vm_encoder.go <file> [options]
```

**Build and run:**
```bash
cd src/encoder/go
go build -o vm_encoder vm_encoder.go
./vm_encoder <file> [options]
```

**Examples:**
```bash
go run src/encoder/go/vm_encoder.go report.json
go run src/encoder/go/vm_encoder.go results/ --delay 100
go run src/encoder/go/vm_encoder.go archive.tar.gz --mode q2
```

**Notes:** Zero dependencies — uses only the Go standard library (`archive/tar`, `compress/gzip`, `encoding/base64`, etc.). Includes a `go.mod` for module support. Opens the generated HTML via `xdg-open` / `open` / `cmd /c start`.

---

## Output

All encoders produce the same `tmp/frames.html` (or custom `--output` path) — a self-contained HTML file with:

- Embedded base64-encoded, gzipped payload
- JavaScript canvas player with play/pause controls
- Speed buttons (50ms–1000ms frame interval)
- Frame counter and progress display
- Auto-play on load

Open this file in any browser inside the VM. The decoder on the host captures the screen and reconstructs the original file.
