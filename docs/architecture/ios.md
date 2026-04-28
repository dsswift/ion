---
title: iOS Architecture
description: SwiftUI architecture, transport modes, and pairing for Ion Remote.
sidebar_position: 5
---

# iOS Architecture

Ion Remote is a SwiftUI app that provides mobile control of Ion Engine sessions. It connects to the engine either directly over LAN or remotely through the relay server.

## Transport modes

The app supports two transport modes, selectable at runtime.

### LAN (Bonjour/mDNS)

```
┌──────────┐     mDNS discovery     ┌──────────┐
│   iOS    │ ─────────────────────→ │  Engine   │
│          │                         │          │
│          │←──── direct socket ───→│          │
└──────────┘                         └──────────┘
```

The iOS app uses `NWBrowser` (Network framework) to discover Ion Engine instances advertising via Bonjour on the local network. Once discovered, it connects directly over a socket. No relay needed.

- Lowest latency
- Both devices must be on the same network
- No external infrastructure required

### Remote (WebSocket relay)

```
┌──────────┐     WebSocket     ┌──────────┐     WebSocket     ┌──────────┐
│   iOS    │ ────────────────→ │  Relay   │ ←──────────────── │  Engine   │
│          │←────────────────  │          │  ────────────────→│          │
└──────────┘                   └──────────┘                    └──────────┘
```

For connections outside the local network, both the engine and the iOS app connect to the relay server. The relay forwards messages between them.

- Works across any network
- Requires a relay server deployment
- All payloads are end-to-end encrypted

## Encryption

All communication uses end-to-end encryption regardless of transport mode. The `E2ECrypto` module handles key exchange and message encryption.

- Keys are exchanged during QR pairing
- Symmetric encryption for message payloads
- The relay never has access to encryption keys
- LAN mode uses the same encryption for consistency

## Pairing

Pairing bootstraps the connection between the iOS app and an engine instance.

### Flow

1. Engine generates pairing credentials: relay URL, channel ID, encryption key material
2. Credentials are encoded into a QR code
3. User scans the QR code from the iOS app's Settings screen
4. The app stores the credentials in the Keychain
5. On subsequent launches, the app reconnects automatically using stored credentials

### What the QR code contains

- Relay server URL (for remote mode)
- Channel ID
- Public key for key exchange
- Engine identifier

No API keys or secrets are embedded in the QR code. The encryption key is derived through a key exchange protocol during the pairing handshake.

## App structure

```
IonRemote/
  App.swift              # Entry point, scene configuration
  Views/
    SessionView.swift    # Conversation display
    InputView.swift      # Prompt input
    SettingsView.swift   # Pairing, connection mode, preferences
    PairingView.swift    # QR scanner
  Transport/
    TransportProtocol.swift   # Shared interface for both modes
    LANTransport.swift        # Bonjour discovery + direct socket
    RelayTransport.swift      # WebSocket via relay
  Crypto/
    E2ECrypto.swift      # Key exchange, encrypt/decrypt
  Models/
    Session.swift        # Session state
    Message.swift        # Message types
```

### Transport protocol

Both LAN and relay transports conform to the same protocol, allowing the app to switch modes without changing the conversation layer:

```swift
protocol TransportProtocol {
    func connect() async throws
    func disconnect()
    func send(_ data: Data) async throws
    var messages: AsyncStream<Data> { get }
    var state: ConnectionState { get }
}
```

## Connection lifecycle

1. App launches, checks for stored pairing credentials
2. If paired, attempts connection (LAN first, falls back to relay if configured)
3. On successful connection, enters active session state
4. Incoming engine events are decrypted and rendered
5. User prompts are encrypted and sent to the engine
6. On disconnect, the app enters reconnection loop with exponential backoff
