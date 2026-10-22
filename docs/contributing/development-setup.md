---
title: Development Setup
description: Clone, build, and run the engine from source.
sidebar_position: 2
---

# Development Setup

## Prerequisites

| Tool | Version | Used by |
|------|---------|---------|
| Go | the `toolchain` line in `engine/go.mod` | Engine, Go SDK |
| Node.js | 22+ | The TypeScript SDK's test project, the dashboards generator, the vocabulary tooling |
| Docker | any | The Linux parity gate (optional) |
| `release-damnit` | latest | The commit-msg hook and `make land` |
| `golangci-lint` | the version `.github/workflows/quality.yml` pins | Engine lint |

## Clone and build

```bash
git clone https://github.com/dsswift/ion.git
cd ion
make bootstrap   # hooks, debug log level, the code graph
make engine      # builds engine/bin/ion and installs it to ~/.ion/bin/ion
```

`make engine` runs `engine/commands/install.command`: it builds the binary, installs the extension SDKs to `~/.ion/extensions/`, and restarts the engine service on macOS.

## Make targets

| Target | What |
|--------|------|
| `make engine` | Build and install the engine and the SDKs |
| `make test` | Engine unit tests |
| `make engine-test` | Engine unit tests with the race detector |
| `make sdk-test` | Go SDK and TypeScript SDK suites, which pin the two SDKs against the engine's contract manifests |
| `make test-linux` | The Linux parity gate in a container (what CI runs) |
| `make check-file-sizes`, `check-contracts`, `check-logging`, `check-vocabulary`, `check-doc-links`, `check-dashboards` | The scoped gates |
| `make land` | Rebase onto `main`, check every commit, push |

## Running locally

```bash
ion serve                      # the daemon
ion prompt "what is here?"     # one-shot, no daemon needed
ion attach                     # stream the daemon's events as NDJSON
```

Configuration lives in `~/.ion/engine.json`; see [engine.json](../configuration/engine-json.md). An extension under development is loaded with `--extension <path>` or listed in a profile.

## Build verification

```bash
cd engine && go build ./... && go test ./internal/<pkg>/...
cd engine && golangci-lint run ./internal/<pkg>/...
```

## Cross-compilation

```bash
cd engine && make build-linux             # linux/amd64, fully static
cd engine && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./...
```

## Pipeline testing

`make test-pipeline-dry` and `make test-pipeline-engine` run the release build workflow locally with `act` against the release report in `.act/`.
