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
| `trace_id` | string | NO | W3C trace-context trace-id: 32 lowercase hex chars. Scoped to **one prompt-to-completion run** — see § "Correlation-ID vocabulary". Omit when no run is in flight. |
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

### Correlation-ID vocabulary

Ion emits five correlation identifiers. They are not interchangeable, and picking the wrong one is
the most common source of unusable traces. Each answers a different question:

| ID | Scope | Lifetime | Use it for |
|---|---|---|---|
| `conversation_id` | One persisted conversation tree | Durable — survives engine restarts, reattaches, and days of wall-clock | Long-term conversation tracking, audit trails, resource scoping. The ID a human means by "that conversation". |
| `trace_id` | **One prompt-to-completion run** | The run | **Distributed tracing.** The `operation_Id` in Application Insights, the trace-id in a `traceparent` header, the trace in Jaeger/Tempo. |
| `run_id` | The same single run | The run | Joining Ion's own logs to Ion's own telemetry for one run. Engine-native, **not** W3C-shaped. |
| `session_id` | One engine session | The session — one client connection/tab, spanning many runs | Grouping the runs that shared a live session. This is the ID that used to be `trace_id`'s scope. |
| `dispatch_id` + `depth` | One sub-agent within a run | The dispatch | Locating a child agent inside its parent's trace. `depth` is 0 for the root session. |

**Why `trace_id` is run-scoped.** A trace represents one logical transaction. A session can stay
open for hours across hundreds of prompts, so a session-lifetime trace produced a single unreadable
"trace" and could not serve as an APM operation id. Scoping it to the run makes each prompt a
transaction, which is what every OTLP backend expects. If you want the old session-wide pivot, query
`session_id` — it is on every line and always was.

**Lines emitted outside a run carry no `trace_id`.** Session start/stop, extension load, and
schedule/webhook deliveries have no run in flight, so the key is absent rather than empty (see
§ "Empty-string rule"). Those lines remain joinable by `session_id` and `conversation_id`.

**Consuming `trace_id` from an extension.** `ctx.traceId` is valid to place directly in a
`traceparent` header, so a downstream API call joins the engine's trace:

```
traceparent: 00-<ctx.traceId>-<span id the extension mints>-01
```

The extension mints its own span id — its span *is* a new span, so it becomes the parent-id for the
callee. See [`docs/extensions/sdk-typescript.md`](../extensions/sdk-typescript.md) § "Tracing and
correlation" for the full recipe.

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
is enabled. Schema v4 stores one compact frame per JSONL line. A frame interns
shared identity and correlation data, then carries one or more event records.
The telemetry forwarder expands each frame before it sends events to Alloy.

### Schema v4 compact frame

A v4 line has this shape:

| Field | Type | Notes |
|---|---|---|
| `record` | string | Always `"telemetry.frame"`. Identifies a compact frame. |
| `schema` | int | Always `4`. |
| `identities` | array | Interned source identities. Each entry has `component`, `install_id`, `host`, `version`, and optional `user`. |
| `contexts` | array | Interned optional correlation objects. Each entry has `context` and optional `trace_id`. |
| `events` | array | Event records. `i` indexes `identities`; optional `c` indexes `contexts`. |

Each event record contains `i`, optional `c`, `name`, `ts`, optional `event_id`,
and `payload`. The expanded event is the same public telemetry event shape that
schemas v1-v3 used: combine the indexed identity and context with the event
record, then set its `schema` to `4`.

The compact file format is a storage format, not a dashboard contract. The
telemetry forwarder decodes v1-v4 lines and posts expanded events to Alloy. It
keeps the `service="ion-telemetry"`, `service_name="ion-telemetry"`, and `kind`
labels, plus the structured metadata names that the dashboards use. Existing
dashboard queries therefore do not change.

### Expanded telemetry event fields

After expansion, every event has these fields:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Event kind, such as `run.complete` or `llm.call`. `payload.kind` is not used. |
| `ts` | string | RFC3339Nano UTC string. |
| `schema` | int | Schema version. Expanded v4 frame events report `4`. |
| `component` | string | Source component, normally `"engine"`. |
| `install_id` | string | Anonymous per-install UUID. |
| `host` | string | Machine hostname. |
| `version` | string | Engine build version string. |
| `event_id` | string | Per-event unique ID for downstream deduplication. |
| `user` | string | Omit when no authenticated identity exists. |
| `payload` | object | Event-specific fields, all snake_case. |
| `context` | object | Correlation context: `session_id`, `conversation_id`, and `run_id`; it can also contain extension attribution. |
| `trace_id` | string | W3C trace-context trace ID. Omit when no run is in flight. |

