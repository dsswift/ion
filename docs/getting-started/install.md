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

## Linux (arm64)

```bash
curl -fsSL https://github.com/dsswift/ion/releases/latest/download/ion-linux-arm64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

## Windows (PowerShell)

```powershell
New-Item -ItemType Directory -Path "$env:LOCALAPPDATA\ion" -Force | Out-Null
Invoke-WebRequest -Uri "https://github.com/dsswift/ion/releases/latest/download/ion-windows-amd64.exe" -OutFile "$env:LOCALAPPDATA\ion\ion.exe"
```

Add `$env:LOCALAPPDATA\ion` to your `PATH` if it isn't already.

On Windows, Ion listens on TCP `127.0.0.1` instead of a Unix socket, at a port derived from the signed-in user's SID (`51000-54999`). It is per user rather than fixed so two accounts signed in to one machine -- fast user switching, or a multi-session host -- never resolve to the same address.

x64 is the supported Windows target. An ARM64 build is published for
developers running Windows on Apple silicon; it is not a deployment target and
is not exercised by CI.

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

This produces `bin/ion` (statically linked, stripped). To install to `/usr/local/bin`:

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

On first run, Ion creates `~/.ion/` (`%USERPROFILE%\.ion` on Windows) with:

| Path | Purpose |
|------|---------|
| `~/.ion/engine.sock` | Unix domain socket (daemon endpoint). **Not created on Windows** -- the daemon listens on TCP `127.0.0.1` at a per-user port instead. |
| `~/.ion/engine.pid` | PID lock file |
| `~/.ion/engine.exit` | Last-exit breadcrumb, written when the daemon stops |
| `~/.ion/engine.jsonl` | Daemon log output (structured JSONL; `.1`, `.2`, `.3` are rotations) |
| `~/.ion/engine.json` | User-level configuration (you create this) |
| `~/.ion/extensions/` | Installed extensions |
| `~/.ion/conversations/` | Persisted conversations |

Set `ION_DATA_DIR` to move all of the above, which is how two engine instances
coexist on one machine.
