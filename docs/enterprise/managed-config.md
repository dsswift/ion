---
title: Managed Configuration Files
description: Project complete managed engine and model configuration files over the user and project files.
sidebar_position: 4
---

# Managed Configuration Files

[Sealed configuration](sealed-config.md) constrains named settings. It cannot say "this organization owns the whole file": a setting that sealing does not name stays editable by the user.

A **managed config projection** says exactly that. Enterprise policy names a managed engine file, a managed models file, or both. Each named file becomes the whole configuration for its surface. The user and project files contribute nothing to it.

## Declaring the managed files

Add a `managedConfig` block to the enterprise policy (see [MDM Deployment](mdm.md) for where policy lives on each platform):

```json
{
  "managedConfig": {
    "enginePath": "/Library/Application Support/Example/ion/engine.managed.json",
    "modelsPath": "/Library/Application Support/Example/ion/models.managed.json",
    "schemaVersion": 1,
    "disableUserMcpServers": false
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `enginePath` | string | Absolute path of the managed engine file. It has the [`engine.json`](../configuration/engine-json.md) schema. Omit it to leave engine configuration to its ordinary layers. |
| `modelsPath` | string | Absolute path of the managed models file. It has the [`models.json`](../configuration/models.md) schema. Omit it to leave model configuration to `~/.ion/models.json`. |
| `schemaVersion` | number | The managed-file schema the files were written for. This engine reads version `1`. |
| `disableUserMcpServers` | boolean | `true` stops users adding their own MCP servers beside the managed engine file's. Default `false`. See [User MCP servers](#user-mcp-servers). |

Put the managed files where a standard user cannot write, and make them readable by the user the engine runs as. The engine only reads them. Replace a file whole, by writing a temporary file and renaming it over the old one, so the engine never reads half a file.

Keep secrets out of the managed files. Provider keys stay in the user's own credential storage or in the environment.

## What a managed file changes

| Surface | Without a managed file | With a managed file |
|---------|------------------------|---------------------|
| Engine | Defaults, then `~/.ion/engine.json`, then the project's `.ion/engine.json` | Defaults, then the managed engine file. The user and project files are not read. The one exception is the user's own [MCP servers](#user-mcp-servers). |
| Models | `~/.ion/models.json` | The managed models file. `~/.ion/models.json` is not read. |

A key the managed file leaves out is absent. It resolves to the built-in default, never to a value in a user or project file. The managed file has to carry everything the deployment needs, including settings a client would otherwise write for itself, such as `backend`.

Sealing still applies on top of a managed engine file. Sealing with no `managedConfig` works exactly as before, and a policy with no `managedConfig` changes nothing on this page.

## User MCP servers

A managed engine file does not stop a user adding MCP servers of their own, unless policy says so.

With a managed engine file, `mcp_add`, `mcp_update`, and `mcp_remove` edit a separate file the user owns, `~/.ion/mcp/servers.json`, in place of `engine.json`. The engine reads that file for MCP servers only. Any other key in it is ignored, so it cannot carry another setting past the managed file.

| Rule | Behavior |
|------|----------|
| Name collision | The managed file's server wins. A user entry with the same name has no effect. |
| Managed servers | A server the managed file defines cannot be added over, updated, or removed. The command is refused with `managed_config_write_refused`, and the server is reported with `managed: true` in the `engine_mcp_servers` snapshot. |
| Enterprise lists | `mcpAllowlist` and `mcpDenylist` apply to user servers exactly as they do without a managed file. |
| Project files | A project's `.ion/engine.json` still contributes no MCP servers. |

Set `managedConfig.disableUserMcpServers` to `true` to turn this off. The user file is then not read, the managed file's servers are the only ones, and every MCP server write is refused. Ion Studio hides its Add button and says the organization manages the list.

To allow user servers but only from approved hosts, leave `disableUserMcpServers` off and set `mcpAllowlist`.

## Writes are refused

A write to an owned surface never reaches disk. The command fails, and its result carries the code `managed_config_write_refused`, so a client can explain the refusal:

```json
{"cmd":"result","requestId":"r7","ok":false,"error":"models configuration is owned by the managed source (enterprise policy managedConfig); set_model_tier was refused","code":"managed_config_write_refused"}
```

| Surface | Refused commands |
|---------|------------------|
| Engine | `mcp_add`, `mcp_update`, `mcp_remove`, when `disableUserMcpServers` is `true` or the write names a server the managed file defines |
| Models | `set_model_tier`, `remove_model_tier`, `set_default_provider` |

The Studio server refuses its own writes to `engine.json` the same way (the plan-mode Bash allowlist setting) and reads that setting from the managed file.

Each refusal writes a `WARN` log line `configuration write refused: surface is managed` and emits the telemetry event `enforcement.managed_config_write_refused`.

## When a managed file cannot be applied

A declared surface stays owned even when its file cannot be applied. It then holds built-in defaults, not the user's values, and the engine refuses every prompt with error code `managed_config_invalid` until the file is restored and the engine is restarted.

| Cause | Reported error |
|-------|----------------|
| `schemaVersion` is not one this engine reads | `unsupported managed config schema version N; this engine supports version 1` |
| The path is not absolute | `managed file path is not absolute` |
| The file does not exist | `managed file is missing` |
| The file cannot be read | `managed file is unreadable` |
| The file is not a JSON object | `managed file is not a JSON object` |
| The engine file does not decode as engine configuration | `managed file does not decode as engine configuration` |

The engine logs `ERROR` `managed config not applied; surface resolves to defaults` and emits `enforcement.managed_config_invalid`. Ion Studio shows a notice above the composer.

Roll the engine and the managed files back together. A file written for a newer schema version is refused by an older engine, by design.

## Verifying what is in force

`get_managed_config_status` reports the schema version and a checksum of each managed file. It never returns configuration content.

```json
{"cmd":"get_managed_config_status","requestId":"r8"}
```

```json
{
  "applied": {
    "schemaVersion": 1,
    "supportedSchemaVersion": 1,
    "engine": {"projected": true, "checksum": "sha256:9f2c..."},
    "models": {"projected": true, "checksum": "sha256:41ab..."}
  },
  "current": {
    "schemaVersion": 1,
    "supportedSchemaVersion": 1,
    "engine": {"projected": true, "checksum": "sha256:9f2c..."},
    "models": {"projected": true, "checksum": "sha256:41ab..."}
  }
}
```

`applied` is what the running engine loaded when it started. `current` is what the managed source holds now. When they differ, a managed file changed after the engine started. Model tiers and the settings the engine re-reads on each prompt already follow `current`. Everything else follows `applied` until the engine restarts.

The checksum is the SHA-256 of the file's bytes, so it can be compared with `shasum -a 256` of the file that was deployed.

Both are `null` when policy declares no managed file. The same status rides on the policy blob from [`get_enterprise_policy`](../protocol/client-commands.md#get_enterprise_policy) as `managedConfigStatus`. The engine stamps it, so a policy file cannot set it.
