---
title: Socket Protocol Overview
description: NDJSON wire protocol for communicating with the Ion Engine daemon.
sidebar_position: 1
---

# Socket Protocol Overview

Ion Engine runs as a background daemon and communicates with clients over a socket using NDJSON (newline-delimited JSON). Each line is a complete, self-contained JSON object terminated by `\n`.

## Transport

| Platform        | Transport          | Address                    |
|-----------------|--------------------|----------------------------|
| macOS / Linux   | Unix domain socket | `~/.ion/engine.sock`       |
| Windows         | TCP loopback       | `127.0.0.1:21017`          |

The engine creates the socket when it starts (`ion serve`) and removes it on shutdown. If a stale socket file exists from a previous crash, the engine detects it by attempting a connection. If the connection fails, the stale file is removed and a new listener is created.

## Framing

Every message in both directions is a single JSON object on one line, terminated by a newline character (`\n`). No length prefix, no binary framing. Clients read with a line scanner; the engine enforces a 1 MB maximum line size.

```
{"cmd":"list_sessions","requestId":"r1"}\n
{"cmd":"session_list","sessions":[...]}\n
```

Empty lines are ignored.

## Message Flow

There are three message patterns:

### 1. Request-Response

The client includes a `requestId` field in the command. The engine replies with a `ServerResult` object containing the same `requestId`, an `ok` boolean, and optional `data` or `error` fields.

```
Client -> {"cmd":"start_session","key":"s1","config":{...},"requestId":"r1"}
Server -> {"cmd":"result","requestId":"r1","ok":true}
```

If `requestId` is omitted, the engine does not send a result for that command.

### 2. Fire-and-Forget

Some commands (`abort`, `abort_agent`, `steer_agent`, `dialog_response`, `command`, `permission_response`) never produce a result. They take effect immediately.

```
Client -> {"cmd":"abort","key":"s1"}
```

### 3. Broadcast Events

Session events are broadcast to all connected clients as `ServerEvent` objects. Each event carries the session `key` and a raw engine event payload.

```
Server -> {"key":"s1","event":{"type":"engine_text_delta","text":"Hello"}}
```

Events flow continuously while a session is active. A client receives events for all sessions, not just the ones it started. Use the `key` field to filter.

## Connection Lifecycle

1. **Connect.** Open a socket to the engine address. No handshake is required.
2. **Send commands.** Write NDJSON lines. The engine processes them in order per connection.
3. **Read responses and events.** Read NDJSON lines from the socket. Lines with `"cmd":"result"` are responses. Lines with `"key"` and `"event"` are broadcast events. Lines with `"cmd":"session_list"` are list responses.
4. **Disconnect.** Close the socket. The engine removes the client from its broadcast list. Active sessions are not affected.

## Discriminating Server Messages

Server messages do not share a single envelope. Identify the type by checking fields:

| Condition                        | Message Type     |
|----------------------------------|------------------|
| Has `"cmd":"result"`             | `ServerResult`   |
| Has `"cmd":"session_list"`       | `ServerSessionList` |
| Has `"key"` and `"event"`       | `ServerEvent`    |

## Session Keys

Every session is identified by a client-chosen `key` string. The key is opaque to the engine. Clients typically use a UUID. The key appears in commands, results, and broadcast events.

## Error Handling

If a command fails validation (unknown `cmd`, missing required fields, malformed JSON), the engine responds with:

```json
{"cmd":"result","requestId":"...","ok":false,"error":"invalid command"}
```

If the command is valid but fails at runtime (session not found, config error), the `error` field contains a descriptive message.

## Multiple Clients

The engine supports multiple simultaneous client connections. All clients receive all broadcast events. Results are sent only to the client that issued the command.
