---
title: Telemetry
description: Telemetry targets, OpenTelemetry export, privacy levels, and batch settings.
sidebar_position: 5
---

# Telemetry

The engine's telemetry system collects session activity, permission decisions, and usage metrics. It supports multiple export targets and integrates with OpenTelemetry for enterprise observability stacks.

Telemetry is disabled by default. Enterprise config can enable it and enforce collection across all sessions.

## Configuration

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
