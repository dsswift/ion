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
    "maxSizeMB": 20,
    "maxFiles": 3,
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
| `file` | Write schema-v4 compact frames, one JSON line each, to a local file | `filePath` (defaults to `~/.ion/telemetry.jsonl`) |
| `stdout` | Write the same JSON lines to the engine's standard output | none |
| `otel` | Export via OpenTelemetry protocol | `otel.endpoint` |
| `eventhub` | Send events to an Azure Event Hub | `eventHubConnectionString` |

### HTTP target

Sends telemetry as JSON arrays to the configured endpoint via POST requests. Each batch contains up to `batchSize` entries.

| Field | Type | Description |
|-------|------|-------------|
| `httpEndpoint` | `string` | URL to POST telemetry batches to |
| `httpHeaders` | `map[string]string` | Custom headers included with each request |
| `httpRetryQueueMaxMB` | `int` | Optional hard cap on the on-disk retry queue. Unbounded by default. See "Durable delivery" below. |
| `retryQueueSoftWarnMB` | `int` | Advisory backlog threshold for the telemetry-health signal (default `500`). Never drops anything. |
| `retryQueueStuckAfterMinutes` | `int` | How long the oldest undelivered batch may wait before the target is reported stuck (default `15`). |

#### Durable delivery

A failed POST does not drop the batch. The engine persists it to an on-disk retry queue (one file per collector instance, alongside the configured `filePath` when set, or `<data dir>/<target>-retry-<hash>.jsonl` otherwise, where the data dir is `ION_DATA_DIR` or `~/.ion`) and redelivers it FIFO on the next flush tick, with exponential backoff between attempts on a batch that keeps failing (starting at 5s, doubling up to a 5-minute ceiling). This applies identically to the `conversationEvents.targets: ["http"]` target below, and to the `eventhub` target's own retry queue, since all three route through the same retry-queue mechanism. A queue drains only while its target is configured: at startup the engine removes a data-dir queue file that no configured target uses, logging a WARN (`orphaned retry queue removed`) with the batch and event counts it held. Removing a target is the decision to stop sending there; re-add it before restarting if its backlog should still be delivered.

**The queue is unbounded by default.** It carries an audit stream, and a dropped batch is a hole in that record at exactly the moment the downstream was unreachable. A hard cap is an explicit opt-in (`httpRetryQueueMaxMB` / `eventHubRetryQueueMaxMB` greater than zero): entries beyond it are dropped oldest-first, every drop logs a `WARN` with the count, and the engine logs a `WARN` at startup naming the cap so the loss is always a choice someone made. Prefer watching the health signal over capping.

**Telemetry on whether telemetry is flowing.** The retry queue reports its state as the typed `engine_telemetry_health` event — a complete snapshot per target that a consumer replaces rather than merges. It escalates on three independent conditions:

| Condition | Fires when | Fields to read |
|---|---|---|
| Backlog size | queued bytes cross 50 / 75 / 85 / 95 % of `retryQueueSoftWarnMB`, and once more on draining back to zero | `telemetryPercentOfSoftWarn`, `telemetryCrossedThreshold`, `telemetryQueuedEvents`, `telemetryQueuedBytes` |
| Backlog age | the oldest undelivered batch has waited past `retryQueueStuckAfterMinutes`, at any size, and again when it drains | `telemetryStuck`, `telemetryOldestAgeMs`, `telemetryMaxAttempts` |
| Quarantine | an event was written to the quarantine file instead of sent (see "Size contract" under the Event Hub target) | `telemetryQuarantinedEvents`, `telemetryQuarantinedBytes` |
| Critical | a queue write failed because the disk is full: the batch is neither delivered nor persisted | `telemetryCritical`, `telemetryLastError` |

Age escalates independently of size on purpose. A small batch that can never be delivered fails every backoff cycle without ever crossing a size notch; before the stuck signal existed, one such batch retried 255 times over several hours in silence. The Ion desktop turns each of these into an operator notification; a headless consumer may page, chart, or ignore them.

