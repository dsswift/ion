---
title: iOS
description: Build and install the Ion iOS companion app.
sidebar_position: 6
---

# iOS

Ion Remote is a SwiftUI companion app that connects to the Ion Engine for mobile control of agent sessions. It supports two connection modes: direct LAN and remote relay.

## Requirements

- Xcode 15+
- iOS 17+
- Apple Developer account (for device deployment)

## Build

```bash
cd ios
xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build
```

For device installation, open `ios/IonRemote.xcodeproj` in Xcode, select your device, and run.

### Verify build

```bash
cd ios && xcodebuild -project IonRemote.xcodeproj -scheme IonRemote \
  -destination 'generic/platform=iOS' build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)"
```

## Connection modes

### LAN (direct)

The iOS app discovers the engine on the local network using Bonjour/mDNS. No relay server needed. Both devices must be on the same network.

1. Engine advertises itself via mDNS
2. iOS app discovers the engine automatically
3. Direct socket connection, no intermediary

This is the lowest-latency option. Use it when the iOS device and the engine host are on the same WiFi network.

### Remote (via relay)

For connections outside the local network, the iOS app connects through the relay server over WebSocket.

1. Engine connects to relay: `wss://relay.example.com/v1/channel/{id}?role=ion`
2. iOS connects to relay: `wss://relay.example.com/v1/channel/{id}?role=mobile`
3. Relay forwards messages between peers

All payloads are end-to-end encrypted. The relay cannot read message content.

## Pairing

Pairing uses a QR code scanned from the iOS app's settings screen. The QR code encodes the connection details (relay URL, channel ID, and encryption key material). Once paired, the iOS app reconnects automatically on subsequent launches.

### Pairing flow

1. Open the engine's pairing interface (Desktop settings or CLI)
2. A QR code is displayed with connection credentials
3. In the iOS app, go to Settings and tap "Pair"
4. Scan the QR code
5. The app establishes a connection and confirms pairing

## Security

- All communication between iOS and engine is end-to-end encrypted
- Encryption keys are exchanged during QR pairing and never sent to the relay
- The relay forwards opaque byte sequences and cannot decrypt payloads
- LAN connections use the same encryption layer for consistency