### `run.complete` payload fields (all snake_case)

| Payload key | Type | Notes |
|---|---|---|
| `model` | string | Model ID of the most recent turn. |
| `run_cost_usd` | float | Per-run cost in USD. Canonical cost field for dashboard queries. |
| `aggregate_cost_usd` | float | Full conversation cost, including descendant dispatches. |
| `dispatch_depth` | int | Root run is `0`. |
| `duration_ms` | int | Wall-clock duration. |
| `num_turns` | int | Number of LLM turns. |
| `input_tokens` | int | Provider-reported input tokens. |
| `output_tokens` | int | Provider-reported output tokens. |
| `cache_read_input_tokens` | int | Tokens served from prompt cache. |
| `cache_creation_input_tokens` | int | Tokens written into prompt cache. |

### Extension attribution

`context.extension` and `context.extension_version` are optional fields. Alloy
exposes them as `context_extension` and `context_extension_version` structured
metadata, not labels. Old expanded events without these fields remain valid.

### Schema versioning and rotation

The engine writes `~/.ion/telemetry.schema.json` next to `telemetry.jsonl`. Its
`highestSchemaSeen` value is a monotonic high-water mark. A writer upgrade or
downgrade appends a `telemetry.schema_writer_changed` event. Version transitions
never rotate, archive, or remove telemetry data.

Size rotation is separate. When the configured file size cap is reached, the
live file is renamed to `.1`, older archives shift to `.2`, `.3`, and so on, and
the oldest archive beyond `maxFiles` is removed. A collector must read the live
file before its configured archive window expires. The local reference stack
forwards the live file only; it does not automatically replay `.1` archives.

Legacy v1-v3 expanded lines remain readable by the telemetry forwarder. This
allows one file to contain older expanded events and v4 compact frames during an
upgrade.

---



### engine (`component: "engine"`)

- Written by `utils.Log` / `utils.LogCtx` (Go, `log/slog` JSON handler).
- File: `~/.ion/engine.jsonl`, rename-rotate at a config-driven size cap (default 20 MB), default 3 generations (`.1`, `.2`, `.3`). Configurable via `LoggingConfig.MaxSizeMB` and `LoggingConfig.MaxFiles` in `engine.json`.
- `tag` = the logger tag string passed to `utils.Log(tag, msg)`.
- Context IDs injected automatically when `utils.LogCtx(ctx, ...)` is called.

#### Machine identity in `fields` (engine)

When egress is configured, the engine forwarder (`engine/internal/utils/log_egress.go`) stamps the following stable machine-identity fields onto every egress record. They are absent from the local `engine.jsonl` line (local JSONL uses the slog handler); they appear in the record shipped to the HTTP/OTEL egress target. Absent keys mean the value is empty or the platform has no source for it.

| Field | Source | Notes |
|---|---|---|
| `host` | `os.Hostname()` | Always present. Matches the `host` field on telemetry events for the same machine — the Fleet board join key. |
| `machine_id` | `ioreg IOPlatformUUID` (macOS) / `/etc/machine-id` (Linux) | Stable **hardware** UUID independent of the username. Absent on platforms without a source. Distinct from `install_id` — see the note below. |
| `install_id` | `~/.ion/install_id` (minted once) | Anonymous **per-install** UUID, the same value telemetry stamps (`utils.InstallID`). Joins egress records to the telemetry stream. Distinct from `machine_id` — see the note below. |
| `mdm_device_id` | MDM config (`MDMDeviceID` key) | Present only on MDM-enrolled machines (e.g. Intune). Enables cross-reference to the MDM console. |
| `mdm_serial` | MDM config (`MDMSerialNumber` key) | Present only on MDM-enrolled machines. |

> **`machine_id` vs `install_id` are different identifiers, not a naming drift.** `machine_id` is the stable **hardware** UUID (survives reinstalls, changes on new hardware); `install_id` is the **per-install** anonymous UUID (changes on reinstall, joins to the telemetry stream which stamps the same value). Both ship on every egress record so a consumer can group by hardware (`machine_id`) or by install (`install_id`) as needed.