### File target

Writes telemetry as newline-delimited JSON to a local file. Schema v4 stores compact frames, each of which can contain more than one event.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `filePath` | `string` | `~/.ion/telemetry.jsonl` | Absolute path to the output file. The engine creates the file if it does not exist. |
| `maxSizeMB` | `int` | `20` | Size cap on the live file before it is rotated. |
| `maxFiles` | `int` | `3` | Number of rotated archives retained beside the live file. Negative retains none — the live file is discarded at the cap. |
| `disableRotation` | `bool` | `false` | Disable size-based rotation entirely, restoring unbounded append. |

The file target is useful for local debugging, compliance archives, or feeding into a log shipping agent (Filebeat, Fluentd, Vector).

#### Rotation and the disk bound

The live file is bounded by `maxSizeMB` and rotated by rename — `telemetry.jsonl` becomes `telemetry.jsonl.1`, existing archives shift to `.2`, `.3`, and so on, and the oldest beyond `maxFiles` is dropped. Total disk for the target is therefore `maxSizeMB × (maxFiles + 1)`, or **80 MB** at the defaults.

Rotating by rename rather than truncating in place is what keeps a concurrent reader correct: a shipping agent that handles rename rotation can finish the old inode and continue at the new live path. The engine logs the resolved policy at startup and every rotation at `INFO`, so the live bound is visible in `~/.ion/engine.jsonl` without reading config.

Shipping telemetry downstream does **not** bound the local file — a shipper advances a read offset, it does not truncate. Rotation is the only thing that caps local disk, and it is independent of retention at the collector, which is the collector's policy to set.

`disableRotation` exists for operators who need the complete local stream (a compliance archive rotated by an external tool, for instance). It restores the unbounded growth that rotation exists to prevent, and the engine logs a `WARN` at startup when it is set.

### OpenTelemetry target

Exports telemetry as OpenTelemetry **traces** to an OTLP receiver. It sends no OTLP log records (operational logs go out through `logging.egressTargets: ["otel"]` instead) and, unless `otel.metrics` is enabled, no metrics.

| Field | Type | Description |
|-------|------|-------------|
| `otel.enabled` | `bool` | Enable OTEL export |
| `otel.endpoint` | `string` | OTEL collector endpoint |
| `otel.protocol` | `string` | Transport protocol: `"http/protobuf"` (default) or `"grpc"`. Any other value fails the exporter and is logged. |
| `otel.headers` | `map[string]string` | Custom headers for the OTEL exporter |
| `otel.serviceName` | `string` | Service name reported in OTEL resource |
| `otel.resourceAttributes` | `map[string]string` | Additional OTEL resource attributes |
| `otel.tokenScope` | `string` | Mint a fresh bearer token for this scope before each trace and metrics export and send it as `Authorization`, over any static header. `otel.metrics.tokenScope` wins for metrics |
| `otel.tokenProvider` | `string` | Name of the `auth.oauth` entry that mints the `otel.tokenScope` and `otel.metrics.tokenScope` tokens. Empty uses `auth.identityProvider`. Name a `machineIdentity` entry so a headless engine with no signed-in operator can export. An entry also named by `logging.egressTokenProvider` is shared |

How Ion events map to OTLP:

| Ion | OTLP |
|-----|------|
| Every telemetry event (`llm.call`, `tool.execute`, `run.complete`, …) | One zero-length span named after the event, its payload as span attributes and its correlation context as `ctx.*` attributes |
| The event's correlation `trace_id` | The span's trace, so every event of one run lands in one trace |
| An event whose payload carries an error | The span's status set to error with that message |
| A timed span the engine records directly | A span with its real start and end |

With the HTTP protocol, an endpoint with no path gets `/v1/traces`.

### System Metrics

