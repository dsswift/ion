---
title: Format Versions
description: The registry of every versioned format and protocol Ion reads or writes, the rule that decides compatibility for each, and how to register a new one.
---

# Format Versions

A Format Version is the version of one data format, stored schema, or wire protocol an Ion build reads or writes: the transfer archive, the Studio wire protocol, the conversation file schema, and the rest. Two builds can work together over a format when its rule says their versions agree, whatever their server or engine versions are.

Each side keeps one registry, and each entry reads its version from the constant the code already uses, so nothing is copied:

- Engine: [`engine/internal/compat/compat.go`](../../engine/internal/compat/compat.go)
- Studio server (and the `@ion/shared` code it runs): [`server/src/compat/registry.ts`](../../server/src/compat/registry.ts)

The entry shape is shared: `{id, owner, version, rule, meaning}` ([`packages/shared/src/format-versions.ts`](../../packages/shared/src/format-versions.ts)).

## Rules

| Rule | Two builds work together when |
|---|---|
| `exact` | Both have the same version. |
| `accepts-previous` | The receiver (a server) has the sender's version, or the one after it. |
| `reader-at-least` | The reader's version is at or above the writer's. |
| `host-storage` | Not compared between hosts. The data lives on the host, and a build that writes a lower version would be a downgrade. |
| `external` | Not compared between hosts. The protocol is spoken to a third party. |

## Where the versions are published

| Surface | Carries |
|---|---|
| `ion version --json` | The engine binary's registry. It reads nothing else, so it answers for an installed engine that is not running. |
| Engine `health` (`compat`) | The running engine's registry. |
| `compat.json` beside `VERSION` | A packaged server's registry, in the Studio Server bundle and in the desktop's embedded server. It is written at packaging time. |
| `GET /versionz` | The running server's registry, then its running engine's. It also carries the engine minimum and whether the engine meets it. No credential is needed, like `/healthz`. |
| `environment.server.info` | The same list over the Studio wire, for a client that reaches the server through a relay. |
| `ion studio status --json` | Every format installed and running on the host, with pending restarts. |

`ion fleet` merges these per host and judges pairs of hosts ([Fleet](../deployment/fleet.md)).

## Registering a new format

1. Name the version in one constant: an engine `const …Version`, or a server or shared `export const …_VERSION`.
2. Add an entry to the registry of the side that owns it, with its rule and a one-line meaning.
3. A value that is not a format two builds exchange or store goes on that side's not-a-format list, with the reason.

Each registry has a test that scans its sources for version constants. It fails when one is neither registered nor listed, so a new format cannot ship without the fleet knowing about it.
