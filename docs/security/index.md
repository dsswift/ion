---
title: Security Model
description: How Ion Engine approaches security -- opt-in primitives for permissions, sandboxing, secret redaction, and audit logging.
sidebar_position: 1
---

# Security Model

Ion Engine provides security primitives. All of them are opt-in. The engine does not enforce a security policy by default -- it gives you the building blocks, and you decide which ones to enable based on your environment.

This design reflects the engine's role as infrastructure. A single-user local setup has different needs than a managed enterprise fleet. The engine handles both by keeping security composable rather than prescriptive.

## Defense in depth

The security model has four layers. Each layer operates independently. You can enable any combination.

| Layer | What it does | Default state |
|-------|-------------|---------------|
| [Permissions](permissions.md) | Controls which tools the LLM can invoke and what commands it can run | `allow` (all tools pass) |
| [Dangerous pattern detection](dangerous-patterns.md) | Flags risky shell commands before execution | Enabled with 35+ default patterns |
| [Sandbox](sandbox.md) | OS-level process isolation for tool execution | Disabled |
| [Secret redaction](secret-redaction.md) | Strips credentials from tool output before returning to the LLM | Disabled |

A fifth component, [audit logging](audit.md), records permission decisions for compliance and forensics. It is not a gating mechanism -- it observes and records.

## Where security config lives

Security settings can be set at any configuration layer:

- **User config** (`~/.ion/engine.json`): Personal defaults.
- **Project config** (`.ion/engine.json`): Per-project policy checked into version control.
- **Enterprise config** (MDM / system policy): Organization-wide constraints that cannot be weakened by lower layers.

Enterprise config seals security settings. If your IT team sets `permissions.mode` to `"ask"` via MDM, no project config can downgrade it to `"allow"`. See [Enterprise sealed config](../enterprise/sealed-config.md) for details.

## Opt-in philosophy

Nothing is locked down by default. This is intentional. The engine is a runtime, not an application. The harness engineer or IT admin decides what security posture fits their use case.

A minimal local setup might use no security features at all. A managed enterprise deployment might enable all four layers plus audit logging, enforced via sealed config. Both are valid configurations.

## Next steps

- [Permissions](permissions.md) -- permission modes, rules, and evaluation order
- [Dangerous patterns](dangerous-patterns.md) -- risky command detection and customization
- [Sandbox](sandbox.md) -- OS-level process isolation
- [Secret redaction](secret-redaction.md) -- credential stripping from tool output
- [Audit logging](audit.md) -- permission decision records
