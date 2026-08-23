---
title: Contributing
description: Contributor guide for the Ion Engine project.
sidebar_position: 1
---

# Contributing

Ion is a monorepo. The engine is the product; the other components are reference implementations and infrastructure around it. Most contributions target the engine (Go). This guide covers setup, testing, and conventions for all components.

## Repository layout

```
ion/
  engine/       # Go agent runtime (the product)
  desktop/      # Electron client: Overlay and Studio presentations
  relay/        # Go WebSocket relay (transport infrastructure)
  ios/          # SwiftUI client
  docs/         # Documentation (Docusaurus)
```

## Before you start

1. Understand the [four-domain vocabulary model](../architecture/index.md). Every change belongs to exactly one domain: engine, harness-sdk, clients, or relay.
2. Read [ADR-001](../architecture/adr/001-engine-vs-harness.md) to understand the engine vs harness boundary.
3. The engine is the product. Desktop and iOS are reference client implementations, and the relay is transport infrastructure. Prioritize engine quality.
4. Use the canonical name for every shared concept. The [Ion Vocabulary](../vocabulary/index.md) is the authority.

## Vocabulary workflow

`docs/vocabulary/terms.json` is the naming registry. `docs/vocabulary/index.md` is generated from it and must never be edited by hand.

When your change introduces or renames a shared concept:

1. Edit the registry entry in `docs/vocabulary/terms.json`. A rename moves the old canonical term into that entry's `legacyNames`.
2. Regenerate the glossary:

   ```bash
   make generate-vocabulary
   ```

3. Verify the registry and the committed glossary agree:

   ```bash
   make check-vocabulary
   ```

4. Commit both files together.

Each entry needs a definition, a domain (`engine`, `harness-sdk`, `clients`, `relay`), a kind, a status, a contract classification, and at least one implementation citing a real symbol in a real repo-relative file. The checker verifies that the file exists and that the symbol appears in it, so a stale path or a renamed symbol fails the gate.

A registry entry names a concept in prose. It never renames a published wire field, an event type string, a hook name, or an SDK type. Those follow the contract rules in the root `AGENTS.md`.

## Guides

| Guide | What |
|-------|------|
| [Development setup](development-setup.md) | Prerequisites, clone, build, run |
| [Testing](testing.md) | Three test tiers, helpers, writing tests |
| [Conventions](conventions.md) | Code patterns, logging, types, streaming |
| [Branch lifecycle](branch-lifecycle.md) | Feature work → align → squash → PR, and the hooks that run automatically |
| [Graph queries](graph-queries.md) | Querying the graphify knowledge graph: subcommands, budgets, edge confidence |
| [Branch protection](branch-protection.md) | GitHub ruleset, required checks, release bypass |

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

# Vocabulary registry: regenerate the glossary, then verify it
make generate-vocabulary
make check-vocabulary
```
