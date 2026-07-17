# Ion Unified Log Schema

Canonical JSONL schema for all five surfaces: **engine**, **desktop**, **ios**, **relay**, **extension**.

Every surface writes one JSON object per line (NDJSON). All fields are snake_case. No surface may invent
top-level fields outside this schema; additional context goes into `fields`.

---

## Canonical fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | string | YES | RFC3339Nano, always UTC. Example: `2024-11-15T22:04:05.123456789Z` |
| `level` | string enum | YES | `TRACE` \| `DEBUG` \| `INFO` \| `WARN` \| `ERROR`. No absent-equals-INFO default — the field must be present on every line. |
| `component` | string enum | YES | `engine` \| `desktop` \| `ios` \| `relay` \| `extension` |
| `tag` | string | NO | Subsystem tag within the component (`session`, `ext:my-agent`, etc.). For extension-component logs, this MUST be the extension name. |
| `msg` | string | YES | Human-readable message. No structured data embedded here; use `fields`. |
| `session_id` | string | NO | The engine session key: the opaque, client-supplied key that identifies the current engine session. For desktop clients this is the tab UUID (`ClientCommand.Key`). For external consumers it may be any string the client chose. This is NOT the conversation ID. Omit (never `""`) when not in a session context. |
| `conversation_id` | string | NO | The engine-minted conversation-file identity, format `{unix-millis}-{12-hex-chars}` (e.g. `1780093348767-c1c03e998388`). This is the durable identity of the persisted conversation tree at `~/.ion/conversations/<id>.tree.jsonl`. A single conversation spans multiple sessions and runs. Omit (never `""`) when not associated with a conversation. |
| `trace_id` | string | NO | OpenTelemetry-compatible 32-hex trace ID. Omit when no trace is active. All events in one session share one trace ID. |
| `span_id` | string | NO | OpenTelemetry-compatible 16-hex span ID. Omit when no span is active. |
| `fields` | object | YES | Open key/value map for structured context. Always present; use `{}` when empty. Values can be any JSON scalar, array, or object. |

### Empty-string rule

`session_id`, `conversation_id`, `trace_id`, and `span_id` MUST be omitted entirely when they are not
in scope. An empty string (`""`) is not a valid substitute. Consumers distinguish "ID known" from "not in
scope" by the key's presence, not by testing for empty strings.

### Level semantics

Five levels, ordered `TRACE < DEBUG < INFO < WARN < ERROR`. Default minimum level is INFO on every
surface. The rubric (normative — see ADR-019):

| Level | Use for |
|---|---|
| `TRACE` | Pure high-frequency noise: per-chunk, per-tick, per-frame emissions with no downstream or reliability signal. Off by default. |
| `DEBUG` | Replayable diagnostic detail: carries the IDs and intermediate values needed to reconstruct the exact code path after the fact. |
| `INFO` | State transitions, resolved decisions, operation outcomes. The always-on narrative. |
| `WARN` | Genuine abnormality the system recovered from or tolerated (retry, fallback, degraded mode). |
| `ERROR` | Genuine abnormality the system could not handle at this layer (failures, caught panics, invariant violations). |

The TRACE/DEBUG dividing line is downstream value: a line that could ever help reconstruct a failure is
DEBUG; volume with no reconstruction value (heartbeats, raw stream chunks) is TRACE.

### Message structure

`msg` is a **short, stable, data-free clause**. No interpolation of any kind: no `fmt.Sprintf` into
`msg` (Go), no template literals (TypeScript), no `"\()"` interpolation (Swift). The same logical event
always produces the byte-identical `msg` string. Rationale: Loki groupability — counting and alerting on
a line (`count_over_time({...} |= "session started" [1h])`) only works when the message is a constant.
Interpolated messages create one unique string per occurrence and defeat aggregation.

### Metadata

All variable context goes into typed keys in the `fields` object — never into `msg`. Correlation IDs
(`session_id`, `conversation_id`, `trace_id`, `span_id`) stay top-level, never nested inside `fields`.
A log line is the pair (constant `msg`, structured `fields`): the message says *what happened*, the
fields say *to what, with which IDs, and how long it took*.

### Canonical field vocabulary

One snake_case vocabulary across the operational `fields` object and telemetry payloads. The telemetry
v2 context keys are adopted verbatim for correlation: `session_id`, `conversation_id`, `run_id`.
Canonical keys for common concepts:

