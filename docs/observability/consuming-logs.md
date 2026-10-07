# Consuming Ion Logs

Ion treats its log output as a **published output contract**, documented with the same rigor as its
config inputs. This guide is for anyone building on that output: an operator tailing files with `jq`,
a platform team running the reference Loki/Grafana stack, or an enterprise shipping logs into an
existing SIEM or OTLP pipeline without any Ion-provided infrastructure.

Ion emits two structured NDJSON streams:

| Stream | What it answers | Files | Schema |
|---|---|---|---|
| **Operational log** | "What did the code do on this machine?" | `~/.ion/engine.jsonl`, `<ION_DATA_DIR>/server.jsonl`, `~/.ion/desktop.jsonl`, `~/.ion/ios-diagnostic-logs.jsonl`, relay `relay.jsonl` | Canonical log schema (unversioned, additive-only) |
| **Telemetry** | "What is happening across sessions, runs, and installs?" | `~/.ion/telemetry.jsonl` | Versioned event envelope (self-describing `schema` int) |

Both streams use snake_case throughout and share one correlation vocabulary, so a single join key
pivots between them (see [Correlation model](#correlation-model)).

**System Metrics** are a third kind of output that rides both: sample lines in the operational
logs (engine, server, and desktop), `system.metrics` events in telemetry, and their own OTLP
metrics export. [Signals and where they go](README.md#signals-and-where-they-go) maps every output
in one place; the recipes below read the sample lines.

This document is the consumer **guide**. The normative field tables live in
[`log-schema.md`](log-schema.md); where this guide and that document disagree, the schema document
wins. The design rationale is [ADR-019](../architecture/adr/019-logging-architecture-and-standards.md).

---

## Output schema reference

### Operational log schema

Every operational surface writes one JSON object per line. The full normative table is in
[`log-schema.md` § Canonical fields](log-schema.md#canonical-fields); the shape summarized:

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `ts` | string | always | RFC3339Nano, UTC |
| `level` | string enum | always | `TRACE` \| `DEBUG` \| `INFO` \| `WARN` \| `ERROR` |
| `component` | string enum | always | `engine` \| `server` \| `web` \| `desktop` \| `ios` \| `relay` \| `extension` |
| `tag` | string | optional | Subsystem within the component; for extension logs, the extension name |
| `msg` | string | always | Short, constant, data-free clause (never interpolated) |
| `session_id` | string | omit when not in scope | Client-supplied engine session key |
| `conversation_id` | string | omit when not in scope | Durable conversation-file ID (`{unix-millis}-{12-hex}`) |
| `trace_id` | string | omit when no trace | OTEL-compatible 32-hex trace ID |
| `span_id` | string | omit when no span | OTEL-compatible 16-hex span ID |
| `fields` | object | always (`{}` when empty) | All variable context, canonical snake_case keys |

Consumer-relevant guarantees:

- **Presence, not emptiness.** Correlation IDs are omitted entirely when out of scope. An empty
  string never appears. Test for key presence, not for `""`.
- **Constant `msg`.** The same logical event always produces the byte-identical `msg` string.
  You can group, count, and alert on exact message matches; all variable data is in `fields`.
- **Canonical `fields` vocabulary.** Common concepts always use the same key (`duration_ms`,
  `cost_usd`, `error`, `tool`, `model`, `attempt`, ...). The vocabulary table in
  [`log-schema.md`](log-schema.md#canonical-field-vocabulary) is normative. New keys may appear at
  any time; existing keys are never renamed to synonyms.
- **Levels.** Five levels, `TRACE < DEBUG < INFO < WARN < ERROR`. Default minimum is INFO on every
  surface, so a default install's files contain INFO/WARN/ERROR only. TRACE and DEBUG appear when
  explicitly enabled.

**Stability contract:** the operational schema is a published contract, **unversioned but
additive-only**. New optional top-level fields and new `fields` keys may appear without notice;
removals and renames require an ADR. Parse defensively: ignore unknown keys, never fail on them.

### Telemetry event schema

The telemetry stream (opt-in, see [`docs/enterprise/telemetry.md`](../enterprise/telemetry.md)) is a
versioned event stream. Every record self-identifies its schema generation via the `schema` integer. Schema v4 introduced compact frames and v5 (current) keeps them; a frame expands to one or more telemetry events.

**Top-level envelope** (normative table:
[`log-schema.md` § Telemetry event fields](log-schema.md#telemetry-event-fields-telemetryjsonl)):

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `record` | string | frame | `"telemetry.frame"`; identifies a compact frame |
| `schema` | int | always | Schema version. Current version is **5** |
| `identities` / `contexts` / `events` | arrays | frame | Interned identity and correlation tables plus event records |
| `name` / `ts` / `component` | expanded event | always after expansion | Event identity, event time, and source component |
| `install_id` | string | always | Stable anonymous per-install UUID (minted at `~/.ion/install_id`) |
| `host` | string | always | Machine hostname |
| `version` | string | always | Engine build string |
| `event_id` | string | omit when absent | Per-event unique ID for downstream dedup |
| `user` | string | omit when absent | Authenticated identity when an enterprise OIDC auth context is present; absent on default installs |
| `payload` | object | always | Event-specific fields, all snake_case |
| `context` | object | when in scope | Correlation: `session_id`, `conversation_id`, `run_id` |
| `trace_id` | string | omit when no run in flight | W3C trace-context trace-id, 32 lowercase hex. The trace of the prompt the run serves: the run joins the trace the client started — see § "Correlation model" |

Version history: v2 introduced the unified contract; v3 added `event_id` and the populated-capable `user` carrier; v4 stores compact frames with interned identity and context tables; v5 made every engine operation a span event and added the runtime figures to `system.metrics` ([`log-schema.md`](log-schema.md) § "Telemetry schema versioning"). The telemetry forwarder decodes file records at any schema at or below its own and sends expanded events to consumers. Added fields never bump the number; see [`docs/enterprise/telemetry.md`](../enterprise/telemetry.md) § "Schema versioning".

**Core event payloads:**

`llm.call` — emitted after each LLM turn completes:

| Payload key | Type | Meaning |
|---|---|---|
| `model` | string | Model ID for the turn |
| `turn` | int | Turn index within the run |
| `stop_reason` | string | Provider stop reason |
| `duration_ms` | int | Turn wall-clock duration |
| `error` | string | Error message; empty on success |

`tool.execute` — emitted after each tool call completes:

| Payload key | Type | Meaning |
|---|---|---|
| `tool` | string | Tool name |
| `duration_ms` | int | Execution wall-clock duration |
| `error` | string | Error message; empty on success |
| `fd_open` | int | File descriptors the engine process holds when the call ends |
| `fd_limit` | int | File descriptors the engine process may hold |
| `fd_delta` | int | Change in `fd_open` across the call |

The three `fd_*` keys are omitted where the platform cannot count descriptors (Windows). Every run shares the engine process, so `fd_delta` includes whatever concurrent work opened or closed during the call. A tool whose calls keep a positive `fd_delta` is leaking descriptors. The `dispatch.agent` span carries the same reading for a whole dispatch: `fd_open` and `fd_limit` at its end, `fd_open_start` from when it was accepted, and `fd_delta` between them.

`run.complete` — emitted once per completed run; all cost and token accounting lives here:

| Payload key | Type | Meaning |
|---|---|---|
| `model` | string | Model ID of the most recent turn |
| `run_cost_usd` | float | This run's cost (cache-aware). Canonical cost field |
| `aggregate_cost_usd` | float | This run plus all descendant sub-agent dispatches |
| `dispatch_depth` | int | `0` = root run. Filter to `0` before summing `aggregate_cost_usd` |
| `duration_ms` | int | Run wall-clock duration |
| `num_turns` | int | LLM turns in the run |
| `input_tokens` | int | Provider-reported input tokens |
| `output_tokens` | int | Provider-reported output tokens |
| `cache_read_input_tokens` | int | Tokens served from prompt cache |
| `cache_creation_input_tokens` | int | Tokens written into prompt cache |

Beyond the core three, the engine emits additive instrumentation families — trust/autonomy
(`permission.decision`, `sandbox.block`, `secret.containment`), agent-loop (`dispatch.agent`,
`dispatch.control_mismatch`, `tool.failure`), context economy (`context.pressure`, `compaction`, `cache.savings`), provider
market (`provider.ttft`, `provider.stall`, `provider.stream_summary`, `provider.retry`,
`provider.fallback`), and platform health (`extension.respawn`, `extension.coldstart`,
`extension.hook_latency`, `client.backpressure`). Session and conversation lifecycle is covered by
the separate, standalone `conversation.*` event family (`conversation.lifecycle`'s `created`,
`resumed`, `compacted`, `cleared`, `detached`, and `deleted` actions) — see
[`log-schema.md`](log-schema.md) § "`conversation.*` event family". The authoritative by-name list
for the `telemetry.*` family is the constant block in `engine/internal/telemetry/telemetry.go`. All
payloads follow the same snake_case vocabulary; see [`cost-model.md`](cost-model.md) for the cost
fields' semantics.

**Stability contract:** the telemetry format is **versioned**. Within a schema version, changes
are additive only. The engine keeps the file append-only across schema transitions and records the
highest seen schema in `~/.ion/telemetry.schema.json`. Size rotation is independent: it renames the
live file to `.1`, shifts older archives, and removes the oldest archive beyond `maxFiles`. Consumers
should use the telemetry forwarder or another frame-aware decoder instead of assuming every JSONL line is
an expanded event.

---

## Where each surface writes

All surfaces share one schema and one JSONL format.

| Surface | File | Rotation |
|---|---|---|
| Engine | `~/.ion/engine.jsonl` | Rename rotation, config-driven size cap; `.1` is the newest archive. The daemon and every short-lived `ion` process write this one file; any of them may rotate it, and the others move to the new live file within a second |
| Extensions | `~/.ion/engine.jsonl` (`component=extension`, `tag=<extension-name>`) | Same file as engine |
| Server | `<ION_DATA_DIR>/server.jsonl` (`component=server`) | Rename rotation at 20 MB; `.1` is the newest archive |
| Browser Studio client | `<ION_DATA_DIR>/server.jsonl` (`component=web`, forwarded through the server's `POST /log`) | Same file as server |
| Desktop | `~/.ion/desktop.jsonl` | Rename rotation; `.1` is the newest archive |
| iOS | `<ION_DATA_DIR>/ios-diagnostic-logs.jsonl` (pulled from the device by the server it is paired with) | Rename rotation; `.1` is the newest archive |
| Relay | `RELAY_LOG_FILE`, default `/var/log/ion/relay.jsonl` (inside the relay container) | Rename rotation; `.1` is the newest archive |
| Telemetry (engine) | `~/.ion/telemetry.jsonl` (when telemetry is enabled) | Rename rotation by size; schema transitions are append-only |

Relay specifics: `RELAY_LOG_OUTPUT` selects `stdout` | `file` | `both` (default `stdout`);
`RELAY_LOG_LEVEL=trace` enables TRACE. The file path is inside the container, so host-side
collection needs a volume mount; with the default stdout target, `docker logs ion-relay` shows the
same canonical JSONL lines.

Rotation means **the local files are diagnostic buffers, not archives**. The live file rotates to `.1` at the cap, then later archives expire according to the configured generation count. Any consumer that needs history beyond the cap must ship lines downstream
(Alloy tail, the egress path below, or its own tailer) before rotation claims them.

---

## How to consume

### Option 1 — `jq` against the local files

Zero infrastructure for operational logs. Every operational file is NDJSON, so `jq` is the native query tool. Telemetry frames need the telemetry forwarder or another frame-aware decoder before event-level filtering.

One conversation, across everything the engine and extensions did:

```bash
jq -c 'select(.conversation_id=="1780093348767-c1c03e998388")' ~/.ion/engine.jsonl
```

One session across all surfaces:

```bash
jq -c 'select(.session_id=="dd2ca947-1234-5678-abcd-ef0123456789")' ~/.ion/*.jsonl
```

Errors only, everywhere:

```bash
jq -c 'select(.level=="ERROR")' ~/.ion/*.jsonl
```

One extension's lines:

```bash
jq -c 'select(.component=="extension" and .tag=="my-extension")' ~/.ion/engine.jsonl
```

Time-bounded (RFC3339 strings compare lexicographically, so string comparison is correct):

```bash
jq -c 'select(.ts >= "2026-07-06T20:00:00Z")' ~/.ion/engine.jsonl
```

Count occurrences of a constant message (this works *because* `msg` is never interpolated):

```bash
jq -r 'select(.msg=="session started") | .ts' ~/.ion/engine.jsonl | wc -l
```

System Metrics from the sample lines (fields under `fields`, see
[log-schema.md](log-schema.md#system-metrics-sample-engine)):

```bash
# Host CPU and available memory over time, one line per 30 s sample
jq -r 'select(.tag=="sysmetrics" and .level=="INFO") | [.ts, .fields.host_cpu_utilization, .fields.host_memory_available_bytes] | @tsv' ~/.ion/engine.jsonl

# Which engine process role is using the most memory right now
jq -c 'select(.tag=="sysmetrics") | .fields | {engine_rss_bytes, extension_rss_bytes, mcp_rss_bytes, backend_rss_bytes, tool_rss_bytes}' ~/.ion/engine.jsonl | tail -1

# Studio's GPU helper, and every idle-repaint warning
jq -r 'select(.tag=="device-metrics" and .msg=="device metrics sample") | [.ts, .fields.gpu_helper_gpu_percent // "n/a"] | @tsv' ~/.ion/desktop.jsonl
jq -c 'select(.msg=="idle repaint detected")' ~/.ion/desktop.jsonl
```

Telemetry event queries require the telemetry forwarder because a frame can contain multiple events. Use the local reference stack for LogQL queries, or configure the telemetry `http` or `otel` target for a collector that receives expanded events.

### Option 2 — the reference Loki/Grafana stack

This is how Ion itself does it. One command brings up Alloy + Loki + Grafana (+ optional Tempo),
pre-provisioned with datasources and dashboards:

```
dev util observability-up
```

See [`docs/observability/README.md`](README.md) for the full stack reference: what Alloy tails, how the telemetry forwarder posts expanded events, the
label policy, dashboard packs, and restart procedures. In short: Alloy tails the operational JSONL files and receives telemetry through `loki.source.api`, and indexes every record under the names its OTLP form carries ([`log-schema.md`](log-schema.md) § "Names in Loki"): the labels `service_name`, `level`, and `tag` for operational logs, `service_name` and `event_name` for telemetry, and `host_name` and `user` on both; `trace_id` and `span_id` as structured metadata; everything else stays in the log
body or structured metadata. A log query says `event_name=""`; a telemetry query names the event.

LogQL Explore recipes (Grafana → Explore → Loki):

```logql
# One conversation, all surfaces
{service_name=~".+", event_name=""} | json | conversation_id = "1780093348767-c1c03e998388"

# One session, all surfaces
{service_name=~".+", event_name=""} | json | session_id = "dd2ca947-1234-5678-abcd-ef0123456789"

# Errors from one component (level is a stream label; no JSON parse needed)
{service_name="ion-engine", level="ERROR"}

# One extension
{service_name="ion-extension", event_name="", tag="my-extension"}

# Count a constant message over time (works because msg is never interpolated)
count_over_time({service_name="ion-engine", event_name=""} |= "session started" [1h])

# Pivot: everything sharing a trace_id found in Tempo
{service_name=~".+"} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

# Telemetry: total cost, last 24h
sum(sum_over_time({event_name="run.complete"} | json | unwrap payload_run_cost_usd [24h]))

# Telemetry: tool call volume by tool, last 24h
sum by (tool) (count_over_time({event_name="tool.execute"}[24h]))
```

The same System Metrics in LogQL (the **Ion System Metrics** dashboard is built from these):

```logql
avg(avg_over_time({service_name="ion-engine", event_name=""} | json | tag="sysmetrics" | fields_host_cpu_utilization != "" | unwrap fields_host_cpu_utilization [5m]))
avg(avg_over_time({service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="device metrics sample" | fields_gpu_helper_gpu_percent != "" | unwrap fields_gpu_helper_gpu_percent [5m]))
sum(count_over_time({service_name="ion-desktop", event_name=""} | json | msg="idle repaint detected" [1h]))
```

#### Spans: span metrics, traces, and the log lines of one trace

Every operation is a span ([`log-schema.md`](log-schema.md#spans) § "Spans"), and the reference stack
keeps each span three ways: as a histogram in Prometheus (Tempo's metrics-generator writes
`traces_spanmetrics_*` and `traces_service_graph_*`), as a trace in Tempo, and as the span line or span
event in Loki. The **Ion Performance** dashboard is built from the first; the other two answer "which
one, and why".

A percentile per span name, in PromQL against the Prometheus data source (seconds; `service` is the
OTLP `service.name`, and the dimensions `backend`, `model`, `transport`, `client_kind`, `action`,
`command`, `surface`, `direction`, `host_name`, and `user` are labels):

```promql
# p95 of every engine span, one series per span name
histogram_quantile(0.95, sum by (le, span_name) (rate(traces_spanmetrics_latency_bucket{service="ion-engine"}[5m])))

# p95 of the server's time on a store action, per action
histogram_quantile(0.95, sum by (le, action) (rate(traces_spanmetrics_latency_bucket{span_name="action.handle"}[5m])))

# store actions per second, per Studio surface
sum by (surface) (rate(traces_spanmetrics_calls_total{span_name="action.handle"}[5m]))

# calls between services, for the service graph
sum by (client, server) (rate(traces_service_graph_request_total[5m]))
```

The slow ones themselves, in TraceQL against the Tempo data source (Explore → Tempo; durations are
TraceQL durations):

```traceql
# every store action the server took longer than 500 ms on, newest first
{ name = "action.handle" && duration > 500ms }

# the same, for one action and one client kind
{ name = "action.handle" && span.action = "submit" && span.client_kind = "ios" && duration > 500ms }

# a run whose model turn waited on retries: llm.call far longer than its longest llm.attempt
{ name = "llm.call" && duration > 60s } >> { name = "llm.attempt" }
```

Every log line of one trace, across every surface, in LogQL (the `trace_id` is on a span's row in
Tempo, or on any log line of the prompt; `trace_id` is structured metadata, so no `| json`):

```logql
# every operational line and telemetry event of one trace: the client's spans, the relay's, the server's,
# the engine's and extensions' lines, and the run's span events
{service_name=~".+"} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

# only the span records of that trace, in order, with their durations
{service_name=~".+"} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736" | json | tag = "span" or payload_span_id != "" | line_format "{{.msg}}{{.event_name}} {{.fields_duration_ms}}{{.duration_ms}} ms"
```

The pivot in the other direction is provisioned: a Loki line with a `trace_id` shows "View trace in
Tempo", a Tempo span shows "Logs for this span", and a Prometheus histogram sample carries the trace id
Tempo attached as an exemplar, which opens in Tempo too.

### Option 3 — programmable egress (no Ion-provided stack required)

Both streams can ship themselves downstream directly from the engine, so a consumer with an
existing SIEM, OTLP collector, or log pipeline needs no Alloy, no Loki, and no file tailing.

**Operational-log egress** (`logging.egressTargets` in `engine.json`):

```json
{
  "logging": {
    "egressTargets": ["http", "otel"],
    "egressEndpoint": "https://siem.corp.example.com/ingest/ion-logs",
    "egressHeaders": { "Authorization": "Bearer ingest-token" },
    "egressBatchSize": 100,
    "egressFlushIntervalMs": 5000,
    "egressOtel": {
      "endpoint": "https://otel-collector.corp.example.com:4318",
      "headers": { "x-api-key": "otel-ingest-key" },
      "serviceName": "ion-engine"
    }
  }
}
```

| Field | Meaning |
|---|---|
| `egressTargets` | `"http"` and/or `"otel"`. Empty/absent (the default) means no egress; logs write to the local file only |
| `egressEndpoint` | HTTP POST URL for the `http` target |
| `egressHeaders` | Extra request headers for the `http` target (e.g. `Authorization`) |
| `egressBatchSize` | Records buffered before an automatic flush; zero means the periodic ticker is the only trigger |
| `egressFlushIntervalMs` | Flush cadence; zero defaults to 5000 ms |
| `egressOtel` | OTLP HTTP logs endpoint config for the `otel` target (same `OtelConfig` shape as telemetry) |
| `egressChunkSize` | Maximum records per POST when draining the disk spool; zero uses the compiled default |
| `egressSpoolMaxBytes` | Disk cap for the undeliverable-batch spool; zero uses the compiled default. Over cap, oldest records are dropped |
| `egressBufferMaxRecords` | Heap cap for the in-memory staging buffer; zero uses the compiled default. Over cap, oldest records are dropped and the loss is logged at ERROR |
| `egressTokenScope` | When set, every flush mints a fresh bearer token for this scope and sends it as `Authorization`, over any static header |
| `egressTokenAudience` | Explicit audience/resource for the egress token, for providers that bind grants to one. Empty uses the provider's default |
| `egressTokenProvider` | Name of the `auth.oauth` entry that mints the egress token. Empty uses `auth.identityProvider`. Name a `machineIdentity` entry to authenticate a headless engine that has no signed-in operator |

**Authenticated egress on a headless engine.** By default the egress token comes from the engine's
identity provider. A container, CI runner, or server has nobody signed in, so that provider has no
token and the sink answers `401`. Point `egressTokenProvider` at a machine identity instead:

```json
{
  "auth": {
    "oauth": {
      "log-shipper": {
        "clientId": "00000000-0000-0000-0000-000000000000",
        "tokenUrl": "https://login.microsoftonline.com/<tenant-id>/oauth2/v2.0/token",
        "scopes": ["api://<ingest-app-id>/.default"],
        "machineIdentity": {
          "source": "client_secret",
          "clientSecretEnv": "ION_LOG_SHIPPER_CLIENT_SECRET"
        }
      }
    }
  },
  "logging": {
    "egressTargets": ["otel"],
    "egressOtel": { "enabled": true, "endpoint": "https://otel.example.com" },
    "egressTokenScope": "api://<ingest-app-id>/.default",
    "egressTokenProvider": "log-shipper"
  }
}
```

The engine reads the secret from the environment variable at startup and removes it from its own
environment. Every `machineIdentity` source listed in the
[engine.json reference](../configuration/engine-json.md#machine-identity-fields) works here except
`aws`, which yields AWS credentials rather than a bearer token. When `egressTokenProvider` names
`auth.identityProvider` itself, egress reuses that provider. The startup line
`egress auth header provider installed` names the provider and its kind; a misconfigured entry logs
an ERROR and falls back to the identity provider.

Egress is additive: the local JSONL file is always written regardless of egress config. The
forwarder buffers off the hot logging path and flushes on batch size, on the periodic ticker, and
on engine shutdown. The shutdown drain is the engine's last step: it ships the lines logged during
teardown, bounded to a few seconds so a hung sink cannot hold the process open. Whatever it cannot
deliver stays in the spool for the next start. When `ion prompt` starts its own engine (for example
as a container's entrypoint), it waits for that engine to finish shutting down before it exits, and
it ships its own lines too, through a spool of its own (`.prompt-egress-spool.jsonl`). Against an
engine that was already running, `ion prompt` ships nothing of its own.

The first lines an engine logs (process start, its data directory, how its previous run exited)
come before it reads `engine.json`. They are held and shipped by the first forwarder, so the shipped
log starts where the file does.

The tailer that ships the other assigned files treats what those files hold when it starts as
history and skips it; everything written after that ships. A file that does not exist yet when the
tailer starts is shipped from its first line. A run shorter than one poll interval, like a CI job,
still ships all of its output.

**A sink outage is bounded on both sides.** When a target is unreachable or rejects the batch
(including a persistent `401` from an expired ingest credential), undelivered records go to the disk
spool and the forwarder backs off exponentially. Two independent caps keep an indefinite outage from
consuming the machine: `egressSpoolMaxBytes` bounds what the spool costs on **disk**, and
`egressBufferMaxRecords` bounds what the staging buffer costs in **heap**. Both drop oldest-first
and log the loss, so a dead sink degrades to a bounded window of recent logs rather than unbounded
growth. Ion never blocks or drops a *local* log line because egress is failing — the JSONL file is
written first, always.

#### OTLP is the canonical egress

**`egressTargets: ["otel"]` is the recommended, canonical egress path for shipping Ion operational
logs to any backend.** OTLP/HTTP logs is a vendor-neutral wire format that virtually every modern
log backend and collector already speaks, so pointing Ion at an OTLP endpoint is the one integration
that works everywhere without a bespoke receiver.

The engine, the server, the desktop, and the relay all ship OTLP, and every record states each fact
once, where OTLP puts it (schema version 3, [`log-schema.md`](log-schema.md#otlp-correlation-model)
§ "OTLP correlation model"):

- **Resource**: the source that wrote the record. `service.namespace` is `ion`, `service.name` is
  `ion-<component>`, `service.instance.id` is the install (a telemetry event's own `install_id`, an
  iOS line's `device_id`), `service.version` is the build, and `host.name` is the host without
  `.local`. Application Insights builds `RoleName` and `RoleInstance` from these.
- **LogRecord**: a valid `trace_id` is the `traceId`, and the span the record is about is the
  `spanId`. Levels map to severity numbers (TRACE=1, DEBUG=5, INFO=9, WARN=13, ERROR=17) with the
  level string as `severityText`. The body is the record itself: the JSONL line, or the telemetry
  event JSON.
- **Attributes**: on an operational line, `tag`, `session_id`, `conversation_id`, `user` (when an
  identity is set), `event_id`, and **every `fields` key flattened to its own natively-typed
  attribute** — string values as `stringValue`, booleans as `boolValue`, integers as `intValue`
  (int64 rendered as a decimal string per the OTLP/JSON mapping), non-integer numbers as
  `doubleValue`, and nested objects/arrays JSON-stringified into a `stringValue`. `run_id` rides
  there (per the [correlation model](#correlation-model) it lives in `fields`). On a telemetry
  event, `event.name`, `user`, `schema_version`, and the payload and context keys the local stack
  indexes.

No attribute repeats the trace, span, component, host, install, or build. `event.name` is present on
every telemetry event and on no operational line, so it is what tells the two apart.

`egressOtel.serviceName` names the exporter's instrumentation scope (`scopeLogs[].scope.name`), not a
service. It defaults to `ion-engine` on the engine and `ion-<process>` on the server and desktop. A
record's service is always its resource's `service.name`, whichever process shipped it, and a
configured `resourceAttributes` entry never overrides `service.name`.

**Engine↔TypeScript parity guarantee.** For the same canonical record, the engine (Go) and the
TypeScript forwarder the server and desktop share produce **structurally identical** OTLP output: the same resource, the same attribute keys, the same value
types, the same sorted key order, the same body. The two exporters share one typing
convention and are pinned to each other by a cross-surface parity test
(`packages/shared/src/__tests__/log-egress-otel.test.ts` asserts the TypeScript attribute set against the
engine's, whose shape is pinned in `engine/internal/utils/log_egress_otel_test.go`). A backend
therefore sees one uniform log shape whether a line originated in the engine or the desktop.

#### Collector fan-out (backend knowledge lives in the collector, not Ion)

The intended topology is: **Ion emits OTLP to a collector; the collector routes to whatever backends
you run.** Point both surfaces (and, if you enable it, the telemetry stream) at a single OTLP
collector endpoint — the [OpenTelemetry Collector](https://opentelemetry.io/docs/collector/), Grafana
Alloy, the Datadog Agent, or any OTLP-speaking gateway — and let that collector's pipeline config
fan the records out to Loki, Splunk, Elastic, an S3 archive, or several at once.

This keeps **all backend-specific knowledge in the collector's configuration**, never in Ion.
Ion's contract ends at "emit well-formed, lossless OTLP." Which backends exist, how they authenticate,
how records map to each backend's index — that is collector-pipeline configuration you own and change
without touching Ion config. Adding Splunk next to Loki is a collector-exporter edit, not an Ion
redeploy.

```
engine   ─┐
server   ─┤
desktop  ─┼─▶  OTLP collector  ─┬─▶  Loki
telemetry─┘   (routing config)  ├─▶  Splunk
                                └─▶  Elastic / S3 / SIEM
```

#### The `http` target is the bespoke-Ion escape hatch

The `http` target POSTs a JSON **array** of records per batch to a single URL. It is **not** the
standard path — it is an escape hatch for a consumer that wants Ion's *native* record shape verbatim
(the exact canonical-log-schema JSON, one array per flush) and is willing to build a receiver for it.
Each record is the full canonical record — `ts`, `level`, `msg`, `component`, `tag`, plus
`session_id` / `conversation_id` / `trace_id` / `user` and the `fields` object when in scope — so a
bespoke receiver parses it with the same tooling as the local files. One wire nuance: `fields` is
omitted (rather than `{}`) when empty on the egress wire, and `span_id` is not carried (the engine's
operational logger does not populate it). Reach for `http` only when you specifically want Ion's own
JSON shape and control the ingest endpoint; for everything else, prefer `otel` and a collector.

Enterprise config can **seal egress on**: when the enterprise layer sets `logging.egressTargets`,
the egress fields are enforced and users cannot disable shipping. Local-file settings (format,
rotation, directory) are not touched by enterprise enforcement. See
[`docs/enterprise/sealed-config.md`](../enterprise/sealed-config.md).

**Telemetry egress** (`telemetry.targets` in `engine.json`): the telemetry stream has its own
`http` (batched JSON arrays of events, retry with backoff) and `otel` (spans + log records via
OTLP) targets, configured independently of operational-log egress. Full reference:
[`docs/enterprise/telemetry.md`](../enterprise/telemetry.md).

The two egress paths are deliberately parallel: one config shape (`OtelConfig` is shared), two
streams, so an enterprise can point both at the same collector and rely on the shared correlation
vocabulary to join them downstream.

---

## Correlation model

Both streams carry the same join keys. This is the contract that makes cross-stream forensics work:

| Key | Operational log | Telemetry | Scope | Reach for it when |
|---|---|---|---|---|
| `session_id` | top-level | `context.session_id` | One engine session (desktop: tab UUID), spanning many runs | You want every run that shared a live session |
| `conversation_id` | top-level | `context.conversation_id` | Durable conversation-file identity; spans sessions and runs | You want the whole conversation over its lifetime — audit, resource scoping |
| `run_id` | in `fields` where relevant | `context.run_id` | One prompt-to-completion run | You are joining Ion's logs to Ion's telemetry for one run |
| `trace_id` | top-level | top-level, and `context` on run-scoped events | **One prompt**, from the client's submit through the engine's run | You are following one prompt across every surface, or doing distributed tracing — APM operation id, `traceparent` for a downstream call |
| `span_id` | `fields.span_id` on a span line (`tag=span`) | `payload.span_id` on a span event | One hop's timed span | You are placing one hop inside the prompt's trace |

A prompt is one trace. The client that sends it (Studio in Electron or a browser, or the phone)
starts the trace and passes it on as a `traceparent`; the relay, the server, and the engine's run
join it, each with its own span. So `trace_id` is the same on the client's span line, the server's
lines about the prompt, and every engine and extension line of the run it started. `run_id` is the
engine-native id of the run alone. Use `trace_id` to follow a prompt across surfaces or into an OTLP
backend, `run_id` when both sides are the engine's own streams. The hop chain and the span record
shapes are in [`log-schema.md`](log-schema.md#spans) § "Spans".

> **`trace_id` is scoped to one prompt, not one session.** A trace represents one logical transaction,
> and a session can stay open for hours across hundreds of prompts. Lines about no prompt (session
> start/stop, extension load) carry no `trace_id` at all — join those by `session_id` or
> `conversation_id`. A run the engine starts on its own (a schedule or webhook delivery) has a trace
> of its own that starts at the engine. Full vocabulary:
> [`log-schema.md`](log-schema.md) § "Correlation-ID vocabulary".

The pivot workflow (from [`docs/enterprise/telemetry.md`](../enterprise/telemetry.md#correlation-model)):

1. Find an error in the operational stream: `{level="ERROR"} | json | session_id = "..."`.
2. Copy its `trace_id` — that is the prompt the error happened in. Pull every line of it, on every
   surface: `{service_name=~".+"} | trace_id = "..."` returns the client's `prompt.send` span
   line, the server's lines and its `prompt.handle` span, and the engine and extension lines of the
   run. The same value opens the span tree in any OTLP backend the spans were exported to (Tempo in
   the local stack): `prompt.send` → `relay.forward` (phone prompts over a relay) and
   `prompt.handle` → `engine.send_prompt` → `run.execute` → `llm.call` / `tool.execute` /
   `hook.fanout` and the rest of the engine's spans, and the client's `prompt.visible`
   ([`log-schema.md`](log-schema.md#spans) § "Spans" has the whole tree).
3. Widen from the run to the whole conversation: take `conversation_id` off any of those lines and
   query `{service_name=~".+", event_name=""} | json | conversation_id = "..."`.

Step 2 narrows to the failing prompt; step 3 widens to its history. That is the reason both IDs
exist — `trace_id` isolates one prompt, `conversation_id` gives it context.

The same joins work with plain `jq` — the keys are in the lines, not in any stack:

```bash
# From a telemetry run.complete, pull every line of the prompt that run served
TID=$(jq -r 'select(.name=="run.complete") | .trace_id' ~/.ion/telemetry.jsonl | tail -1)
jq -c --arg tid "$TID" 'select(.trace_id==$tid)' ~/.ion/*.jsonl

# Widen to every run in the same conversation
CID=$(jq -r 'select(.name=="run.complete") | .context.conversation_id' ~/.ion/telemetry.jsonl | tail -1)
jq -c --arg cid "$CID" 'select(.conversation_id==$cid)' ~/.ion/*.jsonl
```

---

## Retention and storage sizing

**The consumer owns retention.** Ion bounds its local files with rename rotation at the size cap; schema transitions do not rotate telemetry but makes no retention promises for anything shipped
downstream. Whatever ingests the streams — Loki, a SIEM, an OTLP backend — is where history
accumulates, and bounding it is that system's configuration, not Ion's.

In the reference stack, **Loki is where storage accrues**. Alloy is a stateless shipper (its
tailing positions are negligible); Grafana stores dashboards, not data. Loki's chunk and index
storage grows with every ingested line and never shrinks unless retention is enabled.

> **The shipped [`loki-config.yaml`](loki-config.yaml) configures no compactor and no
> `retention_period` — storage grows unbounded.** That is a deliberate default for a local
> development stack (you rarely want your own diagnostic history garbage-collected mid-investigation),
> but any long-running or shared deployment must bound it.

Three levers, in order of importance:

**1. Compactor retention (the actual delete mechanism).** Loki only deletes data when the compactor
runs with retention enabled. A corrected stanza for the single-binary filesystem deployment the
reference stack uses:

```yaml
compactor:
  working_directory: /loki/compactor
  compaction_interval: 10m
  retention_enabled: true
  retention_delete_delay: 2h
  delete_request_store: filesystem

limits_config:
  reject_old_samples: false
  reject_old_samples_max_age: 720h
  retention_period: 720h   # 30 days; 0s (the default) = keep forever
```

`retention_period` lives under `limits_config` (globally or per-tenant); the compactor block turns
deletion on. Keep `retention_period` at or above the 720h re-ingest window (`reject_old_samples_max_age`)
that delayed forwarding can need — a shorter retention can remove data before an operator investigates it.

**2. Ingestion rate limits (bounding the inflow).** Also under `limits_config`:
`ingestion_rate_mb`, `ingestion_burst_size_mb`, and `per_stream_rate_limit` cap how fast data can
arrive, which caps how fast storage can grow between compactor runs. Useful as a guard against a
TRACE-enabled surface or a runaway extension flooding the stack.

**3. Volume size (the hard ceiling).** The Loki data volume — the `loki-data` named volume in the
reference compose file, or the PVC in a Kubernetes deployment — is the physical bound. When it
fills, ingestion fails; it does not gracefully degrade. Size it from the heuristic below with
generous headroom, and treat "volume nearly full" as an alert, not a surprise.

### Sizing heuristic

```
raw bytes/day        ≈ avg bytes/line × lines/day
stored bytes/day     ≈ raw bytes/day ÷ compression factor + index overhead
volume size needed   ≈ stored bytes/day × retention days × headroom factor
```

Rules of thumb for the inputs, measured from real Ion output: operational lines average roughly
200–400 bytes; telemetry events run larger (500–800 bytes) but are far fewer. An active development
machine produces on the order of tens of thousands of operational lines per surface per day at the
default INFO minimum; enabling DEBUG or TRACE multiplies that severalfold. Loki's chunk compression
typically achieves 5–10× on structured JSON logs; index overhead is small (a few percent) under the
three-label policy.

Worked example: 300 bytes/line × 100,000 lines/day across all surfaces ≈ 30 MB/day raw ≈ 3–6 MB/day
stored. At 30-day retention with 2× headroom, a 500 MB volume is comfortable. A fleet aggregating
many installs, or a deployment running DEBUG, should re-measure `avg bytes/line × lines/day` from
its own ingest metrics rather than scaling the example.
