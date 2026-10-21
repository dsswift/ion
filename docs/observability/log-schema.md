# Ion Unified Log Schema

Canonical JSONL schema for every surface the engine writes: **engine** and **extension**. A client of the engine that writes its own logs follows the same schema with its own `component` value; the archived Ion Studio clients did.

Every surface writes one JSON object per line (NDJSON). All fields are snake_case. No surface may invent
top-level fields outside this schema; additional context goes into `fields`.

**Schema version: 3.** The version covers the whole emitted contract: the local JSONL lines below, the
OTLP records every exporter ships (§ "OTLP correlation model"), the span set every surface emits
(§ "Spans"), and the names a collector indexes them under (§ "Names in Loki"). A change to any of them
bumps the version and moves every consumer Ion owns with it. Version 3 made every operation a span
(§ "Spans" lists them), put `trace_id` and `span_id` on every engine event of a run, added the runtime
figures to the System Metrics sample lines (§ "System Metrics sample (engine)", § "server"), and moved
the telemetry stream to schema v5 (§ "Telemetry schema versioning"). Version 2 is the previous
contract: the same lines without those spans and fields.

---

## Canonical fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `ts` | string | YES | RFC3339Nano, always UTC. Example: `2024-11-15T22:04:05.123456789Z` |
| `level` | string enum | YES | `TRACE` \| `DEBUG` \| `INFO` \| `WARN` \| `ERROR`. No absent-equals-INFO default — the field must be present on every line. |
| `component` | string enum | YES | `engine` \| `extension`; a client writing its own lines uses its own value |
| `tag` | string | NO | Subsystem tag within the component (`session`, `ext:my-agent`, etc.). For extension-component logs, this MUST be the extension name. |
| `msg` | string | YES | Human-readable message. No structured data embedded here; use `fields`. |
| `session_id` | string | NO | The engine session key: the opaque, client-supplied key that identifies the current engine session (`ClientCommand.Key`); any string the client chose. This is NOT the conversation ID. Omit (never `""`) when not in a session context. |
| `conversation_id` | string | NO | The engine-minted conversation-file identity, format `{unix-millis}-{12-hex-chars}` (e.g. `1780093348767-c1c03e998388`). This is the durable identity of the persisted conversation tree at `~/.ion/conversations/<id>.tree.jsonl`. A single conversation spans multiple sessions and runs. Omit (never `""`) when not associated with a conversation. |
| `trace_id` | string | NO | W3C trace-context trace-id: 32 lowercase hex chars. Scoped to **one prompt**, from the client's submit to the end of the engine's run — see § "Correlation-ID vocabulary" and § "Spans". Omit when no prompt is in flight. |
| `span_id` | string | NO | OpenTelemetry-compatible 16-hex span ID. Omit when no span is active. A span line carries its own `span_id` in `fields` instead (§ "Spans"). |
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
`msg` (Go), no template literals (TypeScript). The same logical event
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
| `trace_id` | **One prompt**, from the client's submit to the end of the run | The prompt | **Distributed tracing.** The `operation_Id` in Application Insights, the trace-id in a `traceparent` header, the trace in Jaeger/Tempo. |
| `run_id` | The same single run | The run | Joining Ion's own logs to Ion's own telemetry for one run. Engine-native, **not** W3C-shaped. |
| `session_id` | One engine session | The session — one client connection/tab, spanning many runs | Grouping the runs that shared a live session. This is the ID that used to be `trace_id`'s scope. |
| `dispatch_id` + `depth` | One sub-agent within a run | The dispatch | Locating a child agent inside its parent's trace. `depth` is 0 for the root session. |

**Why `trace_id` is run-scoped.** A trace represents one logical transaction. A session can stay
open for hours across hundreds of prompts, so a session-lifetime trace produced a single unreadable
"trace" and could not serve as an APM operation id. Scoping it to the run makes each prompt a
transaction, which is what every OTLP backend expects. If you want the old session-wide pivot, query
`session_id` — it is on every line and always was.

**Every engine event of a run carries the trace.** The engine stamps `trace_id` and `span_id` on each
`NormalizedEvent` it emits for a run (the `engine_*` events on the engine wire,
`engine/internal/types/normalized_event.go`): `trace_id` is the run's trace and `span_id` the engine span
the event was emitted under (`run.execute`, or the `llm.call` / `tool.execute` inside it). The server
carries both onto every outbound frame, so a client can place what it renders inside the prompt's trace
and close the loop with its own `prompt.visible` span. Both are optional fields; an event outside a run
has neither.

