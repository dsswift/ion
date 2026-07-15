# ADR-019: Logging architecture and standards (unified log contract)

**Status:** Accepted (retroactive — documents shipped behavior)  
**Date:** 2026-07-06  
**Authors:** Josh Sprague

**Supersession note (2026-07-07):** The `rotate-on-mismatch` and `auto-wipe`
mechanisms described in the original R18a/R18b rationale below are superseded by
the **version-forward append-only policy** (commit `version-forward checkpoint`).
See § "Superseded mechanisms" at the bottom of this ADR for the rationale and the
replacement policy. No pipeline or Loki configuration changes are required; the
`stage.timestamp` + `reject_old_samples = false` settings are retained for
out-of-order line recovery and delayed-shipping scenarios.

## Context

Ion emits two structured NDJSON streams: the **operational log** (diagnostic
JSONL written per surface — `~/.ion/engine.jsonl`, `~/.ion/desktop.jsonl`,
`~/.ion/ios-diagnostic-logs.jsonl`, the relay's `relay.jsonl`) and the
**telemetry stream** (`~/.ion/telemetry.jsonl`, versioned event schema for
central sinks). Before the unified log contract landed, the two streams had
drifted: telemetry carried an int64 timestamp while operational logs used
RFC3339Nano; payload keys mixed camelCase and snake_case; events duplicated
their kind inside the payload; there was no schema version, no install
identity, no host dimension, and no reserved user-identity carrier. Central
ingestion (Loki via Alloy) could not distinguish schema generations, could
not count installs, and rejected re-ingested history older than one hour.

Separately, the operational log had a four-level model (DEBUG/INFO/WARN/ERROR)
with no home for pure high-frequency noise, no message-structure standard
(interpolated messages defeated Loki grouping), and no canonical field
vocabulary — the same concept appeared as `durationMs`, `duration_ms`, and
free-text inside `msg` depending on the surface.

This ADR retroactively documents the shipped solution: the **R1–R21 unified
log contract** for the telemetry stream, and the operational-log standards
(five-level model, message structure, metadata discipline, canonical field
vocabulary, tag convention) that now apply across all five surfaces.

## Decision

### 1. The R1–R21 unified log contract (telemetry stream, schema v2)

The contract is a numbered requirement set (R1–R21) from the implementation
plan that shipped in commit `7d6319ed` and its companions. The R-numbers
below are the ones pinned in source (`engine/internal/telemetry/telemetry.go`
struct comments, emitter comments, and the contract test matrix). Requirement
numbers from the working plan that do not surface in code were folded into
the adjacent requirements listed here; the authoritative statement of the
contract is the test matrix, not the plan numbering.

| R | Requirement | Enterprise rationale |
|---|---|---|
| R1 | `ts` is an RFC3339Nano UTC string (replaces the old int64 `timestamp`) | Event-time indexing in Loki with nanosecond precision; human-readable in raw files; one timestamp format across operational and telemetry streams |
| R3 | `component` is stamped on every event (`"engine"`) | Surface discriminator when multiple emitters feed one central sink |
| R4 | `schema` is a version integer on every event (currently `2`) | Self-describing lines: central sinks and the auto-wipe utility can distinguish schema generations without out-of-band metadata |
| R5 | `install_id` is a stable anonymous per-install UUID (minted once at `~/.ion/install_id`) | Exact fleet counts (installs, active installs) without any PII |
| R7 | All payload keys are snake_case (`run_cost_usd`, `duration_ms`, `num_turns`, `input_tokens`, …); legacy camelCase keys are forbidden | One casing convention for LogQL queries and Alloy `structured_metadata` mapping; no dual-key drift |
| R9 | Span-end attributes are snake_case (`stop_reason`, `duration_ms`) | Spans feed the same pipeline as events; same casing rule applies |
| R11 | `payload.kind` is forbidden — the event kind lives in the top-level `name` only | Single source of truth for event identity; `kind` stays a low-cardinality stream label, never duplicated into the body |
| R18a | Alloy indexes events by the `ts` field via `stage.timestamp` with a nanosecond-capable layout | Event-time (not ingest-time) ordering; correct time-series queries even when lines arrive delayed or out of order |
| R18b | Loki accepts event-time entries outside its default reject window (`reject_old_samples = false`) | Lines delayed by spool drain or network backoff land at their true event time without rejection |
| R19 | `host` carries the human-readable machine name | Admin display and fleet segmentation in enterprise dashboards (recorded as R15 in the landing commit message; R19 is the number pinned in current source) |
| R20 | `user` is reserved and omitted when absent — never populated today | Forward-compatible user-identity carrier; populated by a future enterprise OIDC identity source without a schema break |
| R21 | `version` carries the engine build string | Every line identifies which binary emitted it — build-level fault isolation across a fleet |

**Enforcement:** `engine/internal/telemetry/contract_test.go` is the
enforcement mechanism — a 7-test version-forward matrix (schema_test.go) plus
per-emitter contract tests that pin every requirement above:
version-forward checkpoint behavior (7 tests: downgrade-no-rotate, upgrade,
match-no-op, fresh-install, ping-pong regression, old-key migration, idempotency),
snake_case payload keys with forbidden legacy camelCase keys (R7), the
no-`kind` rule per emitter family (R11, 4 tests), install_id minting (R5),
the full top-level field set (R1/R3/R4/R5/R20), and the event-time indexing
configuration in the checked-in Alloy/Loki configs (R18a/R18b). A change that
violates the contract fails `go test ./internal/telemetry/`.

### 2. Five-level operational log model

All five operational surfaces (engine, desktop, ios, relay, extension) use a
five-level enum: `TRACE < DEBUG < INFO < WARN < ERROR`. TRACE is new; it sits
below DEBUG on every surface (engine `LevelTrace`, desktop `LEVEL_ORDER` 0,
relay `slogLevelTrace`, iOS `DiagnosticLog.Level.trace`). Default minimum
level stays INFO everywhere.

Per-level rubric:

| Level | Rubric |
|---|---|
| TRACE | Pure high-frequency noise: per-chunk, per-tick, per-frame emissions that carry no downstream or reliability signal. Off by default; enabled only for deep protocol-level debugging. |
| DEBUG | Replayable diagnostic detail: carries the IDs and intermediate values needed to reconstruct the exact code path after the fact. Verbose but signal-bearing. |
| INFO | State transitions, resolved decisions, and operation outcomes. The always-on narrative of what the system did and why. |
| WARN | Genuine abnormality the system recovered from or tolerated: degraded mode, retry, fallback, unexpected-but-handled input. |
| ERROR | Genuine abnormality the system could not handle at this layer: failures, caught panics, invariant violations. |

The dividing line between TRACE and DEBUG is downstream value: if a line
would ever help reconstruct a failure, it is DEBUG; if it is volume with no
reconstruction value (heartbeats, raw stream chunks), it is TRACE.

### 3. Message-structure standard

`msg` is a **short, stable, data-free clause**. No interpolation of any kind:
no `fmt.Sprintf` into `msg` (Go), no template literals (TypeScript), no
`"\()"` interpolation (Swift). The same logical event always produces the
byte-identical `msg` string.

Rationale: Loki groupability. Grouping, counting, and alerting on a log line
(`count_over_time({...} |= "session started" [1h])`) only works when the
message is a constant. An interpolated message creates one unique string per
occurrence, defeating aggregation and inflating index cardinality. Constant
messages also make cross-surface correlation trivial — the same event name
greps identically in every file.

### 4. Metadata standard

All variable context goes into **typed fields**, never into `msg`. On the
operational log this is the `fields` object (always present, `{}` when
empty); correlation IDs (`session_id`, `conversation_id`, `trace_id`,
`span_id`) stay top-level per the schema. A log line is the pair
(constant `msg`, structured `fields`) — the message says *what happened*,
the fields say *to what, with which IDs, and how long it took*.

### 5. Canonical snake_case field vocabulary

One vocabulary across the operational `fields` object and telemetry payloads.
The telemetry v2 context keys are adopted verbatim as the correlation
vocabulary: `session_id`, `conversation_id`, `run_id`. Correlation IDs stay
top-level on operational lines (never nested inside `fields`).

Canonical field keys for common concepts:

| Key | Meaning |
|---|---|
| `turn` | LLM turn index within a run |
| `tool` | Tool name |
| `model` | Model ID |
| `provider` | Provider ID |
| `duration_ms` | Wall-clock duration, milliseconds, int |
| `cost_usd` | Cost in USD, float |
| `error` | Error message string (the relay normalizes `err` → `error` at collection time) |
| `count` | Generic cardinality |
| `path` | Filesystem path |
| `status` | Status/state string or HTTP status |
| `reason` | Why a decision or branch was taken |
| `attempt` | Retry attempt number |
| `max` | Ceiling paired with a counter (`attempt`/`max`) |

New keys may be added, but an existing canonical key must never be shadowed
by a synonym (`elapsed_ms`, `durationMs`, `err`) on any surface.

### 6. Tag convention

`tag` values are lowercase-dotted subsystem paths: `backend.runloop`,
`session.dispatch`, `remote.transport`. The dot separates the package or
area from the sub-area. Extension-component logs are the exception: `tag`
MUST be the extension name (stamped by the host).

### 7. Operational-log vs telemetry-stream boundary

The two streams have distinct jobs and neither absorbs the other:

- **Operational log** (this ADR's levels/message/metadata standards):
  diagnostic JSONL per surface. Answers "what did the code do on this
  machine?" Unversioned but additive-only schema
  (`docs/observability/log-schema.md`); rotation is truncate-in-place.
- **Telemetry stream** (the R1–R21 contract): versioned event stream
  (`schema` int, sidecar, checkpoint rotation) designed for central sinks
  and fleet aggregation. Answers "what is happening across installs?"

Both streams use snake_case throughout and share the correlation vocabulary
(`session_id`, `conversation_id`, `run_id`, `trace_id`), so a single LogQL
join pivots between them.

### 8. Enforcement

- The telemetry contract is machine-checked today by
  `engine/internal/telemetry/contract_test.go` (see § 1).
- The operational standards (levels, constant messages, canonical fields,
  tags) are machine-checked by a coming `check-logging` gate that scans
  emitter call sites for interpolated messages and non-canonical keys, and
  are normatively stated in `docs/observability/log-schema.md` and the
  logging policy in the root `AGENTS.md`.

## Consequences

### Positive

- One casing, one timestamp format, one correlation vocabulary across all
  five operational surfaces and the telemetry stream.
- Constant messages make Loki grouping, counting, and alerting reliable.
- Version-forward append-only telemetry: a downgraded writer never wipes
  history; schema transitions are observable via `telemetry.schema_writer_changed`
  events (see § "Superseded mechanisms").
- `install_id` + `host` + `version` give exact fleet counts and build-level
  fault isolation with zero PII.
- The reserved `user` field means enterprise identity attaches later without
  a schema break.
- TRACE gives high-frequency noise a home without polluting DEBUG replays.

### Negative / risks

- The contract is enforced for the engine's telemetry emitters; operational
  emitter discipline (constant `msg`, canonical keys) relies on the coming
  `check-logging` gate and review until that gate lands.
- Retroactive R-numbering: plan numbers absent from source (folded
  requirements) mean the R-sequence has gaps; the test matrix, not the
  numbering, is authoritative.
- The relay's file target writes inside its container
  (`/var/log/ion/relay.jsonl` by default); host-side collection requires a
  volume mount or the existing Docker-discovery ingestion path.

## Alternatives considered

### Option A: Merge operational and telemetry streams into one file

One stream, one schema. Rejected: the streams have different consumers
(local diagnostics vs central sinks), different retention (truncate-in-place
vs checkpoint/archive/re-ingest), and different volume profiles. Merging
forces central sinks to ingest TRACE noise and forces local diagnostics
through schema-version rotation.

### Option B: Version the operational log schema like telemetry

A `schema` int on every operational line. Rejected: the operational schema
is additive-only by contract and consumed primarily by `jq` and Alloy's
generic JSON stage; a version field adds ceremony without a consumer. The
telemetry stream versions because central sinks require it.

### Option C (chosen): Two streams, shared vocabulary, per-stream schema discipline

Operational log stays additive-only with normative standards; telemetry
carries the versioned R1–R21 contract. Shared snake_case and correlation
keys keep the two joinable.

## Future work

This logging work is the first stage of a deliberate progression:

1. **Unified log contract (this ADR)** — every line is structured,
   versioned (telemetry), correlated, and fleet-attributable.
2. **Enterprise OIDC auth** — populates the reserved `user` field (R20)
   with a real identity from the enterprise identity provider.
3. **Orion enterprise ingestion infrastructure** — central multi-install
   sinks consume the versioned stream (`schema` int + `install_id` + `host`
   + `version` are the dimensions that make this possible).
4. **Fleet auditability** — with identity attached and ingestion central,
   the log contract becomes the audit trail: who ran what, where, on which
   build, at what cost.

The enterprise realization of this progression — the reference architecture
for central collection, the per-component shipping guide, and the worked
five-layer enterprise example — is documented at
[`docs/enterprise/central-log-collection.md`](../../enterprise/central-log-collection.md).

## References

- `engine/internal/telemetry/telemetry.go` — `Event` struct, R-numbered field comments
- `engine/internal/telemetry/schema.go` — version-forward checkpoint, monotonic sidecar
- `engine/internal/telemetry/schema_test.go` — 7-test version-forward matrix
- `engine/internal/telemetry/contract_test.go` — per-emitter contract tests
- `docs/observability/log-schema.md` — normative operational schema + level/field tables
- `docs/observability/alloy-config.alloy`, `docs/observability/loki-config.yaml` — R18a/R18b ingestion configuration
- ADR-018 — cost centralization (source of the `run_cost_usd` canonical field)
- Root `AGENTS.md` § "Logging policy" — logging rules for contributors

## Addendum (2026-07-08): OTLP is the canonical operational-log egress contract

The operational-log egress path (`logging.egressTargets`) ships records to
downstream sinks via two targets: `otel` (OTLP/HTTP logs) and `http` (a JSON
array of Ion's native records). This addendum records the canonical-egress
decision and the fields→attribute typing convention so the engine and desktop
exporters stay identical.

### OTLP (`otel`) is canonical; `http` is the escape hatch

`egressTargets: ["otel"]` is the recommended, canonical egress for both the
engine and the desktop. OTLP/HTTP logs is vendor-neutral and understood by
every modern collector and backend, so the intended topology is **Ion emits
OTLP → a collector routes to Loki/Splunk/Elastic/archive**. All backend-specific
routing and auth live in the collector's pipeline config, never in Ion — Ion's
contract ends at "emit well-formed, lossless OTLP." The `http` target (Ion's
native record shape, one JSON array per batch) is the escape hatch for a
consumer that wants Ion's verbatim JSON and controls its own receiver; it is not
the standard path.

### Lossless: every field becomes an attribute

Both exporters carry the **complete** canonical record to every OTLP log record.
`msg` is the record body (the constant, data-free clause — no structured data is
duplicated into the body). The following become log-record attributes:

- `component` and `tag` (always);
- each in-scope correlation ID (`session_id`, `conversation_id`, `trace_id`) and
  `user` (omitted when absent, per the empty-string rule);
- **every key in the `fields` map**, flattened one attribute per key.

`run_id` is carried inside `fields` (it is not a top-level operational field —
see § 5 "Canonical snake_case field vocabulary" and the log schema), so it rides
through as its own attribute like any other `fields` key. Nothing on the on-disk
JSONL line is dropped on the OTLP wire.

### fields→attribute typing convention (native scalar)

Field values map to OTLP `AnyValue` by native type, and both exporters implement
this convention identically:

| `fields` value | OTLP attribute value |
|---|---|
| string | `stringValue` |
| bool | `boolValue` |
| integer | `intValue` (int64 rendered as a decimal string, per the OTLP/JSON protobuf mapping) |
| non-integer number | `doubleValue` |
| nested object / array | JSON-stringified into `stringValue` |

A **whole-valued number** (e.g. `5.0`) is emitted as `intValue`. This is
deliberate: a record whose `fields` survived a JSON spool round-trip has all its
numbers decoded as floats, and promoting whole floats to `intValue` makes the
live record and the spool-round-tripped record serialize identically. Attributes
are emitted **sorted by key** so output is deterministic across both surfaces.

### Engine↔desktop parity is a pinned contract

For the same canonical record, the engine (Go, `engine/internal/utils/log_egress.go`)
and desktop (TypeScript, `desktop/src/main/log-egress-otel.ts`) exporters produce
**structurally identical** OTLP output: same attribute keys, same value types,
same sorted order, same constant-`msg` body. This parity is enforced by tests —
`engine/internal/utils/log_egress_otel_test.go` pins the engine's attribute set
against a canonical record, and `desktop/src/main/__tests__/log-egress-otel.test.ts`
asserts the desktop output against that same engine attribute set. Any change to
one exporter's typing convention fails the other's parity test, forcing both back
into agreement. **Keep the two exporters identical**; the typing table above is
the shared convention, and `run_id` stays in `fields` (never promoted top-level)
on both sides.



### rotate-on-mismatch (removed 2026-07-07)

The original R4 implementation called `rotateFile()` when the on-disk sidecar's
`schemaVersion` differed from the current engine version. This renamed
`telemetry.jsonl` to `telemetry.jsonl.<ts>.v<N>.bak` and started a fresh empty
file. The intent was to keep the active file's lines homogeneous for Alloy queries.

**Why it was removed:** On 2025-07-06 a v2/v3 ping-pong between two branches
caused four rotations that deleted ~$323 of run-cost history. A downgraded
writer never signals intent to overwrite; rotation on any version mismatch
(including downgrade) is destructive and wrong. The correct model is
**append-only, version-forward**: files are never renamed or truncated; each
line self-describes its schema via the top-level `schema` field; the sidecar
tracks the highest-ever-seen schema as a monotonic high-water mark; and a
`telemetry.schema_writer_changed` event is emitted on any writer transition
(upgrade or downgrade) so the change is observable in Loki.

**Replacement:** `engine/internal/telemetry/schema.go` `stampSchemaCheckpoint`.
The sidecar key changed from `schemaVersion` to `highestSchemaSeen`; the old
key is read as a fallback so existing sidecars migrate transparently.

### auto-wipe observability gate (removed 2026-07-07)

`scripts/observability-schema-gate.sh` ran as a `dev.yaml` pre-init hook and
wiped the Loki named volumes when the sidecar `schemaVersion` differed from
the last-ingested version recorded in `~/.ion/telemetry.loki-ingest.json`.
Intent: keep the Loki schema consistent with the emitter.

**Why it was removed:** (1) The rotate-on-mismatch mechanism it depended on is
removed. (2) Auto-wiping an operator's Loki volumes destroys local history that
cannot be recovered. (3) Loki can already parse multi-schema files because each
line carries `schema` in `structured_metadata`; schema-filtered queries are
trivial (`| schema_version = "2"`). The `observability-status` utility now
reports only the sidecar high-water mark; wipe decisions are left to the
operator.