| Key | Type | Meaning |
|---|---|---|
| `turn` | int | LLM turn index within a run |
| `tool` | string | Tool name |
| `model` | string | Model ID |
| `provider` | string | Provider ID |
| `duration_ms` | int | Wall-clock duration in milliseconds |
| `cost_usd` | float | Cost in USD |
| `error` | string | Error message (relay normalizes `err` → `error` at collection time) |
| `count` | int | Generic cardinality |
| `path` | string | Filesystem path |
| `status` | string/int | Status or state, or HTTP status code |
| `reason` | string | Why a decision or branch was taken |
| `attempt` | int | Retry attempt number |
| `max` | int | Ceiling paired with a counter (`attempt`/`max`) |

New keys may be added, but an existing canonical key must never be shadowed by a synonym
(`elapsed_ms`, `durationMs`, `err`) on any surface.

### Tag convention

`tag` values are lowercase-dotted subsystem paths: `backend.runloop`, `session.dispatch`,
`remote.transport`. Exception: extension-component logs use the extension name as `tag` (stamped by the
host).

---

## Example lines

Engine INFO with session context:
```json
{"ts":"2024-11-15T22:04:05.123456789Z","level":"INFO","component":"engine","tag":"session","msg":"session started","session_id":"dd2ca947-1234-5678-abcd-ef0123456789","conversation_id":"1780093348767-c1c03e998388","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","fields":{"model":"claude-opus-4-5","profile":"default"}}
```

Extension DEBUG (structured fields preserved, not concatenated into msg):
```json
{"ts":"2024-11-15T22:04:05.456789012Z","level":"DEBUG","component":"extension","tag":"my-agent","msg":"tool called","session_id":"dd2ca947-1234-5678-abcd-ef0123456789","conversation_id":"1780093348767-c1c03e998388","fields":{"tool":"Read","path":"/tmp/foo.txt","duration_ms":12}}
```

Engine WARN, no session (daemon startup):
```json
{"ts":"2024-11-15T22:04:04.000000000Z","level":"WARN","component":"engine","tag":"server","msg":"socket already exists, removing stale","fields":{"path":"/Users/j/.ion/engine.sock"}}
```

---

## Loki label policy

Only three fields become Loki stream labels. All other fields stay in the log body.

| Label | Source field | Rationale |
|---|---|---|
| `component` | `component` | Surface-level fan-out (`engine`, `desktop`, etc.) |
| `level` | `level` | Severity filtering without full-text scan |
| `tag` | `tag` | Extension-level fan-out (`ext:my-agent`, `session`, etc.) |

Correlation IDs (`session_id`, `conversation_id`, `trace_id`, `span_id`) stay in the body and are queried
with LogQL `| json | session_id = "..."`. Promoting them to labels would create extreme label cardinality.

---

## Telemetry event fields (`telemetry.jsonl`)

Ion emits a separate telemetry stream to `~/.ion/telemetry.jsonl` when telemetry
is enabled. Telemetry lines are NDJSON with a **different schema** from the operational
log — each line is a structured event with top-level metadata and a `payload` object.

### Top-level telemetry fields

All telemetry events carry these top-level fields. The current schema version is **v3**
(v2 = the unified snake_case contract; v3 added the additive attribution fields `event_id` and the
populated-capable `user` carrier — v2 consumers decode v3 lines unchanged):

| Field | Type | Notes |
|---|---|---|
| `name` | string | Event kind, e.g. `run.complete`, `llm.call`. The `payload.kind` field was removed in schema v2. |
| `ts` | string | RFC3339Nano UTC string (R1). Replaces the old int64 `timestamp` field from schema v1. |
| `schema` | int | Schema version integer (R4). Currently `3`. Self-describing for central sinks. |
| `component` | string | Always `"engine"` (R3). Surface discriminator. |
| `install_id` | string | Anonymous per-install UUID (R5). Minted once at `~/.ion/install_id`. Stable across sessions. |
| `host` | string | Machine hostname (R19). For admin display and fleet segmentation. |
| `version` | string | Engine build version string (R21). Which binary emitted this event. |
| `event_id` | string | Per-event unique ID, 16 hex chars (R22, schema v3). For downstream dedup during retry storms. Empty on the `telemetry.schema_writer_changed` sentinel. |
| `user` | string | Omit-when-absent (R20). Populated via the OIDC identity seam (`SetUserIdentity`) whenever a user is signed in; restamped live on sign-in/sign-out. Absent on installs with no signed-in identity. |
| `payload` | object | Event-specific fields (all snake_case). |
| `context` | object | Correlation context: `session_id`, `conversation_id`, `run_id`. Extension attribution fields `extension` and `extension_version` are additive within this object — see § "Extension attribution" below. |
| `trace_id` | string | OTEL-compatible 32-hex trace ID. Omit when no trace is active. |