The engine samples System Metrics whether or not telemetry is on: host CPU, memory (container-aware), load and disk, and CPU and memory for every process in its own tree, labeled by role (`engine`, `extension`, `mcp`, `backend`, `tool`). The numbers leave the machine only through the two outputs below. The map of every output is [Signals and where they go](../observability/README.md#signals-and-where-they-go); the sampler's settings are [`systemMetrics`](../configuration/engine-json.md#systemmetrics).

**The `system.metrics` event.** While `telemetry.enabled` is true, the engine records one `system.metrics` event every `systemMetrics.telemetryIntervalMs` (default 60000) through the normal targets. Its payload is numbers plus each process's role and name: `sampled_at`, `interval_ms`, `host` (`cpu_utilization`, `cpu_count`, `effective_cpu_count`, `memory_total_bytes`, `memory_available_bytes`, `memory_limit_bytes`, `container_limited`, `load1`, `disk_total_bytes`, `disk_free_bytes`), `processes[]` (`role`, `name`, `cpu_percent`, `cpu_time_ms`, `rss_bytes`), and `runtime` (`heap_bytes`, `sys_bytes`, `mem_limit_bytes`, `goroutines`, `num_gc`, `sessions`). It carries no content, so `privacyLevel` does not change it.

**OTLP metrics.** `otel.metrics` exports System Metrics as OTLP metrics, off unless `otel.metrics.enabled` is true:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `otel.metrics.enabled` | `bool` | `false` | Turn the export on |
| `otel.metrics.exportIntervalMs` | `int` | `60000` | Export interval |
| `otel.metrics.endpoint` | `string` | `otel.endpoint` + `/v1/metrics` | A receiver that takes metrics at its own URL. An endpoint with a path is used as given |
| `otel.metrics.temporality` | `string` | `cumulative` | `cumulative` or `delta` |
| `otel.metrics.tokenScope` | `string` | `otel.tokenScope` | Mint a fresh token from `otel.tokenProvider` for this scope before each export and send it as `Authorization`, over any static header |

It shares `otel.protocol`, `otel.headers`, `otel.serviceName`, `otel.resourceAttributes`, `otel.tokenScope`, and `otel.tokenProvider` with the trace export. Instruments: gauges `ion.host.cpu.utilization`, `ion.host.memory.available`, `ion.host.memory.limit` (physical memory when no container limit applies), `ion.host.disk.free`, `ion.process.cpu.utilization` (cores in use), `ion.process.memory.rss`, `ion.engine.heap`, `ion.engine.goroutines`, `ion.engine.sessions`, and the counter `ion.system_metrics.samples`. The only attribute is `role` on the two `ion.process.*` gauges: a per-process or per-name label would multiply the series a metrics store keeps. No key is built in. An enterprise that seals `telemetry` on can seal the whole `otel` block, `metrics` included.

### Sending System Metrics to Application Insights

Application Insights created with **OTLP support** stores logs and traces in a Log Analytics workspace and OTLP metrics in a linked **Azure Monitor workspace** (a hosted Prometheus you query with PromQL). Its Overview page lists a separate ingestion address per signal; the metrics one is on a `*.metrics.ingest.monitor.azure.com` host.

**Ion cannot send to it directly.** Azure Monitor ingestion accepts only an app or workload identity holding **Monitoring Metrics Publisher** on the data collection rule, never a person's delegated token, and Application Insights requires **delta temporality** and exponential histograms. So the engine sends to an OpenTelemetry Collector, and the Collector does the rest:

1. The engine sends OTLP metrics to the Collector with the operator's Entra token (`tokenScope` set to the Collector's audience).
2. The Collector checks that token (`oidcauthextension`), converts cumulative to delta (`cumulativetodelta`), and signs in to Azure Monitor with its own workload identity (`azureauthextension`, scope `https://monitor.azure.com/.default`).
3. Grafana reads the Azure Monitor workspace through a Prometheus data source, beside Log Analytics through the Azure Monitor data source.