**Lines emitted outside a run carry no `trace_id`.** Session start/stop, extension load, and
schedule/webhook deliveries have no run in flight, so the key is absent rather than empty (see
§ "Empty-string rule"). Those lines remain joinable by `session_id` and `conversation_id`.

**The client that sends a prompt mints its `trace_id`.** The client starts the trace when the
operator submits and passes it on as a `traceparent`; the engine's run joins it. A pivot on
`trace_id` therefore returns that prompt's lines on every surface that handled it: the client's
span and the engine and extension lines of the run. A prompt that arrives with no valid
`traceparent` starts its trace at the engine, and so does a run the engine starts on its own (a
schedule, a webhook). Lines about no prompt carry
none; follow a conversation across prompts by `conversation_id` or `session_id`, which each surface
resolves per line. How the trace moves hop to hop is § "Spans".

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
| `error` | string | Error message |
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

## Spans

Spans are the unit of timing: every operation Ion times is a span, written through one helper
(`Collector.StartSpanCtx` in Go); no surface writes an ad hoc `elapsed_ms`. Durations become distributions downstream, not in app
code: Tempo's metrics-generator turns the spans into latency histograms and a service graph
(`traces_spanmetrics_*`, `traces_service_graph_*`; [README § Tempo](README.md#tempo)), which the Ion
Performance dashboard and its alerts read.

One user action is one W3C trace, end to end. A client mints a `traceparent` for the action it
sends; the engine joins it on `command.dispatch`, stamps the trace on every event of the run, and a
client closes the loop with its own render span when the effect is on screen. A prompt reads, from
the engine's side:

```
run.execute              engine                                     kind server
  context.assemble                                                  kind internal
  llm.call                                                          kind client
    llm.attempt          one request to the provider                kind client
  tool.execute                                                      kind internal
    mcp.call             a tool served by an MCP server             kind client
    permission.decide                                               kind internal
  hook.fanout            one hook point, every extension             kind internal
    extension.hook_latency   one extension's handler                kind client
  dispatch.agent         a sub-agent run; its own run.execute below kind internal
  compaction                                                        kind internal
  conversation.persist                                              kind internal
```

`run.execute` is a child of whatever client span sent the prompt, when the command carried a
`traceparent`, and a root otherwise. Every hop between two services is a client span whose child is
a server span in the next service; § "OTLP correlation model" says why.

Any other command a client sends reads `command.dispatch` with the engine's work under it. Start-up
is its own trace per process: `daemon.startup` (engine, with `config.load`, `provider.probe`,
`extension.spawn`, `mcp.start` under it) and `session.start` (engine, with `conversation.load`).

### Where each span starts and ends

| Span | Starts | Ends | Written by |
|---|---|---|---|
| `run.execute` | The engine run starts | The run exits | The engine's telemetry stream (every engine span below is a telemetry span event, `engine/internal/telemetry`) |
| `llm.call` | The engine starts one model turn, retries included | The turn's final response or error | Engine. Attributes `model` and `backend` |
| `llm.attempt` | One request to the provider | Its response or error | Engine, a child of `llm.call`; one per retry |
| `tool.execute` | The tool call is dispatched | Its result | Engine. Attribute `tool`; on a delegated CLI the span starts when the CLI reports the call |
| `mcp.call` | The engine sends a tool call to an MCP server | The server answers | Engine, a child of `tool.execute` |
| `permission.decide` | A permission check begins (rules, then the hook) | The decision | Engine, a child of `tool.execute` |
| `hook.fanout` | One hook point fires | Every registered extension has answered or timed out | Engine |
| `extension.hook_latency` | One extension's handler is called | It returns | Engine, a child of `hook.fanout` |
| `dispatch.agent` | A sub-agent dispatch is accepted | The child run reports back | Engine. The child's own `run.execute` is its child |
| `context.assemble` | The engine starts building the model context for a turn | The request body is ready | Engine |
| `compaction` | A compaction begins | The compacted tree is persisted | Engine |
| `conversation.load` / `conversation.persist` | The tree is read from, or written to, disk | The read or write returns | Engine |
| `command.dispatch` | The engine receives a client command | Its result is sent | Engine. Attribute `command`; a server span `engine.request` with the same `command` is its parent |
| `session.start` | A session is created or reattached | It is ready for a prompt | Engine, with `conversation.load` under it |
| `daemon.startup` | The engine process starts | The socket accepts clients | Engine, a root; `config.load`, `provider.probe`, `extension.spawn`, `mcp.start` are its children |
| `config.load` / `provider.probe` / `extension.spawn` / `mcp.start` | The config read, the provider reachability check, the extension subprocess launch, the MCP server start begins | It returns, or the init handshake completes | Engine |

### Propagation

`traceparent` is `00-<32 hex trace-id>-<16 hex parent span-id>-<2 hex flags>`. A value is valid only
at version `00`, lowercase hex, trace-id and span-id not all zero; the engine and every
client apply the same rule.

| Hop | Carrier |
|---|---|
| Client → engine | Every client command's `traceparent` (the `engine.request` client span, `engine.send_prompt` for a prompt; [client commands](../protocol/client-commands.md)) |
| Engine → client | `trace_id` and `span_id` on every `NormalizedEvent` of the run, carried onto every outbound frame (§ "Correlation-ID vocabulary") |
| Engine → extension | The hook envelope's `_ctx.traceId` and `_ctx.spanId` (the `extension.hook_latency` span for that call); on a schedule or webhook delivery, `engine/fire_async` `traceId` / `spanId` (the fire's root span) |
| Extension → engine | A prompt sent from a schedule or webhook handler carries the fire's `traceparent`; its `run.execute` joins under the fire's root span. Every other extension prompt starts a trace of its own |
| Engine → provider | `traceparent` header on every provider request (anthropic, openai-compatible, google, bedrock), parent `llm.call` |
| Engine → delegated CLI | `TRACEPARENT` in the process environment, parent `run.execute`. A per-run process (claude-code) gets the run's; a long-lived agent process (codex, cursor, grok) gets the trace of the run that first spawned it |
| Engine → MCP server | stdio: `TRACEPARENT` in the environment when the server is connected under a run; HTTP/SSE: a `traceparent` header on each request made under a run |

A dispatched child agent repeats the engine subtree: `dispatch.agent` is a child of the dispatching
run's `run.execute`, and the child's own `run.execute` is a child of `dispatch.agent`. A dispatch
that starts with no trace in flight (a background dispatch from an idle session) mints a trace of its
own, so `dispatch.agent` is then a root. A schedule or webhook fire also mints a trace with the fire
as its root span: the handler's envelope, the hooks the engine records around its calls, and the
prompts it sends all land in that trace.

### Span record shapes

A span is a log record whose `ts` is the span's END and whose top-level `trace_id` is its trace. Two
shapes carry one:

**Span log line** (a client of the engine that writes the schema). An operational line with `tag` = `span`:

```json
{"ts":"2026-09-23T10:00:01.250000000Z","level":"INFO","component":"cli","tag":"span","msg":"engine.send_prompt","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","conversation_id":"1780093348767-c1c03e998388","fields":{"span_id":"00f067aa0ba902b7","parent_span_id":"1111222233334444","duration_ms":12,"span_kind":"client","peer.service":"ion-engine","user":"local:user","accepted":true}}
```

- `msg` is the span name. `fields.span_id` (16 hex) and a numeric `fields.duration_ms` are required;
  `fields.parent_span_id` is absent on a root. `fields.span_kind` is `server`, `client`, or
  `internal` (the default). A non-empty `fields.error` marks the span failed; such a line is WARN.
- Every other `fields` key is a span attribute. `session_id` and `conversation_id` stay top-level
  and are not repeated in `fields`.
- A surface states the trace as a `trace_id` field; its logger lifts that to the top level. Any
  line may carry a `trace_id` this way.

**Telemetry span event** (engine). A `telemetry.jsonl` event whose `payload` holds `span_id` and
`duration_ms`. Its name is the span name: `run.execute`, `llm.call`, `llm.attempt`, `tool.execute`,
`mcp.call`, `permission.decide`, `hook.fanout`, `extension.hook_latency`, `dispatch.agent`,
`context.assemble`, `compaction`, `conversation.load`, `conversation.persist`, `command.dispatch`,
`session.start`, `daemon.startup`, `config.load`, `provider.probe`, `extension.spawn`, `mcp.start`
(the constant block in `engine/internal/telemetry/telemetry.go` is the by-name list). Its parent is
`context.parent_span_id`. `payload.span_kind` names the kind the same way `fields.span_kind` does:
`run.execute` and `command.dispatch` (a request another process made) are `server`; `llm.call`,
`llm.attempt`, and `mcp.call` (a call into another process) are `client`; the rest are internal. Every other payload key is a span
attribute, so the metrics-generator can split a histogram by `model`, `backend`, or `command`.

A client span names the service it calls in the `peer.service` attribute: `ion-engine` on
`engine.send_prompt` and `engine.request`.

### Export

With the `otel` egress target, each batch's span records are posted to `<endpoint>/v1/traces` as
OTLP/JSON after the batch's logs are accepted, with the same headers. The engine does it for the
files it ships (`engine/internal/utils/log_egress_traces.go`); a client that ships its own files
follows the same recognition rules and attribute mapping:

- The resource is the recording source's (§ "OTLP correlation model"); `service.name` is
  `ion-<component>`. Start is `ts` minus `duration_ms`, end is `ts`.
- `kind` comes from `span_kind`: `server` is 2, `client` is 3, anything else is internal (1).
- Attributes are the span's fields (minus `span_id`, `parent_span_id`, `duration_ms`, `span_kind`,
  `error`, and the fields the resource states: `host` and `install_id`), plus top-level `session_id` and `conversation_id`, plus the telemetry `context`'s
  `session_id`, `conversation_id`, and `run_id`.