> **Dashboard consumers.** The identity fields power the audience packs: **Ion Fleet** aggregates by `host`, `install_id`, and `version` (hosts reporting, installs per host, version drift); **Ion Users** aggregates by `user` (spend, runs, tool failures, trust posture), coalescing lines without an identity into an "unassigned" bucket. `host` and `user` are not Alloy-promoted, so those dashboards parse with `| json` — see `docs/observability/dashboards/src/queries-fleet.ts`.

### `run.complete` payload fields (all snake_case)

| Payload key | Type | Notes |
|---|---|---|
| `model` | string | Model ID of the most recent turn. |
| `run_cost_usd` | float | Per-run cost in USD (cache-aware). Canonical cost field for dashboard queries. |
| `aggregate_cost_usd` | float | Full conversation cost (this run + all descendant dispatches via dispatch tree walk). |
| `dispatch_depth` | int | Always 0 at manager-level emission (root session). |
| `duration_ms` | int | Wall-clock duration of the run in milliseconds. |
| `num_turns` | int | Number of LLM turns in the run. |
| `input_tokens` | int | Provider-reported input tokens. |
| `output_tokens` | int | Provider-reported output tokens. |
| `cache_read_input_tokens` | int | Tokens served from prompt cache. |
| `cache_creation_input_tokens` | int | Tokens written into the prompt cache. |

**Dashboard recipe:** use `payload_run_cost_usd` (mapped from `payload.run_cost_usd` by Alloy) for all cost panels:
```logql
sum(sum_over_time({kind="run.complete"} | json | unwrap payload_run_cost_usd [24h]))
```

### Extension attribution (additive, schema v3+)

`context.extension` and `context.extension_version` are additive fields within the `context` object. They are the first exercised additive evolution of the telemetry context under ADR-019: no schema version bump, omit-when-absent in both directions, backward-compatible with all existing consumers.

| Context key | Type | Notes |
|---|---|---|
| `extension` | string | Hosting extension's friendly name (e.g. `"ion-dev"`). Present only on events emitted by extension-hosted sessions. Absent on direct API runs and all pre-attribution log lines. |
| `extension_version` | string | Extension's manifest version (e.g. `"1.2.3"`), read from `extension.json` at host load time. Absent when the manifest carries no `version` field or is not present. |

These fields appear on `run.complete`, `cache.savings`, `llm.call`, and `dispatch.agent` events. Old lines without these fields are valid schema v3 events — they simply group as "unattributed" in the Ion Extensions dashboard.

Alloy promotes them as structured metadata under the names `context_extension` and `context_extension_version` (NOT stream labels — unbounded cardinality). LogQL panels reference them with `| context_extension = "..."`.

**Extension version source:** the version comes from `extension.json` → `Manifest.Version` at host load time, not from the extension's runtime broadcast. The manifest is the build-time constant; it never changes after the extension is loaded. Extension authors add the field to their `extension.json`:
```json
{ "name": "my-extension", "version": "1.2.0" }
```

### Schema versioning (version-forward, append-only)

The engine writes a `~/.ion/telemetry.schema.json` sidecar alongside `telemetry.jsonl`.
The sidecar contains `{"highestSchemaSeen": ..., "stampedAt": ..., "engineVersion": "..."}` where
`highestSchemaSeen` is the **maximum schema version ever written to the file** — a monotonic
high-water mark that is only raised, never lowered.

On startup, the engine runs `stampSchemaCheckpoint`:
- **Version match:** no action.
- **Upgrade (current > highest):** raise `highestSchemaSeen`, append a `telemetry.schema_writer_changed` event.
- **Downgrade (current < highest):** do NOT touch the sidecar or file; append a `telemetry.schema_writer_changed` event so the transition is observable.
- **Fresh install:** write the sidecar at the current version; no event.

Files are **never renamed, archived, or truncated** on version transitions. Each line self-describes its
schema via the top-level `schema` field. The Alloy pipeline and Grafana dashboards handle multi-schema
files by filtering on `schema_version` in `structured_metadata`.

Legacy sidecars from the old rotate-on-mismatch design (key `schemaVersion`) are read transparently and
migrated on the next startup. See ADR-019 § "Superseded mechanisms" for the rationale.

See `docs/observability/cost-model.md` for the full cost model reference.

---



### engine (`component: "engine"`)