Engine config (all values are placeholders):

```json
{
  "telemetry": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "https://otel-collector.example.org",
      "serviceName": "ion-engine",
      "metrics": {
        "enabled": true,
        "tokenScope": "api://collector-app-id/Telemetry.Write"
      }
    }
  }
}
```

Collector config (contrib distribution, placeholders only):

```yaml
extensions:
  oidc:
    issuer_url: https://login.microsoftonline.com/<tenant-id>/v2.0
    audience: api://collector-app-id
  azure_auth:
    managed_identity: {}
    scopes: [https://monitor.azure.com/.default]

receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        auth: { authenticator: oidc }

processors:
  batch:
  cumulativetodelta:

exporters:
  otlphttp/azuremonitor:
    traces_endpoint: https://<logs-dce>/datacollectionRules/<dcr-immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces
    logs_endpoint: https://<logs-dce>/datacollectionRules/<dcr-immutable-id>/streams/Microsoft-OTLP-Logs/otlp/v1/logs
    metrics_endpoint: https://<metrics-dce>/datacollectionRules/<dcr-immutable-id>/streams/Custom-Metrics-Otel/otlp/v1/metrics
    auth: { authenticator: azure_auth }

service:
  extensions: [oidc, azure_auth]
  pipelines:
    traces:  { receivers: [otlp], processors: [batch], exporters: [otlphttp/azuremonitor] }
    logs:    { receivers: [otlp], processors: [batch], exporters: [otlphttp/azuremonitor] }
    metrics: { receivers: [otlp], processors: [cumulativetodelta, batch], exporters: [otlphttp/azuremonitor] }
```

