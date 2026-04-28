---
title: Deployment
description: Deployment patterns for Ion Engine, Desktop, Relay, and iOS.
sidebar_position: 1
---

# Deployment

Ion is engine-first. The engine is a single static binary with zero runtime dependencies. Everything else -- Desktop, Relay, iOS -- connects to it as a client.

## Components

| Component | What | Deploy target |
|-----------|------|---------------|
| [Engine](engine-standalone.md) | Go agent runtime. Single binary, Unix socket daemon. | Any Linux/macOS host, container, or VM |
| [Engine containers](engine-container.md) | Container patterns for the engine. | Docker, Kubernetes, sidecar |
| [Relay](relay.md) | WebSocket relay for remote iOS control. | Kubernetes, any container host |
| [Desktop](desktop.md) | Electron overlay for macOS. | macOS 13+ workstation |
| [iOS](ios.md) | SwiftUI companion app. | iOS 17+ device |

## Architecture at deploy time

```
┌─────────────┐     Unix socket      ┌──────────────┐
│   Desktop    │────────────────────→ │    Engine     │
│  (Electron)  │     NDJSON           │  (ion serve)  │
└─────────────┘                       └──────────────┘
                                            ↑
┌─────────────┐     WebSocket         ┌─────┴────────┐
│     iOS     │────────────────────→  │    Relay      │
│  (SwiftUI)  │     via relay         │  (WebSocket)  │
└─────────────┘                       └──────────────┘
```

Desktop connects to the engine directly over Unix socket. iOS connects over LAN (mDNS discovery) or remotely through the relay server. The engine has no knowledge of which client type is connected -- it speaks the same NDJSON protocol to all of them.

## Minimal deployment

For local development or single-user use, all you need is the engine binary:

```bash
# Download and install
curl -L https://github.com/dsswift/ion/releases/latest/download/ion-darwin-arm64 -o /usr/local/bin/ion
chmod +x /usr/local/bin/ion

# Start the daemon
ion serve
```

Desktop and iOS are optional clients. The relay is only needed for remote iOS access.