- A failed span export is logged and never fails the batch: the logs already landed, and the span
  line itself stays findable by `trace_id`.

## OTLP correlation model

One emission serves every consumer. Each shipped log record and span carries the same identity, and
each backend reads the part it needs. The engine (`engine/internal/utils/log_egress_resource.go`) derives it by one rule, and a
client that ships its own records follows it.

### Resource: which service wrote it

A batch holds records from several sources, so the resource is built per record, and records group
into one `resourceLogs` / `resourceSpans` entry per distinct resource. A source's logs and spans
share one resource.

| Attribute | Value |
|---|---|
| `service.namespace` | `ion`, for every component |
| `service.name` | `ion-<component>`: `ion-engine`, `ion-extension`, and `ion-<component>` for a client's own component |
| `service.instance.id` | The host's `install_id` (`~/.ion/install_id`); on a telemetry event, the event's `install_id`; on a line a client ships for a device, that device's `fields.device_id` |
| `service.version` | The shipping process's build version; on a telemetry event, the event's `version`; on a line a client ships for a device, that device's `fields.app_version` |
| `host.name` | The OS host name without `.local`; on a telemetry event, the event's `host`; absent on a line that describes a device other than the host that shipped it |

The otel config's `resourceAttributes` are added to every resource and win over the derived values,
except `service.name`, which always names the source. `serviceName` names the exporter's
instrumentation scope. The engine's OTLP trace and metrics exports carry the same host identity
under their own `serviceName` (default `ion-engine`).

