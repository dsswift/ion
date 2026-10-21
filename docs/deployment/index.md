---
title: Deployment
description: Deployment patterns for Ion Engine.
sidebar_position: 1
---

# Deployment

Ion is engine-first. The engine is a single static binary with zero runtime dependencies. Any client that speaks its wire protocol connects to it; the reference client set, Ion Studio, is archived at [dsswift/ion-studio](https://github.com/dsswift/ion-studio).

## Components

| Component | What | Deploy target |
|-----------|------|---------------|
| [Engine](engine-standalone.md) | Go agent runtime. Single binary, Unix socket daemon. | Any Linux/macOS host, container, or VM |
| [Engine containers](engine-container.md) | Container patterns for the engine. | Docker, Kubernetes, sidecar |
| [Machine identity](machine-identity.md) | A workload identity for an engine nobody signs in to. | Containers and pipelines |

## Architecture at deploy time

```
┌─────────────┐     Unix socket      ┌──────────────┐
│   Client    │────────────────────→ │    Engine     │
│             │     NDJSON           │  (ion serve)  │
└─────────────┘                      └──────────────┘
```

A client connects to the engine over its Unix socket (a loopback port on Windows). The engine has no knowledge of which client type is connected -- it speaks the same NDJSON protocol to all of them. An engine with engine-scoped extension hosts ([`extensionHosts`](../configuration/extension-hosts.md)) runs its scheduled work with no client connected at all.

## Minimal deployment

For local development or single-user use, all you need is the engine binary:

```bash
# Download and install
curl -L https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion

# Start the daemon
ion serve
```
