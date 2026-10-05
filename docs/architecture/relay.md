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

Each channel is identified by a `channelId` (opaque string, typically a UUID). A channel has two sides:

- `role=ion` -- the server. One per channel.
- `role=mobile` -- a client of the server's pairing: the iOS app, a desktop, or the `ion fleet` CLI.

A channel holds one client unless its server joins as multi-client (`?role=ion&multi=1`). Then it holds every client of the pairing at once, so a desktop's Studio window and its `ion fleet`, or a phone's live session and an admin session, do not knock each other off.

When a message arrives from one side, the relay forwards it to the other side of the same channel. If no client is connected, a server message is dropped (with an optional APNs push to wake the phone).

### Hub

The `Hub` struct maintains an in-memory map of `channelId -> [ion_conn, mobile_conns]`. No persistence. When the server and every client have disconnected, the channel is cleaned up.

Key behaviors:
- First peer to connect on a channel creates it
- Second peer joins the existing channel
- A server that reconnects replaces the server before it
- A client that joins replaces the client before it, unless the server is multi-client
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

Once connected, all WebSocket frames from one side are forwarded to the other side of the same channel. The relay does not validate or transform a frame's content; it reads only the outer envelope's routing fields.

### Multi-client channels

A server that joins with `multi=1` gets one connection per client. `GET /v1/auth/config` reports `capabilities.multiClient: true` on a relay that supports it; a relay that does not ignores the flag and keeps one client.

| Frame | To | Meaning |
|---|---|---|
| `{"type":"relay:connected","peer":"<id>"}` | a client | It joined; `peer` is the relay's id for it on this channel. |
| `{"type":"relay:peer-joined","peer":"<id>"}` | the server | A client joined. Sent once per client already on the channel when the server itself joins. Replaces `relay:peer-reconnected`. |
| `{"type":"relay:peer-left","peer":"<id>"}` | the server | That client left. Replaces `relay:peer-disconnected`. |

The relay adds `"peer":"<id>"` to the outer envelope of every client frame it forwards to the server, as the last member, so it wins over any `peer` the client wrote. A server frame whose envelope names a `peer` goes to that client only, and is dropped if the client has left. A server frame that names none goes to every client. The envelope's ciphertext is untouched: clients of one pairing share its key.

A server that is not multi-client that takes over a channel holding several clients keeps the newest and closes the rest.

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

When the APNs environment variables are configured (the key as `APNS_KEY_PATH` or `APNS_KEY`, plus `APNS_KEY_ID`, `APNS_TEAM_ID`, and the required `APNS_TOPIC`), the relay can send push notifications to wake the iOS app when a message arrives and the mobile peer is disconnected.

This is a user-visible alert notification (with title, body, and sound) that also sets `content-available` to wake the app in the background.

Each push goes to the Apple environment that issued the phone's token. A development build (Xcode, `make ios`) registers with the sandbox and a TestFlight or App Store build with production. The relay keeps no push addresses. Each paired phone registers its token and environment with its server (`device.registerPush`, over whatever connection it has), and the server sends them with every push it rings, so one relay serves every build, server, and person at once. The server decides who is rung: a push about a conversation reaches only the devices of the people who may see that conversation. `APNS_PRODUCTION` only picks the environment for a push that arrives without one.