### Log record: which operation it belongs to

| OTLP LogRecord field | Value |
|---|---|
| `traceId` | The record's `trace_id`, when it is a valid W3C trace id |
| `spanId` | The span the record is about: a span line's `fields.span_id`, a span event's `payload.span_id`, otherwise a telemetry event's `context.parent_span_id`. Never set without `traceId` |
| `body` | The record itself: the operational JSONL line, or the telemetry event JSON |
| `attributes` | Operational line: `tag`, `session_id`, `conversation_id`, `user`, `event_id`, and every `fields` key. Telemetry event: `event.name`, `user`, `schema_version`, and the payload and context keys the local telemetry pipeline extracts (`model`, `run_cost_usd`, `context_session_id`, ...) |

The envelope states each fact once. No attribute repeats the trace (`traceId`), the span (`spanId`), the
component (`service.name`), the host (`host.name`), the install (`service.instance.id`), or the build
(`service.version`). A telemetry event is told from an operational line by `event.name`, the OTel
attribute naming an event; no `fields` key is dotted, so no operational line carries it.

### What each backend reads

| Backend | Service | Log to operation | Span tree |
|---|---|---|---|
| Application Insights (Azure Monitor OTLP ingestion: `OTelLogs`, `OTelSpans`) | `RoleName` from `service.namespace` + `service.name`; `RoleInstance` from `service.instance.id` | `OTelLogs.TraceId` / `SpanId` from the LogRecord fields | `OTelSpans.TraceId` / `SpanId` / `ParentSpanId`. `Kind` server spans are requests and client or internal spans are dependencies; the Application Map draws an edge from a client span to the server span it parents in another service |
| Tempo | `resource.service.name` | (Loki, below) | `traceId` / `spanId` / `parentSpanId`, `kind` |
| Loki | the `service_name` label | the `trace_id` and `span_id` structured metadata | (Tempo) |
| Grafana on Log Analytics (`IonLogs` / `IonTelemetry` / `IonSpans` views) | `ServiceName`, `RoleName`, `ServiceInstanceId` | `TraceId` / `SpanId` | `IonSpans` rows |

