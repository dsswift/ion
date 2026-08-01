---
title: Telemetry
description: Telemetry targets, OpenTelemetry export, privacy levels, and batch settings.
sidebar_position: 5
---

# Telemetry

The engine's telemetry system collects session activity, permission decisions, and usage metrics. It supports multiple export targets and integrates with OpenTelemetry for enterprise observability stacks.

Telemetry is disabled by default. Enterprise config can enable it and enforce collection across all sessions.

## Configuration

### Minimal configuration

Enabling telemetry with no other fields is a complete, working configuration. When `targets` and `filePath` are omitted, the engine defaults to the file target at `~/.ion/telemetry.jsonl`:

```json
{
  "telemetry": {
    "enabled": true
  }
}
```

The engine fills in `targets: ["file"]` and expands `~/.ion/telemetry.jsonl` to the operator's home directory automatically. No additional fields are required to start capturing telemetry locally.

Any field the operator sets explicitly is never overridden. If `targets` is set (e.g. `["http"]`), no file target is injected. If `filePath` is set, it is kept as-is.

### Full configuration

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["http", "file", "otel"],
    "httpEndpoint": "https://siem.corp.example.com/ingest/ion",
    "httpHeaders": {
      "Authorization": "Bearer ingest-token",
      "X-Source": "ion-engine"
    },
    "filePath": "/var/log/ion/telemetry.jsonl",
    "privacyLevel": "standard",
    "batchSize": 100,
    "flushIntervalMs": 5000,
    "otel": {
      "enabled": true,
      "endpoint": "https://otel-collector.corp.example.com:4317",
      "protocol": "grpc",
      "headers": {
        "x-api-key": "otel-ingest-key"
      },
      "serviceName": "ion-engine",
      "resourceAttributes": {
        "deployment.environment": "production",
        "service.namespace": "ai-tools"
      }
    }
  }
}
```

## Targets

The `targets` array specifies where telemetry data is sent. Multiple targets can be active simultaneously.

| Target | Description | Required fields |
|--------|-------------|-----------------|
| `http` | Send batched JSON payloads to an HTTP endpoint | `httpEndpoint` |
| `file` | Write JSON lines to a local file | `filePath` |
| `otel` | Export via OpenTelemetry protocol | `otel.endpoint` |

### HTTP target

Sends telemetry as JSON arrays to the configured endpoint via POST requests. Each batch contains up to `batchSize` entries.

| Field | Type | Description |
|-------|------|-------------|
| `httpEndpoint` | `string` | URL to POST telemetry batches to |
| `httpHeaders` | `map[string]string` | Custom headers included with each request |

The engine retries failed HTTP sends with exponential backoff. After 3 consecutive failures, it buffers entries locally and retries on the next flush interval.

### File target

Writes telemetry entries as newline-delimited JSON (one entry per line) to a local file.

| Field | Type | Description |
|-------|------|-------------|
| `filePath` | `string` | Absolute path to the output file. The engine creates the file if it does not exist. |

The file target is useful for local debugging, compliance archives, or feeding into a log shipping agent (Filebeat, Fluentd, Vector).

### OpenTelemetry target

Exports telemetry as OpenTelemetry spans and log records to an OTEL collector.

| Field | Type | Description |
|-------|------|-------------|
| `otel.enabled` | `bool` | Enable OTEL export |
| `otel.endpoint` | `string` | OTEL collector endpoint |
| `otel.protocol` | `string` | Transport protocol: `"grpc"` or `"http"` |
| `otel.headers` | `map[string]string` | Custom headers for the OTEL exporter |
| `otel.serviceName` | `string` | Service name reported in OTEL resource |
| `otel.resourceAttributes` | `map[string]string` | Additional OTEL resource attributes |

The OTEL integration maps Ion Engine concepts to OTEL semantics:

| Ion concept | OTEL representation |
|-------------|---------------------|
| Session | Trace |
| Turn | Span |
| Tool invocation | Child span |
| Permission decision | Span event |
| Audit entry | Log record |

## Privacy levels

The `privacyLevel` field controls what data is included in telemetry:

| Level | What is collected |
|-------|-------------------|
| `minimal` | Session IDs, timestamps, tool names, decision outcomes. No input/output content. |
| `standard` | Everything in `minimal` plus tool input parameters and error messages. |
| `full` | Everything in `standard` plus tool output, LLM prompts, and response content. |

Default is `minimal`. Enterprise deployments that need full audit trails should set `full`, but be aware of the data volume and privacy implications.

## Batch settings

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `batchSize` | `int` | 100 | Maximum entries per batch before flushing |
| `flushIntervalMs` | `int64` | 5000 | Maximum time (ms) between flushes, regardless of batch size |

The engine flushes telemetry when either threshold is reached (whichever comes first). On session end, any remaining buffered entries are flushed immediately.

## Enterprise enforcement

When telemetry is enabled at the enterprise layer, it cannot be disabled by user or project config:

```json
{
  "enterprise": {
    "telemetry": {
      "enabled": true,
      "targets": ["http"],
      "httpEndpoint": "https://siem.corp.example.com/ingest/ion",
      "privacyLevel": "standard"
    }
  }
}
```

This guarantees that all sessions produce telemetry records shipped to the configured destination. Users cannot opt out.

## Operational logs vs. telemetry

The engine produces two distinct observability streams. They are complementary, not redundant.

| Dimension | Operational logs | Telemetry |
|---|---|---|
| Format | JSONL (one structured line per event) | OpenTelemetry spans and log records |
| Emitter | `utils.Log` / `utils.LogCtx` (Go slog) | `internal/telemetry` package |
| Destination | `~/.ion/*.jsonl` (local); optional downstream egress via `logging.egressTargets` (HTTP endpoint or OTLP collector); Loki (observability stack) | File, HTTP endpoint, or OTLP collector |
| Purpose | Real-time debugging, investigation, agent guidance | Session metrics, audit trail, enterprise compliance |
| Enabled by default | Yes — always on (local file); egress is opt-in | No — opt-in via config |

Operational logs are no longer local-only. The `logging.egressTargets` config (`"http"` and/or
`"otel"`) ships every operational log line downstream in addition to the local file, using the same
config shape as telemetry's targets — so an enterprise can point both streams at the same collector.
Enterprise config can seal egress on so users cannot disable it. See
[`docs/observability/consuming-logs.md`](../observability/consuming-logs.md) for the full egress
reference and consumer guide.

### Correlation model

Every log line and every telemetry event emitted during a run carries the same `trace_id`, and every
line belonging to a session carries the same `session_id`. That lets you move between the two streams
without losing the thread:

1. Find an error in Loki: `{level="ERROR"} | json | session_id = "01932abc1234"`
2. Copy the `trace_id` from that log line — it identifies the single run the error occurred in
3. Pull every line from that run across all surfaces:
   `{component=~".+"} | json | trace_id = "..."`, or open the span tree in whichever OTLP backend the
   run's spans were exported to
4. Widen to the whole conversation with `conversation_id` when you need the history around the failure

**Pick the ID that matches the granularity you want.** `trace_id` is scoped to **one
prompt-to-completion run** — it is the APM operation id and the value that belongs in a
`traceparent` header for a downstream call. `conversation_id` is the durable thread across restarts.
`session_id` groups the runs that shared one live session. `run_id` is the engine-native form of the
same run `trace_id` names, for joining Ion's own two streams. Full table:
[`log-schema.md`](../observability/log-schema.md) § "Correlation-ID vocabulary".

The `trace_id` field is a W3C trace-context trace-id (32 lowercase hex). The `span_id` field is a
16-hex span ID. Both are omitted when no run is in flight — a session-lifecycle line or an async
delivery has no transaction to trace, so it carries neither.

### Schema reference

The full JSONL schema — all fields, types, required/optional status, and the Loki label policy — is documented at [`docs/observability/log-schema.md`](../observability/log-schema.md).
