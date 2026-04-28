---
title: Audit Logging
description: Permission decision records, audit entry format, and integration with telemetry.
sidebar_position: 6
---

# Audit Logging

The engine logs every permission decision as a structured audit entry. Audit entries record what tool was called, what the LLM asked it to do, and whether the call was allowed, denied, or required user approval.

Audit logging is always active when the permission system is configured. It does not need to be enabled separately.

## Audit entry format

Each entry contains:

| Field | Type | Description |
|-------|------|-------------|
| `timestamp` | `int64` | Unix timestamp (milliseconds) when the decision was made |
| `tool` | `string` | Tool name (e.g., `"Bash"`, `"Write"`, `"Read"`) |
| `input` | `object` | Tool input parameters as provided by the LLM |
| `decision` | `string` | The outcome: `"allow"`, `"deny"`, or `"ask"` |
| `reason` | `string` | Why this decision was made (e.g., `"matched rule"`, `"dangerous pattern"`, `"mode default"`) |
| `rule` | `string` | The specific rule that matched, if any. Empty string when the mode default applies. |
| `sessionID` | `string` | The session that generated this entry |

### Example entry

```json
{
  "timestamp": 1714000000000,
  "tool": "Bash",
  "input": {
    "command": "rm -rf /tmp/build"
  },
  "decision": "deny",
  "reason": "dangerous pattern: rm -rf",
  "rule": "",
  "sessionID": "sess_abc123"
}
```

## Storage

Audit entries flow through the engine's telemetry system. Where they end up depends on your telemetry configuration:

| Target | Description |
|--------|-------------|
| `file` | Written to a local file (JSON lines format). Path configured via `telemetry.filePath`. |
| `http` | Sent to an HTTP endpoint as batched JSON payloads. |
| `otel` | Exported as OpenTelemetry spans or log records. |

If no telemetry target is configured, audit entries are written to the engine's standard log output.

See [Enterprise telemetry](../enterprise/telemetry.md) for full telemetry configuration.

## What gets logged

The audit system records:

- Every tool call that goes through the permission system, regardless of outcome
- The decision and the reason (which rule matched, or that the mode default applied)
- Whether a dangerous pattern was detected
- Whether the user was prompted (in `ask` mode) and what they chose

The audit system does not record:

- Tool output or results (use telemetry for full request/response logging)
- Redacted secret values (the audit entry notes that redaction occurred, not what was redacted)
- Extension hook invocations (hooks have their own lifecycle events)

## Enterprise audit requirements

Enterprise deployments often require audit trails for compliance. The enterprise config can enforce telemetry settings that ensure audit entries are shipped to a central system:

```json
{
  "enterprise": {
    "telemetry": {
      "enabled": true,
      "targets": ["http", "otel"],
      "httpEndpoint": "https://siem.corp.example.com/ingest/ion",
      "privacyLevel": "full"
    }
  }
}
```

When telemetry is enabled at the enterprise layer, it cannot be disabled by lower config layers. This guarantees that audit entries are always captured and forwarded.