When a receiver takes metrics at its own URL and needs delta itself (a direct ingestion endpoint with an app identity, for example), set `otel.metrics.endpoint` and `otel.metrics.temporality: "delta"` on the engine instead. Sources: [Ingest OTLP data into Azure Monitor with the OpenTelemetry Collector](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion), [Direct OpenTelemetry ingestion into Azure Monitor](https://techcommunity.microsoft.com/blog/azureobservabilityblog/direct-opentelemetry-ingestion-into-azure-monitor-is-now-generally-available/4524044).

### Event Hub target

Sends events to an Azure Event Hub over AMQP, using the official `azeventhubs` Go SDK. Authentication is by the engine's own identity or by connection string — see "Event Hub authentication" below. The local Docker emulator has no Microsoft Entra ID support, so a connection string is the way to reach it for testing.

| Field | Type | Description |
|-------|------|-------------|
| `eventHubConnectionString` | `string` | Azure Event Hubs connection string. Supports `UseDevelopmentEmulator=true` for the local emulator. |
| `eventHubName` | `string` | Event Hub name. Omit when the connection string already carries an `EntityPath=...` segment. |
| `eventHubRetryQueueMaxMB` | `int` | Optional hard cap on the on-disk retry queue. Unbounded by default — see "Durable delivery" above. |
| `eventHubMaxMessageBytes` | `int` | Overrides the per-message size events are fitted to. Zero (default) negotiates the limit from the AMQP link. See "Size contract" below. |
| `oversizeEventPolicy` | `string` | `segment` (default) or `quarantine`. What happens to an event larger than the transport's maximum message size. See "Size contract" below. |

#### Size contract

Event Hubs accepts a bounded message. The engine learns the exact bound from the AMQP link when the producer connects (the SDK refuses to build a batch above it, and the engine searches that refusal for the limit, so nothing is hard-coded and the emulator, Standard, and Premium tiers each get their own value), and every event is fitted to it **before** it is sent or written to the retry queue. The queue therefore only ever holds messages the transport has agreed it can carry — an undeliverable event can no longer sit in a batch retrying forever and holding the deliverable events beside it hostage.

The conversation stream is where this matters: a tool that returns 50 MB produces a 50 MB `conversation.tool_call`, and the emitter neither truncates nor redacts it. An event over the limit is handled by `oversizeEventPolicy`:

- **`segment`** (default). The payload's largest string field — `output` on a tool call, `input.content` on a Write — is split across as many events as needed. Every part carries the full envelope, including the same `event_id`, and every other payload field; only the split field differs, and a `payload.segment` block (`part`, `parts`, `field`, `total_bytes`, `sha256`) tells a consumer how to put it back. Nothing is lost, no second store is needed, and the published schema documents the block. Splits fall on UTF-8 rune boundaries.
- **`quarantine`**. The event is written whole, with the reason, to a quarantine file beside the retry queue (`<queue>.quarantine.jsonl`) and never sent. It is preserved on the device, not in the stream.

An event that cannot be delivered under either policy — the envelope alone exceeds the limit, or the payload holds no string to split — is quarantined rather than retried. Every quarantine logs at `ERROR` with the event id and conversation id and raises `telemetryQuarantinedEvents` on the health event, so an operator hears that content left the stream. If the link's limit cannot be negotiated (the hub is down at startup), the engine uses `eventHubMaxMessageBytes` when set and otherwise the published 1 MiB default, logs which, and delivery proceeds.

A consumer reassembles a segmented event by grouping on `event_id`, ordering by `segment.part`, concatenating `segment.field` across the parts, and checking the result against `segment.total_bytes` and `segment.sha256`. The deduplication key for the stream is `event_id` alone for an unsegmented event and `(event_id, segment.part)` for a segmented one. A conversation's events are ordered by `ts` parsed as a timestamp, then by `payload.seq` — a per-conversation counter the engine assigns in the same critical section as `ts`, so the two orderings never disagree within one engine process (`seq` restarts at 1 across an engine restart; `ts` carries the order over that boundary). `samples/conversation-pipeline/` is a reference consumer that does exactly this against the local emulator.

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["eventhub"],
    "eventHubConnectionString": "Endpoint=sb://ion-telemetry.servicebus.windows.net/;SharedAccessKeyName=ingest;SharedAccessKey=<key>",
    "eventHubName": "ion-telemetry"
  }
}
```

Local testing against the [Event Hubs emulator](https://learn.microsoft.com/en-us/azure/event-hubs/test-locally-with-event-hub-emulator):

```json
{
  "eventHubConnectionString": "Endpoint=sb://localhost;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=SAS_KEY_VALUE;UseDevelopmentEmulator=true;",
  "eventHubName": "eh1"
}
```

### Event Hub authentication

The `eventhub` target resolves its credential in this order:

1. **`ION_EVENTHUB_CONNECTION_STRING`** environment variable, if set. Highest precedence so a container deployment can mount a secret it already manages rather than baking one into an image or a config file.
2. **`eventHubNamespace`** — token authentication, no secret. Preferred.
3. **`eventHubConnectionString`** — shared-secret authentication.

If none is configured the target fails loudly at construction naming all three, rather than silently accepting a target it cannot reach.

#### Prefer token authentication for a fleet

A connection string is a shared secret. Distributing one to managed devices puts the same key on every machine: any holder can write to the hub, revoking one device means rotating the key for all of them, and every sender is indistinguishable at the transport.

Setting `eventHubNamespace` instead ships nothing secret. The engine authenticates with its existing identity (`auth.identityProvider`) — a signed-in user on a desktop install, a machine identity on a headless one — and authorization becomes an RBAC role assignment revocable per principal.

| Field | Purpose |
|---|---|
| `eventHubNamespace` | Fully qualified namespace host, e.g. `orion-events.servicebus.windows.net` |
| `eventHubName` | Target hub. Required for token auth (no EntityPath to fall back on) |
| `eventHubTokenScope` | Defaults to `https://eventhubs.azure.net/.default` |
| `eventHubTokenAudience` | For identity providers that bind grants to an explicit audience |

