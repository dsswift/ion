---
title: Deployment
description: Deployment patterns for Ion Engine, Desktop, Relay, and iOS.
sidebar_position: 1
---

# Deployment

Ion is engine-first. The engine is a single static binary with zero runtime dependencies. Desktop and iOS connect to it as clients. Relay is transport infrastructure that connects to the engine.

## Components

| Component | What | Deploy target |
|-----------|------|---------------|
| [Engine](engine-standalone.md) | Go agent runtime. Single binary, Unix socket daemon. | Any Linux/macOS host, container, or VM |
| [Engine containers](engine-container.md) | Container patterns for the engine. | Docker, Kubernetes, sidecar |
| [Ion Studio Server](studio-server.md) | Headless server that pairs with one engine to form an Environment. Also runs inside every desktop install. | A macOS or Linux host as a background service (one-line install, or over SSH from the desktop), Docker Compose, Kubernetes |
| [Relay](relay.md) | WebSocket relay for remote iOS control. | Kubernetes, any container host |
| [Desktop](desktop.md) | Ion Studio for macOS. Carries its own Studio Server, so a Mac running it is an Environment other desktops can pair with. | macOS 13+ workstation, installed locally or [pushed over SSH](studio-server.md#pushing-the-desktop-to-another-mac) |
| [iOS](ios.md) | SwiftUI companion app. | iOS 17+ device |

Setting up more than one machine? [Three machines, start to finish](multi-machine-walkthrough.md) goes from nothing to one laptop driving a headless host and a second laptop. Running several already? [Fleet](fleet.md) shows every host's installs, load, and [Format Versions](../architecture/format-versions.md), which hosts can work with which, and redeploys them from one Mac.

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
