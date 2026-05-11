---
title: Relay Architecture
description: WebSocket relay architecture, channel model, and protocol.
sidebar_position: 4
---

# Relay Architecture

The Ion Relay is a stateless Go WebSocket server. It pairs two peers on a channel and forwards messages between them. It never inspects, modifies, or persists message payloads.

## Design

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│  Engine   │──── WebSocket ───→│  Relay   │←── WebSocket ────│   iOS    │
│ (role=ion)│                   │ (hub)    │                   │(role=    │
│           │←── forwarded ────│          │──── forwarded ───→│ mobile)  │
└──────────┘                    └──────────┘                    └──────────┘
```

### Channel model

Each channel is identified by a `channelId` (opaque string, typically a UUID). A channel supports exactly two peers:

- `role=ion` -- the engine instance
- `role=mobile` -- the iOS app

When a message arrives from one peer, the relay forwards it to the other peer on the same channel. If the destination peer is not connected, the message is dropped (with an optional APNs push to wake the mobile peer).

### Hub

The `Hub` struct maintains an in-memory map of `channelId -> [ion_conn, mobile_conn]`. No persistence. When both peers disconnect, the channel is cleaned up.

Key behaviors:
- First peer to connect on a channel creates it
- Second peer joins the existing channel
- If a peer reconnects, it replaces the previous connection for that role
- Messages are forwarded synchronously (no buffering or queuing)
- Messages are forwarded with `permessage-deflate` compression when the client supports it

## Protocol

### Connection

```
GET /v1/channel/{channelId}?role={ion|mobile}
Authorization: Bearer <api_key>
Connection: Upgrade
Upgrade: websocket
```

The relay validates the Bearer token against `RELAY_API_KEY` before upgrading to WebSocket. Invalid or missing tokens receive a 401.

### Message forwarding

Once connected, all WebSocket frames from one peer are forwarded to the other peer on the same channel. The relay treats every frame as opaque bytes. It does not parse, validate, or transform the content.

The relay offers `permessage-deflate` compression during the WebSocket handshake. Both the engine client and iOS client negotiate compression automatically.

### Health

```
GET /healthz
-> 200 {"status":"ok"}
```

No authentication required.

## Keepalive

The relay sends WebSocket ping frames every 30 seconds (configurable via `RELAY_PING_INTERVAL_S`) to detect dead connections. If no pong arrives within 10 seconds (configurable via `RELAY_PING_TIMEOUT_S`), the connection is closed.

All relay timeouts (write, ping interval, ping timeout, max message size) are configurable via environment variables. See [Relay Deployment](../deployment/relay.md) for the full list.

## Security

### API key

Every WebSocket upgrade request must include a valid Bearer token. The relay compares it against the `RELAY_API_KEY` environment variable using constant-time comparison.

### Origin rejection

The relay rejects WebSocket upgrades that include an `Origin` header. Native clients (engine, iOS) do not send this header; browsers do. This prevents browser-based cross-origin attacks.

### End-to-end encryption

Clients (engine and iOS app) encrypt all payloads before sending them through the relay. The encryption key is exchanged during QR pairing and never transmitted to the relay. The relay forwards encrypted bytes and cannot decrypt them.

### No persistence

The relay stores nothing to disk. All state (channel membership, connection handles) exists in memory and is lost on restart. There are no logs of message content.

## mDNS

The relay advertises itself via mDNS (Bonjour) on UDP port 5353 for LAN discovery. iOS devices on the same network can discover the relay without manual configuration. This is useful for home lab deployments where the relay runs on the same network as iOS devices.

mDNS is best-effort. If it fails to start (common in containers without host networking), the relay logs a warning and continues without it.

## APNs integration

When all three APNs environment variables are configured (`APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`), the relay can send push notifications to wake the iOS app when a message arrives and the mobile peer is disconnected.

This is a user-visible alert notification (with title, body, and sound) that also sets `content-available` to wake the app in the background.
