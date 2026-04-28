---
title: Contributing
description: Contributor guide for the Ion Engine project.
sidebar_position: 1
---

# Contributing

Ion is a monorepo with four products. Most contributions target the engine (Go). This guide covers setup, testing, and conventions for all components.

## Repository layout

```
ion/
  engine/       # Go agent runtime (the product)
  desktop/      # Electron overlay for macOS
  relay/        # Go WebSocket relay
  ios/          # SwiftUI companion app
  docs/         # Documentation (Docusaurus)
```

## Before you start

1. Understand the [three-layer terminology](../architecture/index.md). Every change belongs to exactly one layer: engine, harness, or client.
2. Read [ADR-001](../architecture/adr/001-engine-vs-harness.md) to understand the engine vs harness boundary.
3. The engine is the product. Desktop, iOS, and Relay are reference clients. Prioritize engine quality.

## Guides

| Guide | What |
|-------|------|
| [Development setup](development-setup.md) | Prerequisites, clone, build, run |
| [Testing](testing.md) | Three test tiers, helpers, writing tests |
| [Conventions](conventions.md) | Code patterns, logging, types, streaming |

## Quick reference

```bash
# Build everything
make install

# Engine only
cd engine && make build

# Desktop only
cd desktop && npm run build

# Run all tests
make test

# Engine unit tests
cd engine && go test ./...

# Engine integration tests
cd engine && go test -tags integration ./...
```
