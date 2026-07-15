# Consuming Ion Logs

Ion treats its log output as a **published output contract**, documented with the same rigor as its
config inputs. This guide is for anyone building on that output: an operator tailing files with `jq`,
a platform team running the reference Loki/Grafana stack, or an enterprise shipping logs into an
existing SIEM or OTLP pipeline without any Ion-provided infrastructure.

Ion emits two structured NDJSON streams:

| Stream | What it answers | Files | Schema |
|---|---|---|---|
| **Operational log** | "What did the code do on this machine?" | `~/.ion/engine.jsonl`, `~/.ion/desktop.jsonl`, `~/.ion/ios-diagnostic-logs.jsonl`, relay `relay.jsonl` | Canonical log schema (unversioned, additive-only) |
| **Telemetry** | "What is happening across sessions, runs, and installs?" | `~/.ion/telemetry.jsonl` | Versioned event envelope (self-describing `schema` int) |

Both streams use snake_case throughout and share one correlation vocabulary, so a single join key
pivots between them (see [Correlation model](#correlation-model)).

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
| `component` | string enum | always | `engine` \| `desktop` \| `ios` \| `relay` \| `extension` |
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
versioned event stream. Every line self-identifies its schema generation via the `schema` integer.

**Top-level envelope** (normative table:
[`log-schema.md` § Telemetry event fields](log-schema.md#telemetry-event-fields-telemetryjsonl)):

| Field | Type | Presence | Meaning |
|---|---|---|---|
| `name` | string | always | Event kind (`run.complete`, `llm.call`, ...) — the single source of event identity |
| `ts` | string | always | RFC3339Nano UTC |
| `schema` | int | always | Schema version. Current version is **3** |
| `component` | string | always | `"engine"` |
| `install_id` | string | always | Stable anonymous per-install UUID (minted at `~/.ion/install_id`) |
| `host` | string | always | Machine hostname |
| `version` | string | always | Engine build string |
| `event_id` | string | v3+, omit on the rotation sentinel | Per-event unique ID (16 hex chars) for downstream dedup |
| `user` | string | omit when absent | Authenticated identity when an enterprise OIDC auth context is present; absent on default installs |
| `payload` | object | always | Event-specific fields, all snake_case |
| `context` | object | when in scope | Correlation: `session_id`, `conversation_id`, `run_id` |
| `trace_id` | string | omit when no trace | OTEL-compatible 32-hex trace ID; all events in one session share one |

Version history: v2 introduced the unified contract (RFC3339Nano `ts`, snake_case payloads,
`schema`/`component`/`install_id`/`host`/`version` envelope); v3 added the additive attribution
fields `event_id` and the populated-capable `user` carrier. v2 consumers decode v3 lines unchanged.

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
`tool.failure`), context economy (`context.pressure`, `compaction`, `cache.savings`), provider
market (`provider.ttft`, `provider.stall`, `provider.stream_summary`, `provider.retry`,
`provider.fallback`), and platform health (`extension.respawn`, `extension.coldstart`,
`extension.hook_latency`, `client.backpressure`) — plus session lifecycle (`session.start`,
`session.end`) and `error`. The authoritative by-name list is the constant block in
`engine/internal/telemetry/telemetry.go`. All payloads follow the same snake_case vocabulary; see
[`cost-model.md`](cost-model.md) for the cost fields' semantics.

**Stability contract:** the telemetry envelope is **versioned**. Within a schema version, changes
are additive only. A version bump is a conscious release event: the engine archives the live file
to `telemetry.jsonl.v<old>.<timestamp>.bak`, starts fresh, writes a `telemetry.schema_rotated`
sentinel as the first line of the new file, and stamps the `~/.ion/telemetry.schema.json` sidecar.
Consumers that care about generational breaks should read the sidecar (or the per-line `schema`
int) rather than assuming a fixed shape.

---

## Where each surface writes

All surfaces share one schema and one JSONL format.

| Surface | File | Rotation |
|---|---|---|
| Engine | `~/.ion/engine.jsonl` | Truncate-in-place, config-driven size cap (default 50 MB) |
| Extensions | `~/.ion/engine.jsonl` (`component=extension`, `tag=<extension-name>`) | Same file as engine |
| Desktop | `~/.ion/desktop.jsonl` | Truncate-in-place |
| iOS | `~/.ion/ios-diagnostic-logs.jsonl` (shipped from device to the paired desktop's `~/.ion`) | Truncate-in-place |
| Relay | `RELAY_LOG_FILE`, default `/var/log/ion/relay.jsonl` (inside the relay container) | Truncate-in-place at 50 MB |
| Telemetry (engine) | `~/.ion/telemetry.jsonl` (when telemetry is enabled) | Checkpoint/archive on schema rotation |

Relay specifics: `RELAY_LOG_OUTPUT` selects `stdout` | `file` | `both` (default `stdout`);
`RELAY_LOG_LEVEL=trace` enables TRACE. The file path is inside the container, so host-side
collection needs a volume mount; with the default stdout target, `docker logs ion-relay` shows the
same canonical JSONL lines.

Rotation means **the local files are diagnostic buffers, not archives**. Truncate-in-place discards
history at the cap. Any consumer that needs history beyond the cap must ship lines downstream
(Alloy tail, the egress path below, or its own tailer) before rotation claims them.

---

## How to consume

### Option 1 — `jq` against the local files

Zero infrastructure. Every file is NDJSON, so `jq` is the native query tool.

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
jq -c 'select(.component=="extension" and .tag=="ion-meta")' ~/.ion/engine.jsonl
```

Time-bounded (RFC3339 strings compare lexicographically, so string comparison is correct):

```bash
jq -c 'select(.ts >= "2026-07-06T20:00:00Z")' ~/.ion/engine.jsonl
```

Count occurrences of a constant message (this works *because* `msg` is never interpolated):

```bash
jq -r 'select(.msg=="session started") | .ts' ~/.ion/engine.jsonl | wc -l
```

Total spend today from telemetry:

```bash
jq -s '[.[] | select(.name=="run.complete" and (.payload.dispatch_depth==0))
        | .payload.aggregate_cost_usd] | add' ~/.ion/telemetry.jsonl
```

Structured field extraction — slowest tools by average duration:

```bash
jq -s '[.[] | select(.name=="tool.execute")]
       | group_by(.payload.tool)
       | map({tool: .[0].payload.tool, avg_ms: ([.[].payload.duration_ms] | add / length)})
       | sort_by(-.avg_ms)' ~/.ion/telemetry.jsonl
```

### Option 2 — the reference Loki/Grafana stack

This is how Ion itself does it. One command brings up Alloy + Loki + Grafana (+ optional Tempo),
pre-provisioned with datasources and dashboards:

```
dev util observability-up
```

See [`docs/observability/README.md`](README.md) for the full stack reference: what Alloy tails, the
label policy, dashboard packs, schema auto-wipe behavior, and restart procedures. In short: Alloy
tails the local JSONL files and promotes exactly three low-cardinality labels for operational logs
(`component`, `level`, `tag`) plus `service`/`kind` for telemetry; everything else stays in the log
body or structured metadata.

LogQL Explore recipes (Grafana → Explore → Loki):

```logql
# One conversation, all surfaces
{component=~".+"} | json | conversation_id = "1780093348767-c1c03e998388"

# One session, all surfaces
{component=~".+"} | json | session_id = "dd2ca947-1234-5678-abcd-ef0123456789"

# Errors from one component (level is a stream label; no JSON parse needed)
{component="engine", level="ERROR"}

# One extension
{component="extension", tag="ion-meta"}

# Count a constant message over time (works because msg is never interpolated)
count_over_time({component="engine"} |= "session started" [1h])

# Pivot: everything sharing a trace_id found in Tempo
{component=~".+"} | json | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"

# Telemetry: total cost, last 24h
sum(sum_over_time({service="ion-telemetry", kind="run.complete"} | json | unwrap payload_run_cost_usd [24h]))

# Telemetry: tool call volume by tool, last 24h
sum by (tool) (count_over_time({service="ion-telemetry", kind="tool.execute"}[24h]))
```

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

Egress is additive: the local JSONL file is always written regardless of egress config. The
forwarder buffers off the hot logging path and flushes on batch size, on the periodic ticker, and
on engine shutdown.

#### OTLP is the canonical egress

**`egressTargets: ["otel"]` is the recommended, canonical egress path for shipping Ion operational
logs to any backend.** OTLP/HTTP logs is a vendor-neutral wire format that virtually every modern
log backend and collector already speaks, so pointing Ion at an OTLP endpoint is the one integration
that works everywhere without a bespoke receiver.

The engine and the desktop both ship OTLP, and they ship it **losslessly**: every OTLP log record
carries the complete canonical record. `msg` is the record body; `component`, `tag`, every in-scope
correlation ID (`session_id`, `conversation_id`, `trace_id`), and `user` (when an identity is set)
are attributes; and **every key in the `fields` map is flattened to its own natively-typed
attribute** — string values as `stringValue`, booleans as `boolValue`, integers as `intValue`
(int64 rendered as a decimal string per the OTLP/JSON mapping), non-integer numbers as `doubleValue`,
and nested objects/arrays JSON-stringified into a `stringValue`. `run_id` is one of those `fields`
keys (per the [correlation model](#correlation-model) it lives in `fields`, not top-level), so it
rides through as its own attribute — nothing in the on-disk line is dropped on the OTLP wire.

Levels map to OTLP severity numbers (TRACE=1, DEBUG=5, INFO=9, WARN=13, ERROR=17) with the level
string as `severityText`. `service.name` defaults to `ion-engine` on the engine and `ion-desktop` on
the desktop; override it via `egressOtel.serviceName`.

**Engine↔desktop parity guarantee.** For the same canonical record, the engine (Go) and the desktop
(TypeScript) produce **structurally identical** OTLP output: the same attribute keys, the same value
types, the same sorted key order, the same constant-`msg` body. The two exporters share one typing
convention and are pinned to each other by a cross-surface parity test
(`desktop/src/main/__tests__/log-egress-otel.test.ts` asserts the desktop attribute set against the
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
engine  ─┐
desktop ─┼─▶  OTLP collector  ─┬─▶  Loki
telemetry┘   (routing config)  ├─▶  Splunk
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

| Key | Operational log | Telemetry | Meaning |
|---|---|---|---|
| `session_id` | top-level | `context.session_id` | Client-supplied engine session key (desktop: tab UUID) |
| `conversation_id` | top-level | `context.conversation_id` | Durable conversation-file identity; spans multiple sessions and runs |
| `run_id` | in `fields` where relevant | `context.run_id` | One prompt-to-completion run |
| `trace_id` | top-level | top-level | OTEL 32-hex; all events in one session share one |
| `span_id` | top-level | n/a (spans become events) | OTEL 16-hex |

The pivot workflow (from [`docs/enterprise/telemetry.md`](../enterprise/telemetry.md#correlation-model)):

1. Find an error in the operational stream: `{level="ERROR"} | json | session_id = "..."`.
2. Copy its `trace_id` and open the span tree in Tempo, or query the telemetry stream for the same
   `context.session_id` to see the run's cost, turns, and tool timings.
3. From any telemetry event, take `context.conversation_id` and pull the full operational narrative:
   `{component=~".+"} | json | conversation_id = "..."`.

The same joins work with plain `jq` — the keys are in the lines, not in any stack:

```bash
# From a telemetry run.complete, pull the operational lines for that session
SID=$(jq -r 'select(.name=="run.complete") | .context.session_id' ~/.ion/telemetry.jsonl | tail -1)
jq -c --arg sid "$SID" 'select(.session_id==$sid)' ~/.ion/*.jsonl
```

---

## Retention and storage sizing

**The consumer owns retention.** Ion bounds its local files (truncate-in-place at the size cap;
telemetry archives per schema rotation) but makes no retention promises for anything shipped
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
that the stack relies on for `.bak` re-ingestion after a telemetry schema rotation — a shorter
retention would delete history the stack just deliberately re-ingested.

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
