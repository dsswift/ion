---
title: Format Versions
description: The registry of every versioned format and protocol Ion reads or writes, the rule that decides compatibility for each, and how to register a new one.
---

# Format Versions

A Format Version is the version of one data format, stored schema, or wire protocol an Ion build reads or writes: the conversation file schema, the telemetry frame, the ACP wire, and the rest. Two builds can work together over a format when its rule says their versions agree, whatever their engine versions are.

Each side keeps one registry, and each entry reads its version from the constant the code already uses, so nothing is copied:

- Engine: [`engine/internal/compat/compat.go`](../../engine/internal/compat/compat.go)

The entry shape is shared: `{id, owner, version, rule, meaning}`; a consumer that keeps its own registry uses the same shape.

## Rules

| Rule | Two builds work together when |
|---|---|
| `exact` | Both have the same version. |
| `accepts-previous` | The receiver has the sender's version, or the one after it. |
| `reader-at-least` | The reader's version is at or above the writer's. |
| `host-storage` | Not compared between hosts. The data lives on the host, and a build that writes a lower version would be a downgrade. |
| `external` | Not compared between hosts. The protocol is spoken to a third party. |

## Where the versions are published

| Surface | Carries |
|---|---|
| `ion version --json` | The engine binary's registry. It reads nothing else, so it answers for an installed engine that is not running. |
| Engine `health` (`compat`) | The running engine's registry. |

A consumer that keeps its own registry publishes it in the same shape so a tool can judge a pair of hosts.

## Registering a new format

1. Name the version in one constant: an engine `const …Version`.
2. Add an entry to the registry of the side that owns it, with its rule and a one-line meaning.
3. A value that is not a format two builds exchange or store goes on that side's not-a-format list, with the reason.

Each registry has a test that scans its sources for version constants. It fails when one is neither registered nor listed, so a new format cannot ship without the fleet knowing about it.