Every egress record also carries a per-record `event_id` (16 hex chars, stamped at the enqueue chokepoint) for downstream dedup during retry storms — the same shape as the telemetry `event_id`. A record that already carries an `event_id` (e.g. a tailed telemetry event) keeps its own.

### extension (`component: "extension"`)

- Emitted via JSON-RPC `log` notification from the SDK subprocess.
- `tag` MUST be the extension name (host fills this; extension code passes its own name).
- `session_id` and `conversation_id` are stamped by the host from the bound session context.
- `fields` map is preserved exactly as sent by the SDK — never concatenated into `msg`.

### desktop (`component: "desktop"`)

- Written by Electron main process and renderer process.
- File: `~/.ion/desktop.jsonl`, rename-rotate at 20 MB, 3 generations (`.1`, `.2`, `.3`).
- `tag` = subsystem label (`ipc`, `conversation`, `sync`, etc.).

#### Machine identity in `fields` (desktop)

After `loadMachineIdentity()` resolves at app startup, the desktop logger stamps the following fields onto every log line (via `initLoggerMachineIdentity`). Caller-supplied fields always take precedence over these ambient values — they fill absent keys only.

| Field | Source | Notes |
|---|---|---|
| `host` | `os.hostname()` | Always present. `.local` suffix stripped (matches the engine and telemetry `host` value). |
| `machine_id` | `ioreg IOPlatformUUID` (macOS) | Stable hardware UUID. Absent on non-macOS platforms. |
| `mdm_device_id` | `/Library/Managed Preferences/com.ion.engine.plist` (`MDMDeviceID` key) | Present only on MDM-enrolled macOS machines. |
| `mdm_serial` | `/Library/Managed Preferences/com.ion.engine.plist` (`MDMSerialNumber` key) | Present only on MDM-enrolled macOS machines. |

### ios (`component: "ios"`)

- Written via `DiagnosticLog.log()` to `~/.ion/ios-diagnostic-logs.jsonl` on the paired desktop.
- On-device rolling storage: 5 sessions max, 10 MB total cap. Desktop-side file: rename-rotate at 10 MB, 2 generations (`.1`, `.2`).
- `tag` = Swift subsystem label.
- **Per-device identity in `fields`.** Every iOS line carries device-attribution keys in its `fields` object so the central sink can answer "which device, on which app build, paired to which desktop, produced this line?" The identity is split by who owns it:

  | Field | Stamped by | Meaning |
  |---|---|---|
  | `device_id` | iOS | Stable per-device hardware identity from `UIDevice.identifierForVendor` (UUID string). Survives app reinstalls and re-pairings; resets only on a full device wipe. This is the authoritative durable device identifier for grouping and liveness queries. |
  | `device_model` | iOS | Hardware model identifier from `utsname.machine` (e.g. `iPhone15,3`). |
  | `app_version` | iOS | App marketing version (`CFBundleShortVersionString`). |
  | `app_build` | iOS | App build number (`CFBundleVersion`). |
  | `os_version` | iOS | iOS version (`UIDevice.systemVersion`). |
  | `mdm_device_id` | iOS | MDM-assigned device ID from the Managed App Config key `MDMDeviceID`. Present only on MDM-enrolled devices (e.g. Intune-managed). Absent otherwise. |
  | `mdm_serial` | iOS | MDM-reported hardware serial number from the Managed App Config key `MDMSerialNumber`. Present only on MDM-enrolled devices. Absent otherwise. |
  | `seq` | iOS | Monotonic per-line sequence (string-encoded int), persisted in `UserDefaults` and never reset across launches. The desktop's exactly-once pull cursor: it requests lines with `seq` greater than its persisted per-device mark and dedups on `seq` before appending, so a reconnect or desktop restart resumes instead of re-shipping history. Independent of on-device file rotation (unlike a line count). |
  | `pairing_id` | Desktop | The ECDH channel ID for the specific desktop pairing session that collected these logs. Links a log line to a pairing session — distinct from `device_id` (hardware) and stable across reconnects within the same pairing. Injected at persist time. |
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
schema. The current file format is **schema v4** (`TelemetrySchemaVersion` in
`engine/internal/telemetry/schema.go` is authoritative). A v4 line is a compact frame, and its expanded events
report schema `4`. The `~/.ion/telemetry.schema.json` sidecar's `highestSchemaSeen` field records
the maximum version ever written to the file. See the "Schema versioning and rotation" section above and ADR-019.