- Written by `utils.Log` / `utils.LogCtx` (Go, `log/slog` JSON handler).
- File: `~/.ion/engine.jsonl`, rename-rotate at a config-driven size cap (default 20 MB), default 3 generations (`.1`, `.2`, `.3`). Configurable via `LoggingConfig.MaxSizeMB` and `LoggingConfig.MaxFiles` in `engine.json`.
- `tag` = the logger tag string passed to `utils.Log(tag, msg)`.
- Context IDs injected automatically when `utils.LogCtx(ctx, ...)` is called.

### extension (`component: "extension"`)

- Emitted via JSON-RPC `log` notification from the SDK subprocess.
- `tag` MUST be the extension name (host fills this; extension code passes its own name).
- `session_id` and `conversation_id` are stamped by the host from the bound session context.
- `fields` map is preserved exactly as sent by the SDK — never concatenated into `msg`.

### desktop (`component: "desktop"`)

- Written by Electron main process and renderer process.
- File: `~/.ion/desktop.jsonl`, rename-rotate at 20 MB, 3 generations (`.1`, `.2`, `.3`).
- `tag` = subsystem label (`ipc`, `conversation`, `sync`, etc.).

### ios (`component: "ios"`)

- Written via `DiagnosticLog.log()` to `~/.ion/ios-diagnostic-logs.jsonl` on the paired desktop.
- On-device rolling storage: 5 sessions max, 10 MB total cap. Desktop-side file: rename-rotate at 10 MB, 2 generations (`.1`, `.2`).
- `tag` = Swift subsystem label.
- **Per-device identity in `fields`.** Every iOS line carries device-attribution keys in its `fields` object so the central sink can answer "which device, on which app build, paired to which desktop, produced this line?" The identity is split by who owns it:

  | Field | Stamped by | Meaning |
  |---|---|---|
  | `device_model` | iOS | Hardware model identifier from `utsname.machine` (e.g. `iPhone15,3`). |
  | `app_version` | iOS | App marketing version (`CFBundleShortVersionString`). |
  | `app_build` | iOS | App build number (`CFBundleVersion`). |
  | `os_version` | iOS | iOS version (`UIDevice.systemVersion`). |
  | `seq` | iOS | Monotonic per-line sequence (string-encoded int), persisted in `UserDefaults` and never reset across launches. The desktop's exactly-once pull cursor: it requests lines with `seq` greater than its persisted per-device mark and dedups on `seq` before appending, so a reconnect or desktop restart resumes instead of re-shipping history. Independent of on-device file rotation (unlike a line count). |
  | `device_id` | Desktop | The paired device's opaque id (from the pull-response command), injected at persist time. |
  | `device_name` | Desktop | The paired device's human name (e.g. `Josh's iPhone`), injected at persist time. |
  | `desktop_host` | Desktop | The collecting desktop's hostname, injected at persist time. **Mirrors the telemetry `host` value** for the same machine, so an iOS line cross-references the Ion Fleet board's host rows — the basis for the device↔desktop pairing view on the Ion Mobile dashboard. |

  These power the **Ion Mobile** dashboard (`docs/observability/dashboards/src/dashboards/mobile.ts`), which queries the `{component="ios"}` log stream. Like `host`/`user` on the Fleet/Users packs, none of these are Alloy-promoted stream labels — dashboards parse them with `| json`.

### relay (`component: "relay"`)

- Written by the Go relay server. Writes canonical JSONL to a **file** (`RELAY_LOG_FILE`, default
  `/var/log/ion/relay.jsonl`) with nested `fields` (always present, `{}` when empty) and the full
  five-level enum including `TRACE` — parity with engine/desktop/ios. `RELAY_LOG_OUTPUT` selects
  `stdout` | `file` | `both` (default `stdout`). Rename-rotate at 20 MB, default 3 generations;
  configurable via `RELAY_LOG_MAX_FILES` env var.
- `RELAY_LOG_LEVEL=trace` enables TRACE; default minimum level is INFO.
- `tag` = subsystem label (`ws`, `auth`, `sync`, etc.).

---

## Schema stability

This schema is a **published contract**. Additions are additive (new optional fields). Removals or renames
require an ADR. The `fields` object is intentionally open-ended so surfaces can emit rich structured context
without schema changes.

### Telemetry schema versioning

The telemetry stream (`telemetry.jsonl`) carries its own versioned schema separate from the operational log
schema. The current version is **schema v3** (`TelemetrySchemaVersion` in
`engine/internal/telemetry/schema.go` is authoritative). The `schema` top-level field in every telemetry event
self-identifies the version. The `~/.ion/telemetry.schema.json` sidecar's `highestSchemaSeen` field records
the maximum version ever written to the file. See the "Schema versioning" section above and ADR-019.