Azure's table columns are documented at
[OTelLogs](https://learn.microsoft.com/azure/azure-monitor/reference/tables/otellogs) and
[OTelSpans](https://learn.microsoft.com/azure/azure-monitor/reference/tables/otelspans). The role name
and instance mapping and the request/dependency split are documented at
[Configuring OpenTelemetry in Application Insights](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-configuration)
and [Add and modify OpenTelemetry](https://learn.microsoft.com/azure/azure-monitor/app/opentelemetry-add-modify).

---

## Names in Loki

A collector indexes every record under the names its OTLP form carries, so a query reads the same
names whether the record arrived from a local file or over OTLP. The local stack's Alloy config
(`alloy-config.alloy`) and telemetry forwarder produce exactly these, as does the fleet OTLP config in
[`central-log-collection.md`](../enterprise/central-log-collection.md#3-alloy--the-ingestion-endpoint);
the dashboards select on nothing else (`dashboards/test/stream-labels.test.ts`).

Six stream labels. All other fields stay in the log body or in structured metadata.

| Label | OTLP source | Local source | Rationale |
|---|---|---|---|
| `service_name` | `service.name` | `ion-` + the line's `component`; the forwarder's stream label for telemetry | The surface that wrote the record (`ion-engine`, `ion-extension`, or a client's own) |
| `event_name` | `event.name` | the telemetry event's `name` | Present only on telemetry events. A log selector says `event_name=""`; a telemetry selector names the event (`{event_name="run.complete"}`) or `event_name=~".+"` |
| `level` | `severityText` | `level` | Severity filtering without full-text scan. Operational lines only |
| `tag` | the `tag` attribute | `tag` | Subsystem and extension fan-out (`ext:my-agent`, `session`, ...) |
| `host_name` | `host.name` | top-level `host` (telemetry) or `fields.host` (operational), `.local` trimmed | The device: every dashboard's **Device** filter and every per-device chart |
| `user` | the `user` attribute | `user` | The signed-in operator: every dashboard's **User** filter |

Structured metadata, filtered without a parser (`| trace_id = "..."`):

| Key | OTLP source | Local source |
|---|---|---|
| `trace_id` | LogRecord `traceId` | top-level `trace_id` |
| `span_id` | LogRecord `spanId` | a span line's `fields.span_id`, else top-level `span_id`; a telemetry event's `payload.span_id`, else `context.parent_span_id` |
| `service_instance_id` | `service.instance.id` | a telemetry event's `install_id`; a device line's `fields.device_id` |
| `service_version` | `service.version` | a telemetry event's `version`; a device line's `fields.app_version` |

Telemetry events also carry the payload and context keys listed under § "Telemetry event fields" as
structured metadata. `host_name` and `user` are set on every pipeline by one Alloy stage,
`loki.process "ion_identity"`, so a line gets them whatever shape it arrived in. A line with neither
leaves them unset. They are the only identity labels: `machine_id` and the MDM ids are
one-per-install and stay in the body, where `| json` reads them. Three consequences to know:

- Every engine line carries `fields.host` in the local file, so a local stack labels its lines by device. A line written before the machine identity loads (the first lines of a boot) has none.
- `host`, `machine_id`, `mdm_device_id`, and `mdm_serial` belong to the logger. It stamps them over any caller field of the same name, and `make check-logging` (RESERVED-KEY) fails a call site that uses one: a URL's host logged as `host` would otherwise show up as a device. Name such a value for what it is (`url_host`, `git_host`, `bind_host`).
- A line a client ships for another device is labeled with the host that shipped it, not the device it describes.

`session_id` and `conversation_id` stay in the body and are queried with LogQL
`| json | session_id = "..."`. Promoting them to labels would create extreme label cardinality.

---

## Telemetry event fields (`telemetry.jsonl`)

Ion emits a separate telemetry stream to `~/.ion/telemetry.jsonl` when telemetry
is enabled. Schema v4 introduced the compact frame, one per JSONL line, and schema v5 (the current
version) keeps that layout: a frame interns shared identity and correlation data, then carries one
or more event records. v5 is the span set: every engine operation in § "Spans" is a span event.
The telemetry forwarder expands each frame before it sends events to Alloy.

### Compact frame (schema v4 and v5)

A frame line has this shape:

| Field | Type | Notes |
|---|---|---|
| `record` | string | Always `"telemetry.frame"`. Identifies a compact frame. |
| `schema` | int | The writer's schema: `5` today, `4` from a v4 engine. |
| `identities` | array | Interned source identities. Each entry has `component`, `install_id`, `host`, `version`, and optional `user`. |
| `contexts` | array | Interned optional correlation objects. Each entry has `context` and optional `trace_id`. |
| `events` | array | Event records. `i` indexes `identities`; optional `c` indexes `contexts`. |

Each event record contains `i`, optional `c`, `name`, `ts`, optional `event_id`,
and `payload`. The expanded event is the same public telemetry event shape that
earlier expanded-event schemas used: combine the indexed identity and context with the event
record, then set its `schema` to the frame's.

The compact file format is a storage format, not a dashboard contract. The
telemetry forwarder decodes every line at or below its own schema and posts expanded events to Alloy,
one stream per recording service (`service_name`). Alloy adds the `event_name` label and the
structured metadata in § "Names in Loki".

### Expanded telemetry event fields

After expansion, every event has these fields:

| Field | Type | Notes |
|---|---|---|
| `name` | string | Event kind, such as `run.complete` or `llm.call`. `payload.kind` is not used. |
| `ts` | string | RFC3339Nano UTC string. |
| `schema` | int | Schema version. An expanded event reports its frame's: `5` from the current engine. |
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

### `conversation.*` event family (issue #378)

> **Machine-readable contract:**
> [`conversation-events.schema.json`](conversation-events.schema.json) (JSON
> Schema 2020-12) is the artifact a downstream consumer validates ingestion
> against. The prose below supplements it; the schema document governs. Both
> are held to the emitter by tests that validate real emitted events against
> the committed schema.

A separate, standalone telemetry pipe from the general `telemetry.*` family
above — its own `ConversationEventsConfig` (config reference:
[`docs/enterprise/telemetry.md`](../enterprise/telemetry.md)), its own
`Collector` instance, and by default its own file
(`~/.ion/conversation-events.jsonl`), independent of `telemetry.jsonl` and
never gated on `telemetry.enabled`. This family is a **full-fidelity
security/audit stream**: raw user message text, raw assistant response text,
and raw tool input/output travel on it unconditionally — there is no
`privacyLevel` gate, because it never reads `PrivacyLevel()` at all.
`payload.cost`, when present, carries numeric token/USD figures.

An ID field omits its key entirely (`omitempty`) when the backend that served
the turn has no such ID, rather than emitting an empty string — a consumer can
distinguish "field never applicable to this backend" from "empty string was
the real value." `trace_id` and `parent_span_id` are the exception, and
deliberately diverge from the general log-line "omit when not in scope" rule
above: on this family they are always present, never omitted, even when
empty — a consumer relies on the key existing rather than testing for its
absence.

Every event may additionally carry `extension_metadata` — an object an
extension attached via the `before_conversation_event` hook
([`docs/hooks/reference.md`](../hooks/reference.md) § "Conversation Event
Metadata"), merged unmodified and uninterpreted by the engine. Absent when no
extension is registered or no handler returned anything.

The event `context` may carry `app_context` — the client's own
application-surface identity, supplied via `EngineConfig.appContext` (or
refreshed by any later addressed command carrying `appContext`) and stamped
by the engine without interpreting the keys. This is what makes several
parallel conversations distinguishable by the surface a human sees them in:
a tabbed client might send `{client, tab_id}`. A dispatched sub-agent reports its
parent session's value, since it runs inside the parent's surface and has
none of its own. Absent entirely for a consumer that supplies none, which is
every consumer that does not opt in.

**Ordering and segmentation.** Events of one conversation are ordered by
`ts` parsed as a timestamp, then by `payload.segment.part`. Never compare
`ts` as a string: RFC3339Nano trims trailing zeros, so `...06.5Z` sorts after
`...06.53Z` lexically. An event larger than its transport's maximum message
size (Event Hubs negotiates one per link) is delivered as several events that
share every envelope field including `event_id` and carry `payload.segment`
(`part`, `parts`, `field`, `total_bytes`, `sha256`); a consumer reassembles
by concatenating the field named by `field` across the parts in `part`
order. The deduplication key is `event_id`, or `(event_id, segment.part)` when
the block is present. See [`docs/enterprise/telemetry.md`](../enterprise/telemetry.md)
§ "Size contract".

**`conversation.user_message`** — emitted once per accepted, durably-persisted
user turn.

| Payload key | Type | Presence |
|---|---|---|
| `conversation_id` | string | Always |
| `entry_id` | string | Always (the persisted turn's entry id) |
| `run_id` | string | Always |
| `dispatch_id` | string | Present (non-empty) only for a dispatched-child run; omitted on the root path |
| `text` | string | The raw user message content. Omitted only if empty. |
| `extension_metadata` | object | See above. |

**`conversation.assistant_message`** — emitted once per completed assistant
message; never for a partial/aborted stream with no completed message.

| Payload key | Type | Presence |
|---|---|---|
| `conversation_id` | string | Always |
| `entry_id` | string | Omitted when the serving backend mints no persisted entry id at completion time (e.g. delegated-CLI backends) |
| `run_id` | string | Always |
| `dispatch_id` | string | Present only for a dispatched-child run |
| `model` | string | Always |
| `text` | string | The raw assistant response content. Omitted only if empty. |
| `cost` | object | Omitted entirely (not zeroed) when the backend cannot supply call-level billing (e.g. Claude Code, ACP) |
| `cost.input_tokens` | int | Present only when `cost` is present |
| `cost.output_tokens` | int | Present only when `cost` is present |
| `cost.cache_read_input_tokens` | int | Present only when `cost` is present |
| `cost.cache_creation_input_tokens` | int | Present only when `cost` is present |
| `cost.cost_usd` | float | Present only when `cost` is present; `0` for a subscription-metered backend (codex) — a known real value, distinct from an omitted `cost` object |
| `extension_metadata` | object | See above. |

**`conversation.tool_call`** — emitted once per terminal tool result,
including errors and policy denials. Never carries a `cost` object — a
tool-use turn's model cost stays on its `conversation.assistant_message`.

| Payload key | Type | Presence |
|---|---|---|
| `conversation_id` | string | Always |
| `entry_id` | string | Omitted (tool calls carry no tree-entry id) |
| `tool_use_id` | string | Always |
| `tool_name` | string | Always |
| `run_id` | string | Always |
| `dispatch_id` | string | Present only for a dispatched-child run |
| `outcome` | string | One of `success`, `error`, `denied`, `blocked` |
| `input` | object | The tool's decoded call arguments. Omitted when unavailable or unparseable — never fails the emission. |
| `output` | string | The raw tool result content. Omitted only if empty. |
| `extension_metadata` | object | See above. |

**`conversation.lifecycle`** — emitted for one of six frozen actions, only
after the underlying durable mutation succeeds (for `created`, `resumed`,
`compacted`, `cleared`, `deleted`); `detached` fires on successful live-session
removal, with no persistence check.

| Payload key | Type | Presence |
|---|---|---|
| `conversation_id` | string | Always |
| `action` | string | One of `created`, `resumed`, `compacted`, `cleared`, `detached`, `deleted` |
| `dispatch_id` | string | Present only for a dispatched-child conversation |
| `extension_metadata` | object | See above. |

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

Legacy expanded-event lines remain readable by the telemetry forwarder. This
allows one file to contain older expanded events and v4 compact frames during an
upgrade.

---

### engine (`component: "engine"`)

- Written by `utils.Log` / `utils.LogCtx` (Go, `log/slog` JSON handler).
- File: `~/.ion/engine.jsonl`, rename-rotate at a config-driven size cap (default 20 MB), default 3 generations (`.1`, `.2`, `.3`). Configurable via `LoggingConfig.MaxSizeMB` and `LoggingConfig.MaxFiles` in `engine.json`.
- `tag` = the logger tag string passed to `utils.Log(tag, msg)`.
- Context IDs injected automatically when `utils.LogCtx(ctx, ...)` is called.

#### Machine identity in `fields` (engine)

The engine logger stamps the following stable machine-identity fields onto every `engine.jsonl` line and, when egress is configured, every shipped record (`engine/internal/utils/log_identity.go`). The logger's value wins over a caller field of the same name. Absent keys mean the value is empty or the platform has no source for it. The install is not a field: a shipped record states it as its resource's `service.instance.id`.

| Field | Source | Notes |
|---|---|---|
| `host` | `os.Hostname()` | Always present. Matches the `host` field on telemetry events for the same machine — the Fleet board join key. Shipped as the resource's `host.name`, not as an attribute. |
| `machine_id` | `ioreg IOPlatformUUID` (macOS) / `/etc/machine-id` (Linux) | Stable **hardware** UUID independent of the username. Absent on platforms without a source. Distinct from the install — see the note below. |
| `mdm_device_id` | MDM config (`MDMDeviceID` key) | Present only on MDM-enrolled machines (e.g. Intune). Enables cross-reference to the MDM console. |
| `mdm_serial` | MDM config (`MDMSerialNumber` key) | Present only on MDM-enrolled machines. |

> **`machine_id` and the install are different identifiers.** `machine_id` is the stable **hardware** UUID (survives reinstalls, changes on new hardware). The install (`~/.ion/install_id`, shipped as `service.instance.id`) is the **per-install** anonymous UUID (changes on reinstall, the same value telemetry stamps). A consumer groups by hardware with `machine_id` and by install with `service.instance.id`.

Every egress record also carries a per-record `event_id` (16 hex chars, stamped at the enqueue chokepoint) for downstream dedup during retry storms — the same shape as the telemetry `event_id`. A record that already carries an `event_id` (e.g. a tailed telemetry event) keeps its own.

#### System Metrics sample (engine)

`tag=sysmetrics`, `msg="system metrics sample"`. One line per `systemMetrics.backgroundIntervalMs` (default 30 s) at INFO, or at ERROR with `msg="HIGH MEMORY"` when the Go heap is at or above 85% of the soft ceiling. Every other sample (a watcher asked for a faster interval) is logged at DEBUG. Every figure is a flat field under `fields` (LogQL: `fields_<name>`), so `unwrap` can chart it:

| Field | Unit | Meaning |
|---|---|---|
| `host_cpu_utilization` | 0..1 | Share of all host CPUs in use since the previous sample. Absent on the first sample |
| `host_cpu_count` / `host_effective_cpu_count` | CPUs | Logical CPUs / the container's CPU quota when one applies |
| `host_memory_total_bytes` / `host_memory_available_bytes` / `host_memory_limit_bytes` | bytes | Physical memory / available to new work / container limit (0 when none) |
| `host_container_limited` | bool | A cgroup limit narrowed CPU or memory |
| `host_load1` | load | One-minute load average. Absent on Windows |
| `host_disk_total_bytes` / `host_disk_free_bytes` | bytes | The volume holding `systemMetrics.diskPath` |
| `<role>_cpu_percent` | % of one core | Summed CPU of each process role: `engine`, `extension`, `mcp`, `backend`, `tool` |
| `<role>_rss_bytes` | bytes | Summed resident memory of each role |
| `process_count` | count | Processes in the engine's tree |
| `heap_bytes` / `sys_bytes` / `mem_limit_bytes` | bytes | Go heap in use / obtained from the OS / soft ceiling |
| `heap_mb` / `sys_mb` / `limit_mb` | MiB | The same three, as the earlier memory-monitor line wrote them |
| `goroutines` / `num_gc` / `sessions` | count | Goroutines, completed GC cycles, live sessions |
| `gc_pause_p99_ms` | ms | p99 of the Go runtime's stop-the-world pauses since the previous sample |
| `alloc_rate_bytes_per_s` | bytes/s | Heap bytes allocated per second since the previous sample |
| `sched_latency_p99_ms` | ms | p99 of goroutine scheduling latency since the previous sample |
| `interval_ms` / `sample_duration_ms` | ms | Sampling interval in effect / how long the sample took |

Each watch change logs `watcher set` / `watcher removed` (`connection_id`, `interval_ms`, `watchers`) and each cadence change `sampling interval changed`, at INFO.

### extension (`component: "extension"`)

- Emitted via JSON-RPC `log` notification from the SDK subprocess.
- `tag` MUST be the extension name (host fills this; extension code passes its own name).
- `session_id` and `conversation_id` are stamped by the host from the bound session context.
- `fields` map is preserved exactly as sent by the SDK — never concatenated into `msg`.

## Schema stability

This schema is a **published contract**. Additions are additive (new optional fields). Removals or renames
require an ADR. The `fields` object is intentionally open-ended so surfaces can emit rich structured context
without schema changes.

### Telemetry schema versioning

The telemetry stream (`telemetry.jsonl`) carries its own versioned schema separate from the operational log
schema. The current version is **schema v5** (`TelemetrySchemaVersion` in
`engine/internal/telemetry/schema.go` is authoritative). A v5 line is a compact frame in the v4 layout, and
its expanded events report schema `5`. What v5 added is the span events: `llm.attempt`, `mcp.call`,
`permission.decide`, `hook.fanout`, `context.assemble`, `conversation.load`, `conversation.persist`,
`command.dispatch`, `session.start`, `daemon.startup`, `config.load`, `provider.probe`, `extension.spawn`,
and `mcp.start`, each a telemetry span event (§ "Span record shapes"); `dispatch.agent` and `compaction`
became span events too, with `span_id` and `duration_ms` in their payloads. `system.metrics` gained
`gc_pause_p99_ms`, `alloc_rate_bytes_per_s`, and `sched_latency_p99_ms`. The frame layout and every
existing payload key are unchanged. The `~/.ion/telemetry.schema.json` sidecar's `highestSchemaSeen` field records
the maximum version ever written to the file. See the "Schema versioning and rotation" section above and ADR-019.