Grant the sending principals the **Azure Event Hubs Data Sender** role. That is send-only, so a client can write to the stream but never read it back — which is usually the property you want for an audit stream.

> **The Event Hubs scope is not your API's scope.** Event Hubs is a distinct resource and rejects a token audienced to anything else, so `eventHubTokenScope` cannot reuse a scope like `logging.egressTokenScope` that targets your own API. The app registration needs delegated permission to the Event Hubs API in addition to its own.

> **What the credential does and does not prove.** Authentication authorizes the *transport* — it establishes that the sender may write to this hub. It does not attest the `user` value inside the event payload, and no Event Hubs mechanism propagates the authenticated sending principal to a consumer. See the `user` field in [`conversation-events.schema.json`](../observability/conversation-events.schema.json) for the full trust model.

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
| `batchSize` | `int` | unset (0) | Buffered entries that trigger an early flush. When unset or 0, there is no size trigger and only the interval flushes. |
| `flushIntervalMs` | `int64` | 5000 | Maximum time (ms) between flushes, regardless of batch size |

The engine flushes telemetry on every `flushIntervalMs` tick, and also as soon as the buffer reaches `batchSize` when that is set above 0. On session end, any remaining buffered entries are flushed immediately.

The OpenTelemetry target batches its spans separately: its exporter sends at most 100 spans per export. That limit is internal to the `otel` target and is not set by `batchSize`.

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

