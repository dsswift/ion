---
title: Configuration Overview
description: How Ion Engine loads and merges configuration from four layers.
sidebar_position: 1
---

# Configuration Overview

Ion Engine uses a four-layer configuration system. Each layer can override the one below it, and the top layer (enterprise) seals values that lower layers cannot change.

## Layers

From lowest to highest priority:

| Layer | Source | Purpose |
|-------|--------|---------|
| **Defaults** | Compiled into the engine binary | Baseline values for every field |
| **User** | `~/.ion/engine.json` | Personal settings that apply to all projects |
| **Project** | `.ion/engine.json` (in project root) | Per-project overrides (checked into version control) |
| **Enterprise** | MDM / system policy | Organization-wide constraints that cannot be weakened |

## Merge semantics

The engine loads each layer in order and merges them with a "last writer wins" strategy:

- **Scalar fields** (strings, booleans, numbers): higher layer replaces lower.
- **Map fields** (`providers`, `mcpServers`): keys from higher layers are merged into the map. A key in the project layer overrides the same key from the user layer, but does not remove other keys.
- **Pointer fields** (`limits.maxTurns`, `limits.maxBudgetUsd`, etc.): `nil` means "not set" and does not override a value from a lower layer. An explicit value (including zero) overrides.
- **Array/slice fields** (`profiles`): higher layer replaces the entire array. No element-level merge.

## Enterprise sealing

The enterprise layer behaves differently from the other three. Instead of a simple override, it enforces constraints as a ceiling:

- **Allowed/blocked models**: If `allowedModels` is set, only those models can be used. If `blockedModels` is set, those models are rejected. The engine falls back to the first allowed model if the configured default is restricted.
- **MCP allow/deny lists**: MCP servers not on the allowlist (or on the denylist) are removed from the merged config.
- **Telemetry**: If enterprise enables telemetry, lower layers cannot disable it.
- **Network**: Enterprise proxy and CA certificate settings override all lower layers.
- **Tool restrictions**: Enterprise can restrict which tools are available.

Enterprise values are not merged -- they are enforced after the three-layer merge is complete.

## File locations

### User config

| OS | Path |
|----|------|
| macOS | `~/.ion/engine.json` |
| Linux | `~/.ion/engine.json` |
| Windows | `%USERPROFILE%\.ion\engine.json` |

### Project config

Place an `engine.json` file at `.ion/engine.json` relative to your project root. The engine receives the project directory from the client at session start.

### Enterprise config

| OS | Primary source | Fallback |
|----|---------------|----------|
| macOS | `/Library/Managed Preferences/com.ion.engine.plist` | `ION_ENTERPRISE_CONFIG` env var |
| Linux | `/etc/ion/config.json` + `/etc/ion/config.d/*.json` | `ION_ENTERPRISE_CONFIG` env var |
| Windows | `HKLM\SOFTWARE\Policies\IonEngine` (registry) | `ION_ENTERPRISE_CONFIG` env var |
| All | `ION_ENTERPRISE_CONFIG` env var (checked first on all platforms) | -- |

On Linux, drop-in files in `/etc/ion/config.d/` are merged alphabetically on top of the main `/etc/ion/config.json`. This allows package managers and configuration management tools to deliver partial overrides.

### Profile config

Profiles are stored separately in `~/.ion/settings.json` under the `engineProfiles` key. See [Profile Configuration](settings-json.md) for details.

### Per-extension manifest

Extensions can declare build/load configuration in an `extension.json` file next to their entry point. The manifest is optional and entirely independent of the four-layer engine config above — it controls how a single extension is bundled and loaded, not engine behavior.

See [`extension.json` Reference](../extensions/extension-json.md) for the schema, when you need it, and worked examples.

## Quick example

User config (`~/.ion/engine.json`):

```json
{
  "defaultModel": "claude-sonnet-4-6",
  "providers": {
    "anthropic": {
      "apiKey": "ANTHROPIC_API_KEY"
    }
  },
  "limits": {
    "maxTurns": 100
  }
}
```

Project override (`.ion/engine.json`):

```json
{
  "defaultModel": "claude-haiku-4-5-20251001",
  "limits": {
    "maxBudgetUsd": 2.0
  }
}
```

Merged result: model is `claude-haiku-4-5-20251001`, max turns is 100 (from user), budget ceiling is $2.00 (from project).
