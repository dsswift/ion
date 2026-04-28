---
title: Development Setup
description: Prerequisites, build, and run instructions for Ion contributors.
sidebar_position: 2
---

# Development Setup

## Prerequisites

| Tool | Version | Required for |
|------|---------|-------------|
| Go | 1.22+ | Engine, Relay |
| Node.js | 20+ | Desktop |
| make | any | Build orchestration |
| Xcode | 15+ | iOS (optional) |
| Docker | any | Relay container builds (optional) |

## Clone and build

```bash
git clone https://github.com/dsswift/ion.git
cd ion
```

### Engine

```bash
cd engine
make build    # -> bin/ion (~7.8MB stripped)
```

The binary is statically linked (`CGO_ENABLED=0`). No system libraries required.

### Desktop

```bash
cd desktop
npm install
npm run build    # compile TypeScript, verify no errors
```

`npm run build` verifies compilation only. To package the app:

```bash
npm run dist     # -> release/mac-arm64/Ion.app
```

### Relay

```bash
cd relay
go build .       # local binary
# or
make relay       # Docker image for linux/amd64
```

### iOS

Open `ios/IonRemote.xcodeproj` in Xcode and build from there.

## Make targets

| Target | What it does |
|--------|-------------|
| `make install` | Builds and installs engine + desktop |
| `make engine` | Builds engine binary, installs to `~/.ion/bin/ion` |
| `make desktop` | Full desktop build + package + install to `/Applications` + relaunch |
| `make relay` | Docker build for linux/amd64 |
| `make relay-local` | `go run` the relay locally |
| `make ios` | iOS install via script |
| `make ios-check` | Verify iOS build compiles |
| `make test` | `go test` + `npm test` |
| `make clean` | Remove build artifacts |

## Running locally

### Start the engine

```bash
cd engine
make build
./bin/ion serve
```

The daemon listens on `~/.ion/engine.sock`. Logs go to `~/.ion/engine.log`.

### Start Desktop in dev mode

```bash
cd desktop
npm run dev
```

This starts the Electron app with hot-reload. It connects to the engine daemon at `~/.ion/engine.sock`.

### Start the relay

```bash
export RELAY_API_KEY=$(openssl rand -hex 32)
cd relay
go run .
```

## Build verification

After making changes, verify builds compile before testing:

```bash
# Desktop changes
cd desktop && npm run build

# Engine changes
cd engine && go build ./...

# Both
cd engine && go build ./... && cd ../desktop && npm run build
```

## Cross-compilation

The engine supports cross-compilation for Linux:

```bash
cd engine
make build-linux     # -> bin/ion-linux-amd64
make build-darwin    # -> bin/ion-darwin-arm64
```

## Pipeline testing

When modifying CI/CD configuration (`.github/workflows/`):

```bash
# Lint workflow files
actionlint .github/workflows/*.yml

# Dry run (parse validation)
make test-pipeline-dry

# Full local execution
make test-pipeline-engine
make test-pipeline-relay
```

Never commit pipeline changes without passing both `actionlint` and at least a dry run.
