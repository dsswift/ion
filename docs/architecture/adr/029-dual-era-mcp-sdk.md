---
title: Dual-era MCP SDK integration
status: accepted
---

# ADR-029: Dual-era MCP SDK integration

## Context

MCP `2026-07-28` replaces connection handshake and protocol sessions with
stateless request metadata, `server/discover`, Multi Round-Trip Requests, and
subscription streams. Ion also must continue connecting to deployed legacy
servers.

A hand-written protocol stack had drifted across revisions: it sent an older
initialize version while implementing selected later Streamable HTTP behavior.
That leaves version negotiation, HTTP header validation, MRTR, cache hints, and
legacy fallback incomplete.

## Decision

Ion uses `github.com/modelcontextprotocol/go-sdk` as protocol mechanism for MCP
client connections and the local ToolServer bridge. SDK `v1.7.0` negotiates and
supports these revisions:

- `2024-11-05`
- `2025-03-26`
- `2025-06-18`
- `2025-11-25`
- `2026-07-28`

The MCP package retains Ion integration ownership: layered server config,
enterprise HTTP transport, OAuth persistence, token forwarding, permission
routing, engine session lifecycle, typed engine events, logging, and result
conversion.

For `2026-07-28`, Ion advertises only capabilities it implements: tools,
resources, and elicitation form/URL modes. It does not advertise roots,
sampling, logging, or `io.modelcontextprotocol/tasks`. Roots, sampling, and
logging are deprecated; Tasks is optional extension surface, not core protocol.

The local ToolServer uses one dual-era SDK server per Unix socket. Delegated
clients using initialize continue to work; modern clients use `server/discover`
and stateless request metadata on same socket.

## Consequences

- A configured `http` server gets modern discovery first and legacy negotiation
  when peer requires initialize.
- Explicit `sse` configuration remains supported only for legacy HTTP+SSE
  servers. New remote servers use `http`.
- MCP server responses can return typed text, images, resources, structured
  content, cache hints, pagination, subscriptions, and MRTR results without
  Ion reimplementing wire mechanics.
- Server-initiated elicitation routes through Ion's existing session-scoped
  human-wait broker. Modern peers receive MRTR retries; legacy peers receive
  SDK compatibility behavior.
- Auth remains Ion-owned. Credential persistence is issuer/resource bound;
  Client ID Metadata Documents are preferred over pre-registered clients and
  deprecated dynamic registration.

## Rejected

- Incrementally extending Ion's manual protocol parser. Protocol semantics,
  security requirements, and legacy compatibility would keep diverging.
- Supporting only `2026-07-28`. Existing local and remote MCP installations
  require the legacy revisions during migration.
- Advertising unimplemented extensions or deprecated features. Capability
  advertisement is a behavioral promise, not future intent.