This guarantees that all sessions produce telemetry records shipped to the configured destination. Users cannot opt out. The seal carries `enabled`, `targets`, `privacyLevel`, each target's destination (`httpEndpoint`, `httpHeaders`, the `eventHub*` fields), `oversizeEventPolicy`, and the whole `otel` block including `otel.metrics`. An enterprise `systemMetrics` block likewise replaces the user's whole block (see [System Metrics](#system-metrics)).

## Conversation events

`conversationEvents` is a **fully independent** top-level config block, sibling
to `telemetry` — not a level under `telemetry.privacyLevel`, not a target
under `telemetry.targets`, and not gated on `telemetry.enabled`. It carries
its own `Collector` instance with its own buffer, flush loop, and targets.
Enabling one has no effect on the other in either direction.

It powers the `conversation.*` event family (`conversation.user_message`,
`conversation.assistant_message`, `conversation.tool_call`,
`conversation.lifecycle`) — a **full-fidelity security/audit stream**: raw
user message text, raw assistant response text, and raw tool input/output,
plus per-call cost where the backend can supply it. There is no
privacy-level gate on this family (it never reads `privacyLevel` at all) —
it is a raw audit trail by design, not a metrics stream with a lower-fidelity
tier to opt into. Payload reference:
[`docs/observability/log-schema.md`](../observability/log-schema.md) §
"`conversation.*` event family".

**The machine-readable contract is
[`docs/observability/conversation-events.schema.json`](../observability/conversation-events.schema.json)**
(JSON Schema 2020-12) — the artifact to validate ingestion against, covering
the envelope and all four event payloads. It is not a hand-maintained
description: `TestPublishedSchema_ValidatesRealEmittedEvents` validates events
the emitter actually produces against the committed document, and a companion
test proves the schema rejects off-contract events, so the two cannot drift.
Evolution is additive within a `schema` major — new optional fields may appear
at any time and a consumer must ignore unknown ones; a breaking change bumps
the `schema` value.

Every event carries a five-key correlation envelope: **user** (the
enterprise-auth identity when OIDC context is present), **device**
(`install_id`, stamped on every event), **conversation** (`conversation_id`),
**event** (`event_id`, unique per event), and **trace** (`trace_id`, the
run this event belongs to — present but empty, never omitted, when no run is
in flight). `parent_span_id` is present on the same terms for a future
per-turn span identity; it is empty until the engine tracks one.

An extension may attach its own structured metadata to any event via the
`before_conversation_event` hook — see
[`docs/hooks/reference.md`](../hooks/reference.md) § "Conversation Event
Metadata". The returned data lands under the event's `extension_metadata`
key, unmodified and uninterpreted by the engine.

```json
{
  "conversationEvents": {
    "enabled": true,
    "targets": ["http"],
    "httpEndpoint": "https://events.corp.example.com/ingest/ion-conversations"
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `bool` | `false` | Turns the conversation-events collector on. |
| `targets` | `[]string` | `["file"]` when `enabled` and unset | Same target vocabulary as `telemetry.targets` (`http`, `file`, `otel`, `eventhub`). |
| `httpEndpoint` | `string` | — | POST destination when `targets` includes `http`. |
| `httpHeaders` | `map[string]string` | — | Custom headers for the HTTP target. |
| `httpRetryQueueMaxMB` | `int` | unbounded | Optional retry-queue cap for the `http` target — see "Durable delivery" above; the same mechanism backs this family's `http` target. |
| `filePath` | `string` | `~/.ion/conversation-events.jsonl` when `targets` includes `file` and unset | Distinct default file — never `telemetry.jsonl`. |
| `batchSize` | `int` | Collector default | Entries per flush. |
| `flushIntervalMs` | `int64` | `5000` | Same default cadence as `telemetry`. |
| `otel` | object | — | Same shape as `telemetry.otel`. |
| `maxSizeMB` / `maxFiles` | `int` | Collector defaults | Same rotation semantics as `telemetry`'s file target. |
| `eventHubConnectionString` / `eventHubName` / `eventHubNamespace` | `string` | — | Same as `telemetry`'s Event Hub target fields, above. |
| `eventHubRetryQueueMaxMB` | `int` | unbounded | Optional retry-queue cap for the `eventhub` target — same mechanism as `httpRetryQueueMaxMB`. |
| `retryQueueSoftWarnMB` / `retryQueueStuckAfterMinutes` | `int` | `500` / `15` | Health-signal thresholds — see "Durable delivery" above. |
| `eventHubMaxMessageBytes` / `oversizeEventPolicy` | `int` / `string` | negotiated / `segment` | The transport size contract — see "Size contract" above. This is the block where it matters: tool output is unbounded. |

No field inherits from `telemetry.*` — an empty `conversationEvents` field
defaults on its own terms, even when `telemetry` is fully configured. An
operator who wants event-stream cost data in one pipe (an Azure Event Hub,
say) and general audit telemetry in another (OTLP-to-App-Insights) points
each block at its own destination independently.

## Operational logs vs. telemetry

The engine produces two distinct observability streams. They are complementary, not redundant. System Metrics ride both (sample lines in the logs, `system.metrics` events in telemetry) and have their own OTLP metrics output; [Signals and where they go](../observability/README.md#signals-and-where-they-go) maps every output in one place.

| Dimension | Operational logs | Telemetry |
|---|---|---|
| Format | JSONL (one structured line per event) | JSONL schema-v4 compact frames; optionally OpenTelemetry traces through the `otel` target (one zero-length span per event) |
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

A prompt is one trace. The client that sends it starts the trace, and the relay, the server, and the
engine's run join it, so every log line and telemetry event about that prompt, on every surface,
carries the same `trace_id`. Every line belonging to a session carries the same `session_id`. That
lets you move between the streams without losing the thread:

1. Find an error in Loki: `{level="ERROR"} | json | session_id = "01932abc1234"`
2. Copy the `trace_id` from that log line — it identifies the prompt the error occurred in
3. Pull every line of that prompt across all surfaces:
   `{service_name=~".+"} | trace_id = "..."`, or open the span tree (client, relay, server,
   engine) in whichever OTLP backend the spans were exported to
4. Widen to the whole conversation with `conversation_id` when you need the history around the failure

**Pick the ID that matches the granularity you want.** `trace_id` is scoped to **one prompt**, from
the client's submit through the engine's run — it is the APM operation id and the value that belongs
in a `traceparent` header for a downstream call. `conversation_id` is the durable thread across
restarts. `session_id` groups the runs that shared one live session. `run_id` is the engine-native id
of the run alone, for joining Ion's own two streams. Spans and the hop chain:
[`log-schema.md`](../observability/log-schema.md#spans) § "Spans". Full table:
[`log-schema.md`](../observability/log-schema.md) § "Correlation-ID vocabulary".

The `trace_id` field is a W3C trace-context trace-id (32 lowercase hex). The `span_id` field is a
16-hex span ID. Both are omitted on a line about no prompt — a session-lifecycle line has no
transaction to trace, so it carries neither.

### Schema reference

Schema v4 uses compact frames in the local file. The telemetry forwarder expands frame and expanded-event records before it sends them to Alloy, so dashboard behavior and the expanded event contract remain stable. The full file and expanded-event schema is documented at [`docs/observability/log-schema.md`](../observability/log-schema.md).

### Schema versioning

A fleet is never on one build. Engines update at different times from the collector that reads them, in
both orders, so the reader is deliberately tolerant in one direction and strict in the other.

**Adding a field never bumps the schema number.** The decoder does not set `DisallowUnknownFields`, so a
reader handed a record carrying keys it predates keeps every field it knows and drops the rest. This is
the normal way the telemetry contract grows, and it needs no coordination between engine and collector.

**The number is reserved for a structural framing change** — a change to how records are framed or how
the interned identity and context tables are referenced, which an older reader cannot interpret at all.
Bumping it is a deliberate break, not routine evolution.

That gives the reader one rule, in `ValidateFrame`:

| Record's schema | Reader's behavior |
|---|---|
| Below the reader's `FrameVersion` | Accepted and expanded. The producer's own number is carried onto each expanded event, never relabelled as current. |
| Equal | Accepted. |
| Above | Rejected as an unsupported schema. |

**A record the reader cannot decode is dropped, not retried.** The forwarder advances its cursor past an
undecodable line and logs it at `WARN` with the byte offset and the decode error
(`telemetry forward dropped undecodable line`). It does this because the cursor only advances on a line
the handler accepts: returning the error instead would re-read the same offset on every poll and hold
every later line in the file behind one permanently unreadable one. Losing one line is recoverable;
losing the tail of the stream is not.

A push failure is the opposite case and behaves the opposite way. The line is good and the sink is
unavailable, so the cursor stays put and the next poll retries the same events.

### Two decoders, one fixture

The format has two implementations. The engine's is `engine/internal/telemetryformat`; the desktop's is
`desktop/src/main/telemetry-frame.ts`. The duplication is forced — the desktop is a TypeScript process
reading the same file, and it cannot call into Go — but two implementations of one format drift.

Both are pinned against [`assets/telemetry-frame-parity.json`](../../assets/telemetry-frame-parity.json),
generated from the Go decoder and asserted by both suites:

```bash
cd engine && go test ./internal/telemetryformat/ -run TestFrameParityFixture -update
```

A change to either decoder that is not mirrored in the other fails one of the two suites. When you
change expansion behavior, regenerate the fixture and run the desktop suite in the same commit.

**Whichever surface ships telemetry must expand frames first.** A frame line has no top-level `name` or
`payload`, so an egress path that does not expand it cannot recognize it as telemetry: it falls through
to the operational-record path, which puts the raw frame JSON in `msg` and drops every cost, kind, and
attribution attribute the dashboards query. The engine expands in
`engine/internal/utils/log_egress_tailer_telemetry.go`; the desktop expands in
`packages/shared/src/log-egress-tailer.ts` (which Electron's main process shares). Which surface actually ships is set by `egressShipSources` and
`egressClientShipSources` — either one may be the shipper, so both expand.
