---
title: Installation
description: Install the Ion Engine binary on macOS, Linux, Windows, or Docker.
sidebar_position: 1
---

# Installation

Ion Engine is a single static binary with no runtime dependencies. Download it, make it executable, and you're done.

## macOS (Apple Silicon)

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

## Linux (x86_64)

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-linux-amd64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

## Windows (PowerShell)

```powershell
Invoke-WebRequest -Uri "https://github.com/dsswift/ion/releases/latest/download/ion-windows-amd64.exe" -OutFile "$env:LOCALAPPDATA\ion\ion.exe"
```

Add `$env:LOCALAPPDATA\ion` to your `PATH` if it isn't already.

On Windows, Ion listens on TCP `127.0.0.1:21017` instead of a Unix socket.

## Docker

Ion's Dockerfile uses a `FROM scratch` base, producing a minimal image with just the binary:

```dockerfile
FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -ldflags "-s -w" -o /ion ./cmd/ion/

FROM scratch
COPY --from=build /ion /ion
ENTRYPOINT ["/ion"]
CMD ["serve"]
```

Build and run:

```bash
docker build --platform linux/amd64 -t ion-engine .
docker run -p 21017:21017 ion-engine
```

## Build from source

Requires Go 1.22+.

```bash
git clone https://github.com/dsswift/ion.git
cd ion/engine
make build
```

This produces `bin/ion` (~7.8MB, statically linked, stripped). To install to `/usr/local/bin`:

```bash
make install
```

### Build targets

| Target | Description |
|--------|-------------|
| `make build` | Build for current platform -> `bin/ion` |
| `make build-linux` | Cross-compile for linux/amd64 |
| `make build-darwin` | Cross-compile for darwin/arm64 |
| `make docker` | Build Docker image |
| `make test` | Run unit tests |
| `make test-integration` | Run integration tests |

## Verify installation

```bash
ion version
```

Expected output:

```
ion-engine v0.1.0
```

## Runtime directory

On first run, Ion creates `~/.ion/` with:

| Path | Purpose |
|------|---------|
| `~/.ion/engine.sock` | Unix domain socket (daemon endpoint) |
| `~/.ion/engine.pid` | PID lock file |
| `~/.ion/engine.log` | Daemon log output |
| `~/.ion/engine.json` | User-level configuration (you create this) |
| `~/.ion/extensions/` | Installed extensions |
