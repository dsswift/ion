---
title: Engine Standalone
description: Install and run the Ion Engine as a standalone binary or Docker container.
sidebar_position: 2
---

# Engine Standalone

The Ion Engine is a single static Go binary (~7.8MB). `CGO_ENABLED=0`, zero runtime dependencies, no glibc requirement. It runs on any Linux or macOS host without installation beyond copying the binary.

## Binary install

### From release

```bash
# macOS (Apple Silicon)
curl -L https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 \
  -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion

# Linux (amd64)
curl -L https://github.com/dsswift/ion/releases/latest/download/ion-linux-amd64 \
  -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion
```

### From source

```bash
cd engine
make build          # -> bin/ion (native)
make build-linux    # -> bin/ion-linux-amd64
make build-darwin   # -> bin/ion-darwin-arm64
```

The build uses `-ldflags "-s -w"` for stripped binaries. Version is injected at build time via `-X main.version=$(VERSION)`.

## Running the daemon

```bash
ion serve
```

This starts the engine daemon and listens on:

| Platform | Transport | Address |
|----------|-----------|---------|
| Unix/macOS | Unix socket | `~/.ion/engine.sock` |
| Windows | TCP | `127.0.0.1:21017` |

The daemon writes a PID lock to `~/.ion/engine.pid` to prevent duplicate instances. Logs go to `~/.ion/engine.log`.

### Verifying the daemon

```bash
# Check if running
ls -la ~/.ion/engine.sock

# Send a health check (Unix socket)
echo '{"type":"ping"}' | socat - UNIX-CONNECT:$HOME/.ion/engine.sock
```

## Docker

The engine ships as a `FROM scratch` image -- nothing in the container except the binary.

### Dockerfile

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

### Build and run

```bash
cd engine
make docker    # builds ion-engine:latest for linux/amd64

docker run -d \
  --name ion-engine \
  -v ion-data:/root/.ion \
  ion-engine:latest
```

Mount `/root/.ion` if you need persistent conversations, config, or extensions across container restarts.

## systemd service

For Linux hosts running the engine as a long-lived daemon:

```ini
[Unit]
Description=Ion Engine
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/ion serve
Restart=on-failure
RestartSec=5
User=ion
Group=ion
WorkingDirectory=/home/ion

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/ion/.ion

[Install]
WantedBy=multi-user.target
```

```bash
sudo cp ion.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ion
```

## launchd (macOS)

For macOS hosts running the engine at login:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.ion.engine</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/ion</string>
        <string>serve</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/ion-engine.err</string>
</dict>
</plist>
```

```bash
cp com.ion.engine.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.ion.engine.plist
```

## File layout

The engine creates and uses `~/.ion/` as its data directory:

```
~/.ion/
  engine.sock       # Unix socket (runtime)
  engine.pid        # PID lock (runtime)
  engine.log        # Log output
  config.json       # User config (layer 2 of 4)
  conversations/    # JSONL session persistence
  extensions/       # Installed extensions
  agents/           # User agent definitions
  bin/              # Engine binary (when installed via make)
```

## Configuration

The engine loads configuration from four layers, merged in order:

1. Built-in defaults
2. User config (`~/.ion/config.json`)
3. Project config (`.ion/config.json` in working directory)
4. Enterprise MDM policy (sealed, cannot be overridden)

See [Configuration](../configuration/) for the full reference.
