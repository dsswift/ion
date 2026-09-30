# Ion Observability Stack

A local, batteries-included observability stack for Ion: Grafana Alloy + Loki + Grafana OSS, with optional Tempo for trace correlation and Prometheus for metrics.

Start with [Signals and where they go](#signals-and-where-they-go): the one map of everything Ion emits, what turns each output on, where each kind of data is stored, and how the local stack lines up with Application Insights.

## Quick start

```
dev run
```

Or detached (returns immediately):

```
dev run -d
```

Open http://localhost:3000. Grafana opens with Ion data already flowing. No manual datasource setup, no dashboard import. Everything is pre-provisioned.

`dev run` is the single entry point for the stack. The `observability` profile is the default, so no profile argument is needed. The telemetry schema gate is removed: telemetry is version-forward, and the telemetry forwarder expands every record at or below its own schema before it reaches Alloy. Each expanded event carries `schema` in `structured_metadata`, so schema-filtered queries need no dashboard change.

> **Pinned versions are known-good.** Bump them only after running `docker compose pull` — not just `docker compose config`, which validates syntax but does not check whether the image tag actually exists on Docker Hub.

## Signals and where they go

This is the one map of what Ion emits. Every other observability and telemetry page links here rather than repeating it.

### Every output

| Output | Kind of data | Turned on by | Default | Format |
|---|---|---|---|---|
| Log files: `engine.jsonl`, `server.jsonl`, `desktop.jsonl`, `ios-diagnostic-logs.jsonl` | Logs | Always | On | JSONL, one line per event ([log-schema.md](log-schema.md)) |
| Log shipping | Logs | `logging.egressTargets` (`"http"`, `"otel"`) | Off | The same JSONL over HTTP, or OTLP log records to `logging.egressOtel.endpoint` + `/v1/logs` |
| Telemetry events | Events (runs, tools, providers, enforcement, `system.metrics`, …) | `telemetry.enabled` + `telemetry.targets` | Off | Schema-v4 JSONL frames (`file`, `stdout`, `http`, `eventhub`); optionally OTLP **traces** through the `otel` target, one zero-length span per event |
| Conversation events | Audit events (`conversation.*`) | `conversationEvents.targets` | Off | Metadata-only JSON; separate collector, separate seal |
| System Metrics | Metrics: host CPU, memory, load, disk; CPU and memory of every engine process by role; the Go runtime; the server's own process | Sampling: always (`systemMetrics.enabled`). Leaving the machine: `telemetry.enabled` (the `system.metrics` event) and `telemetry.otel.metrics.enabled` (OTLP **metrics**) | Sampled on; sent off the machine only when configured | `engine_system_metrics` on the engine wire to watchers; INFO sample lines in `engine.jsonl` / `server.jsonl`; `system.metrics` events; OTLP metrics |
| Device Metrics | Studio's own Electron processes: CPU, memory, GPU time; the idle-repaint warning | Always, in the desktop | On | INFO sample lines and WARN idle-repaint lines in `desktop.jsonl`. **Never leaves the device**: not sent to a server, a client, or any export |

System Metrics and Device Metrics are split on purpose. System Metrics describe an Environment (a server and its engine), so any client connected to it may watch them. Device Metrics describe the machine Studio runs on: when Studio on a laptop is connected to a remote server, the laptop's GPU load is still the laptop's, so it stays there.

### The three OpenTelemetry signals

OpenTelemetry (OTLP) carries three kinds of data, and each needs its own store:

- **Logs**: records you search. Ion sends them through log shipping (`logging.egressTargets: ["otel"]`).
- **Traces**: timed spans you follow across services. Ion sends its telemetry events as spans through the telemetry `otel` target.
- **Metrics**: numbers over time you chart and alert on. Ion sends System Metrics through `telemetry.otel.metrics`.

### The local stack and its Azure equivalent

| Job | Local stack (this directory) | Azure: Application Insights with OpenTelemetry support |
|---|---|---|
| Receive, check, forward | Alloy (and each store's own OTLP receiver) | An OpenTelemetry Collector |
| Store logs | Loki | Log Analytics workspace |
| Store traces | Tempo | Log Analytics workspace, shown through Application Insights |
| Store metrics | Prometheus | Azure Monitor workspace: a hosted Prometheus, queried with PromQL |
| Screens | Grafana | Application Insights, or Grafana |

Creating an Application Insights resource with **OTLP support** turned on creates and links both workspaces for you, and its Overview page lists one ingestion address per signal. The metrics address is on a different host from the logs and traces addresses, which is why `telemetry.otel.metrics.endpoint` exists. Application Insights requires delta temporality for metrics, and accepts only an app or workload identity, so Ion sends to a Collector that converts and signs in for it. The step-by-step guide is [Telemetry § Sending System Metrics to Application Insights](../enterprise/telemetry.md#sending-system-metrics-to-application-insights). Sources: [Ingest OTLP data into Azure Monitor with the OpenTelemetry Collector](https://learn.microsoft.com/en-us/azure/azure-monitor/containers/opentelemetry-protocol-ingestion), [Direct OpenTelemetry ingestion into Azure Monitor](https://techcommunity.microsoft.com/blog/azureobservabilityblog/direct-opentelemetry-ingestion-into-azure-monitor-is-now-generally-available/4524044).

### Grafana as the single pane of glass

Grafana reads from several stores at once, and one dashboard can mix them:

- **Locally:** the Loki data source (logs and telemetry events), Tempo (traces), and Prometheus (metrics), all provisioned in `grafana/provisioning/datasources/`.
- **On Azure:** the Azure Monitor data source reads Log Analytics with KQL, and a Prometheus data source reads the Azure Monitor workspace with PromQL. The PromQL in [queries.md](queries.md#system-metrics) runs unchanged against either Prometheus.

### Slicing by device and person

Every dashboard has a **Device** and a **User** dropdown. Alloy's `ion_identity` stage labels every line it ingests with `host_name` (the device) and `user` (the signed-in operator), and every query in every dashboard filters on both. The dashboard builder applies this centrally (`dashboards/src/dashboard.ts`), and a test fails if any query is left unscoped. **All** also matches lines with no identity, so nothing is hidden by default. The System Metrics dashboard draws one line per device.

A device ships to a hosted stack with log shipping (`logging.egressTargets: ["otel"]`, `logging.egressShipSources` listing what it sends) and `telemetry.enabled`. Every shipped record names its device and install in its OTLP resource (`host.name`, `service.instance.id`), and carries `machine_id`, and `user` when the device has a signed-in identity. See [consuming-logs.md](consuming-logs.md#option-3--programmable-egress-no-ion-provided-stack-required).

### Two ways to chart metrics

| | Charts from logs | Charts from OTLP metrics |
|---|---|---|
| Source | The INFO sample lines in `engine.jsonl`, `server.jsonl`, `desktop.jsonl` | `telemetry.otel.metrics` into a metrics store |
| Needs | Only the log pipeline Alloy already runs | Telemetry enabled, a metrics endpoint, a metrics store |
| Query | LogQL `unwrap` on flat numeric fields (`host_cpu_utilization`, `gpu_helper_gpu_percent`, …) | PromQL on `ion_host_cpu_utilization_ratio`, `ion_process_memory_rss_bytes`, … |
| Resolution | One sample per 30 s background interval; the faster samples are DEBUG and only present at debug level | The export interval (default 60 s) |
| Covers | Engine, server, **and Studio's Device Metrics** | Engine and host only (Device Metrics never leave the device) |
| Use when | A single machine, or telemetry is off | A fleet, alerting, long retention, or Application Insights |

The **System Metrics** dashboard (`dashboards/src/dashboards/system-metrics.ts`) charts from logs, so it works on any machine running this stack with no telemetry configured.

## What's running

| Service | Image | Port | Purpose |
|---|---|---|---|
| Grafana | `grafana/grafana:13.1.0` | 3000 | Dashboards and log explorer |
| Loki | `grafana/loki:3.7.3` | 3100 | Log storage and query backend |
| Alloy | `grafana/alloy:v1.17.1` | 12345, 4317/4318 | Log collection agent (HTTP UI); OTLP in, traces to Tempo |
| mount-refresher | `busybox:1.37.0` (built) | — | macOS bind-mount cache refresher (see § Tailer wedge) |
| telemetry-forwarder | Built from `engine/Dockerfile.telemetry-forwarder` | — | Expands telemetry records and sends events to Alloy |
| Tempo | `grafana/tempo:3.0.3` | none (3200 inside the network) | Trace storage and TraceQL metrics (optional, see [Tempo](#tempo-optional)) |
| Prometheus | `prom/prometheus:v3.14.0` | 9090 | Metrics storage: the engine's OTLP System Metrics, on its native OTLP receiver (see [Prometheus](#prometheus)) |
| Event Hub emulator | `mcr.microsoft.com/azure-messaging/eventhubs-emulator:latest` | 5672 (AMQP), 9092, 5300 (health) | Local Azure Event Hubs broker, for `conversationEvents.targets: ["eventhub"]` |
| azurite | `mcr.microsoft.com/azure-storage/azurite:latest` | 10000-10002 | Metadata/blob storage the Event Hub emulator requires |

> **Version pins:** The compose files are the source of truth. Update a pin only after the image pull succeeds.

## Local Event Hub emulator

Part of the default `observability` profile — `dev run` brings it up along with everything else, so `conversationEvents.targets: ["eventhub"]` can be exercised end to end with no extra command. See [`eventhub-emulator.md`](eventhub-emulator.md) for the connection string and the `conversationEvents` config block that points the engine at it. To see the stream consumed — captured to blob, indexed in Cosmos DB, reconstructed as a transcript, and folded to an archive — run [`samples/conversation-pipeline/`](../../samples/conversation-pipeline/README.md).


## Dashboard story-packs

Dashboards are organized into packs, each answering one question. The Ion Overview is the landing page with headline signals linking into the packs.

### The packs

| Pack | Dashboard | Question it answers | Data source |
|---|---|---|---|
| Overview | Ion Overview | Landing verdict: errors, cost, recent activity | engine.jsonl logs |
| Cost | Ion Cost | What is it costing me? Spend, runs, cache ratio, model breakdown | telemetry.jsonl (requires telemetry enabled — see below) |
| Extensions | Ion Extensions | Which extension is driving spend? Cost by extension and version, model mix, dispatch drill-down | telemetry.jsonl + a version reported at init handshake time (`extension.json` for TS extensions, an SDK build stamp for compiled ones) |
| Users | Ion Users | Who is using Ion and what is their footprint? Per-user spend, runs, tool failures, trust posture | telemetry.jsonl. The `user` field populates when the engine has an identity (enterprise OIDC); other traffic groups as "unassigned", splittable by install (`service_instance_id`) |
| Fleet | Ion Fleet | Who is running Ion, where, and on what version? Hosts, installs per host, engine/extension version drift, per-host spend and errors | telemetry.jsonl (`host`, `install_id`, `version` on every event, labeled `host_name`, `service_instance_id`, `service_version`) |
| Mobile | Ion Mobile | Which iOS devices are running Ion, on what app version, paired to which server? Per-device volume/errors, app-version drift, device→server pairing matrix, device last-seen | ios-diagnostic-logs.jsonl (`device_id`/`device_name`/`device_model`/`app_version`/`os_version`/`desktop_host` in `fields`). iOS emits no telemetry, so this reads the iOS log stream, not the telemetry stream |
| Explore Cookbook | Ion Explore Cookbook | Ad-hoc investigation recipes with dashboard variables for conversation_id / session_id / extension | telemetry.jsonl + engine.jsonl |
| Reliability | Ion Errors & Health | Is Ion healthy? Error rate, error sources, live error stream | engine.jsonl logs |
| Wire Latency | Ion Wire Latency | Is the Studio wire healthy? Round-trip and queue-wait quantiles per client | server.jsonl + each client's own log |
| Live | Ion Live Logs | What is Ion doing right now? Volume by component, live tail | engine.jsonl logs |
| Control Room | Ion Control Room | Is activity happening right now? Per-surface liveness lamps | engine.jsonl + telemetry.jsonl |
| Quality | Ion Quality | Is the agent doing good work? Tool failures, thrash, hook latency | telemetry.jsonl |
| Trust | Ion Trust | Can you trust the autonomy dial? Permission decisions, sandbox blocks, secret containment | telemetry.jsonl |
| Forensics | Ion Conversation Forensics | What happened in this specific conversation? | telemetry.jsonl + engine.jsonl |
| Intelligence | Ion Product Intelligence | What does 30 days of usage say about the product? | telemetry.jsonl |

Dashboards carry no text panels: the first row is data. Each panel's description (the info icon on its title) says what it shows and how to read it. The row structure is always verdict (stats) then evidence (timeseries/charts) then drill-down (logs/tables). Panels that bind to Phase-B telemetry events are provisioned with valid queries and stay data-empty until the instrumented engine ships.

### Dashboards as code

The committed dashboard JSONs under `grafana/provisioning/dashboards/` are **generated artifacts**. They are emitted from typed TypeScript source at `dashboards/`, where every LogQL expression is defined once in a canonical query module and composed into per-pack recipes. This is what eliminated the timeseries-overcount class of bug (a `[30m]` fixed window on a range chart that plotted ~30× the true total) — the query module types each expression by class (`accumulation` / `windowed-stat` / `instant`) and the panel builders refuse to construct an accumulation with a fixed window on a range target. See [`docs/architecture/adr/020-dashboards-as-code.md`](../architecture/adr/020-dashboards-as-code.md) for the full rationale, including why Loki recording rules are deliberately kept out of the local stack.

**Workflow — never hand-edit the committed JSON:**

```bash
cd docs/observability/dashboards
# edit the query module (src/queries*.ts) or a recipe (src/dashboards/*.ts)
npm run generate     # re-emit every dashboard JSON + queries.md
npm test             # contract tests (class enforcement, drift, overcount audit)
```

Then commit both the source change and the regenerated JSON. Zero dependencies — the generator and checker run on Node's native TypeScript type-stripping (Node ≥ 22.6), so there is no `npm install` step.

**The gate.** `make check-dashboards` regenerates in memory and byte-diffs against the committed files, and re-runs the overcount audit structurally on the emitted JSON. A hand-edit to a committed dashboard, or a query-module change that was not regenerated, fails the check. It runs in CI (the `dashboards` job in `quality.yml`) and in the pre-push hook (scoped to changes under `docs/observability/`).

**`queries.md` is generated** from the same query registry, so the reference doc cannot drift from what the dashboards actually run. Do not edit it by hand — edit the query module and regenerate.

**Time windows honor the dashboard picker.** Headline stats aggregate over `$__range` and series accumulate per `$__interval`, so every pack follows the Grafana time-range selector. Fixed windows survive only on the detector classes — liveness lamps, freshness/last-seen detectors, latest-value panels, and "now" detectors whose window is pinned in the panel title. The policy and the decision rule for new panels live in [ADR-022](../architecture/adr/022-dashboard-time-window-policy.md).

> **Provisioning pickup.** Generated JSONs are provisioned by Grafana on the `updateIntervalSeconds` poll (default 30 s) or on the next `docker compose -p ion-obs restart grafana`. After regenerating dashboards, restart Grafana once to pick them up (see "After stack changes, restart" below).

**Azure Monitor flavor.** A hosted deployment whose logs land in Log Analytics renders the same suite with every query compiled to KQL: `npm run generate:azure -- --target <config.json> --out <dir>`. The deployment's config maps its tables onto three views, so a schema change never touches a query. See [`azure-monitor.md`](azure-monitor.md).



### Extension attribution

The **Ion Extensions** dashboard uses `context_extension` and `context_extension_version` — structured-metadata fields promoted by Alloy from the `context.extension` and `context.extension_version` fields in the telemetry JSON.

The version's primary source is the extension's own init handshake with the engine; `extension.json` is a fallback, read at host load time before the subprocess reports its own value (`docs/extensions/extension-json.md` § `version`). For a TS extension, adding a `version` field to `extension.json` is enough:

```json
{ "name": "my-extension", "version": "1.2.0" }
```

A **compiled extension** (a Go SDK binary, for instance) has no `extension.json` for the engine to fall back to, so it must stamp its own version at build time and let the handshake carry it — `-X github.com/dsswift/ion/sdk/go.Version=<version>` alongside the existing `BuildIdentity` flag. See `sdk/go/build_identity.go` and the cos2 extension's Makefile for a worked example.

Old log lines without these fields are valid — they group as "unattributed" in the Extensions dashboard's extension-only panels. This is the first exercised additive evolution of the telemetry context under ADR-019: no schema bump, backward-compatible. The dashboard's version-comparison panels (cost per version, runs per version, the dispatch drill-down table) render an unattributed extension as "no extension" and an unversioned one as "unversioned", rather than a dangling "v" with nothing after it.

### Explore correlations

The Loki datasource has three provisioned correlations (defined in `grafana/provisioning/datasources/datasources.yaml`, picked up on Grafana startup):

| Correlation | Field | Behavior |
|---|---|---|
| All logs for conversation | `context_conversation_id` | Filters all log lines across components to this conversation |
| Session telemetry | `context_session_id` | Filters telemetry events to this engine session |
| View trace | `trace_id` | Jumps to the Tempo trace this line was logged in |

In any Explore result, click the link button on a log line's field value to follow the correlation. No manual configuration required — correlations are provisioned automatically on startup.

## Enabling telemetry

The Cost pack and the cost/run stat tiles on Ion Overview bind to `telemetry.jsonl`. This file only exists when telemetry is enabled in the engine config.

Add this to `~/.ion/engine.json`:

```json
{
  "telemetry": {
    "enabled": true
  }
}
```

When `targets` and `filePath` are omitted, the engine defaults to writing JSONL at `~/.ion/telemetry.jsonl` automatically. The three-field form below is equivalent and still accepted if you need to be explicit:

```json
{
  "telemetry": {
    "enabled": true,
    "targets": ["file"],
    "filePath": "~/.ion/telemetry.jsonl"
  }
}
```

The engine flushes buffered events to disk every 5 seconds by default. To change the cadence, set `flushIntervalMs`:

```json
{
  "telemetry": {
    "enabled": true,
    "flushIntervalMs": 10000
  }
}
```

This controls how frequently the file collector writes to disk during a live session. A lower value means the Cost dashboard reflects spend more quickly; a higher value reduces I/O. The default (5 s) provides near-real-time visibility without notable I/O overhead. Events are always flushed immediately on clean engine shutdown regardless of this setting.

Then restart the engine. The telemetry forwarder detects the live file and sends expanded events to Alloy.

The Cost pack panels show "No data" until telemetry is enabled. This is expected — the panels are correct, the data just isn't there yet.

### What telemetry.jsonl contains

One NDJSON line per compact frame. The telemetry forwarder expands each frame into events. All payload field names are **snake_case**. Three core event types:

| Event | When emitted | Key payload fields |
|---|---|---|
| `llm.call` | After each LLM turn completes | `model`, `turn`, `stop_reason`, `duration_ms`, `error` |
| `tool.execute` | After each tool call completes | `tool`, `duration_ms`, `error` |
| `run.complete` | Once per completed run | `model`, `run_cost_usd`, `aggregate_cost_usd`, `dispatch_depth`, `duration_ms`, `num_turns`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` |

All cost and token accounting happens at `run.complete`. The other two event types track latency.

**Runs on a CLI backend.** When a run goes to a delegated CLI (Claude Code, Codex, Grok, Cursor) instead of the engine's own model loop, the engine reports what the CLI shows it, and adds `backend` (the CLI kind) to each event so a chart can split CLI runs from engine runs:

| Event | claude-code | codex | grok, cursor |
|---|---|---|---|
| `tool.execute`, `tool.failure` | yes | yes | yes |
| `llm.call` (adds `output_tokens`, and `parent_tool_use_id` for a sub-agent's call) | yes | no | no |
| `provider.ttft` | yes, measured from when the CLI had everything for the call, so it includes CLI overhead | no | no |
| `context.pressure` | yes | yes | no |

A CLI tool span starts when the CLI reports the call and ends at its result; at `standard` privacy it carries no tool input, because the CLI streams the input in pieces. Codex reports each model call's token usage but not when the call starts, so it has no call timing. Grok and Cursor report tool calls only.

**Expanded event fields (all events; schema v4 frames expand to this shape — see `docs/observability/log-schema.md` for the normative table):**
- `ts` — RFC3339Nano UTC timestamp string (e.g. `"2025-07-06T15:04:05.123456789Z"`).
- `schema` — schema version integer. Self-describing for sinks.
- `component` — always `"engine"`.
- `install_id` — anonymous per-install UUID (stable across restarts, minted at `~/.ion/install_id`).
- `host` — machine hostname.
- `version` — engine build version string.
- `event_id` — per-event unique ID for downstream dedup.
- `user` — omit-when-absent; populated via the enterprise OIDC identity seam, absent on default installs.

**`run.complete` cost fields:**
- `run_cost_usd` — cost of this run only, excluding dispatched sub-agents. Canonical cost field for dashboard queries.
- `aggregate_cost_usd` — cost of this run plus all descendant sub-agent dispatches (the full conversation scope).
- `dispatch_depth` — nesting depth of the emitting run (`0` = root/orchestrator). Filter to `dispatch_depth=0` to sum `aggregate_cost_usd` without double-counting ancestor aggregates.

### Schema v4 compact frames

The telemetry file stores one schema-v4 compact frame per JSONL line. Frames intern
repeated identity and correlation values and contain one or more events. The
`telemetry-forwarder` decodes records at any schema at or below its own and posts the expanded events to
Alloy's `loki.source.api` listener. The label and structured-metadata names stay
the same, so dashboard behavior does not change.

The `~/.ion/telemetry.schema.json` sidecar records the monotonic
`highestSchemaSeen` value. A writer transition appends a
`telemetry.schema_writer_changed` event. Schema transitions do not rotate,
archive, or remove telemetry data. Size rotation creates `.1`, `.2`, and later
archives according to `maxFiles`; the local stack forwards the live file only.

## After stack changes, restart

```
docker compose -p ion-obs restart alloy grafana
```

Alloy and Grafana both read their config at startup. After editing `alloy-config.alloy` or any dashboard JSON file, restart both containers. Loki does not need restarting for those changes.

## Troubleshooting

### Tailer wedge (one component's logs stop while others keep flowing)

**Symptom.** One component (e.g. `engine`) stops appearing in Loki while `desktop`, `ios`, and telemetry keep advancing normally. No Alloy errors, no Loki rejections. The overview's **Ingest freshness by component** tile for the stalled component climbs into orange then red while the others stay near zero.

**Cause.** On macOS, Docker Desktop serves the `~/.ion` bind mount through a virtualized filesystem whose **attribute cache goes stale under sustained host-side writes** to a high-write-rate file. `engine.jsonl` is that file — it is written far faster than `desktop.jsonl` or the iOS log, which is why the engine tailer wedges while the others keep flowing. When the cache is stale, an in-container `stat` returns an old, smaller size than the host file, which is still growing on the same inode (`O_APPEND`). Alloy polls that size, sees no growth, and parks its cursor at an offset equal to the stale size. Because the stale size is never *smaller* than the stored offset, Alloy's truncation-reset (size < offset) never fires, so it neither advances nor resets — it simply waits for growth its cached view never shows. This is not an Alloy bug or a rotation failure. The mount cache reports a stale live-file size while the host continues to append data.

**The staleness is continuous, not one-shot.** This is the key correction to the earlier diagnosis. The stale view is not a single event that a one-time invalidation clears — it **re-forms within minutes** under the engine's continuous write rate. An Alloy restart (below) forces a fresh `open()` that clears it *once*, but the cache re-stales and the tailer wedges again shortly after. **The restart is a palliative, not a fix.**

**What actually refreshes the cache (proven live).** Every candidate operation was tested against a live wedged stack. A file read does **not** refresh the cache — `tail -c1`, `cat`, `head -c`, and a plain `stat` on the file all left the container's view frozen (`stat` is served from a TTL cache and only occasionally revalidates, so it is unreliable). The operation that reliably refreshes it is a **directory `readdir`** on the mount (`ls -1 /ion-logs`): it collapsed the stale gap to zero on every one of four consecutive re-stale cycles. This also explains why Alloy never self-heals — its `local.file_match` uses an explicit `path_targets` list (not a glob), so it only ever `stat`s the three target files and never `readdir`s `/ion-logs`, so it never triggers the refresh. A further test proved the stale cache is **shared at the Docker Desktop VM mount layer, not per-container**: a `readdir` from a *separate* container on the same bind mount collapsed Alloy's stale gap just as an in-Alloy `readdir` would.

**Fix (durable).** A tiny `mount-refresher` sidecar (`busybox`, built from `Dockerfile.mount-refresher`) mounts the same `~/.ion` bind mount read-only and runs `while true; do ls -1 /ion-logs >/dev/null; sleep 2; done`. Because the attribute cache is shared at the VM layer, the sidecar's `readdir` every 2 s keeps Alloy's view of `engine.jsonl` within a couple seconds of the host under active writes — well inside the freshness panel's 5-minute green threshold — without touching Alloy at all. The loop is baked into the image **CMD** rather than a compose `command:` override because the `dev.yaml` v4 executor silently drops any `command:`/`entrypoint:` field; baking it into the image lets `dev.yaml` and `docker-compose.yml` reference one identical artifact (the same pattern `Dockerfile.tempo` uses). The sidecar is defined in both compose sources and deploys automatically with the `observability` profile. Measured live: under continuous engine writes the host-vs-container size gap stayed bounded to one readdir interval of writes (0–28 KB, oscillating around zero) for 3.5+ minutes, versus the wedge's unbounded, frozen 12.8 MB gap; Alloy's cursor drained the full backlog and Loki freshness returned to **2 s** behind (green).

**Diagnosis.** Compare the offset Alloy stored against the *host* file size:

```
# host file size (bytes)
stat -f %z ~/.ion/engine.jsonl

# Alloy's stored offset for the same file
docker exec ion-obs-alloy cat /var/lib/alloy/data/loki.source.file.ion_jsonl/positions.yml
```

If the stored offset is far below the host size and the timeline in Loki stops at a fixed moment while other components keep arriving, the tailer is wedged. Confirm the stale view directly: `docker exec ion-obs-alloy stat -c 'size=%s' /ion-logs/engine.jsonl` will report the frozen (smaller) size, not the host size. (Positions for the structured-log pipeline live under `loki.source.file.ion_jsonl`. Telemetry is forwarded through Alloy's `loki.source.api` listener and has no Alloy file-tail position directory.)

**Restart (palliative — no longer the fix).** If the sidecar is not running (e.g. on an older stack), restarting Alloy clears the stale view *once*:

```
docker compose -p ion-obs restart alloy
```

It resumes from the stored offset (no data loss) and drains the backlog; because the pipeline stamps each line by event time (`ts`) not ingestion time, recovered lines land at their original timeline position. But it will re-wedge within minutes — deploy the `mount-refresher` sidecar for the durable fix.

**Why not a Docker Desktop setting (Option B, evaluated).** The operator's Docker Desktop already runs the VirtualizationFramework with VirtioFS enabled (`UseVirtualizationFramework: true`, `UseVirtualizationFrameworkVirtioFS: true` in `settings-store.json`). VirtioFS did **not** provide coherent attribute caching for this workload — the wedge reproduced with those settings already active — so there is no file-sharing toggle that fixes it. A machine setting would also not be repo-encoded; the sidecar is, so every dev gets the fix on `dev run` with no per-machine configuration.

**Enterprise-faithful escalation path (Option C, not built).** The fleet-host shape ships logs to Alloy over HTTP (a `loki.source.api` listener) rather than tailing bind-mounted files, which sidesteps the virtualized-mount cache entirely. This is the most production-faithful design but the largest change: a new Alloy listener, a desktop egress-forwarder target, and careful handling of the engine lines the desktop tailer already reads via its own native-host cursors (which are immune to this wedge). The sidecar durably solves local dev, so Option C is deliberately deferred. It is recorded here as the escalation path if the `readdir` refresher ever proves insufficient (e.g. a future Docker Desktop virtualization change that no longer honors `readdir`-triggered revalidation).

**Prevention.** The overview's per-component **Ingest freshness** tile (green < 5m / orange < 30m / red beyond) surfaces a wedged tailer as a red tile within minutes, so the wedge is caught by a glance at the landing dashboard rather than by noticing a component has gone quiet.

## Tempo (optional)

Tempo stores Ion's traces. One trace can cross processes: client, server, engine, and relay spans join on the W3C `traceparent` header, so a single trace shows a request from the app through the server and engine, and through the relay when a phone is involved. Phone spans do not ship on their own: they ride the server's pull of the phone's diagnostic logs.

Spans arrive over OTLP at Alloy on 4317 (gRPC) or 4318 (HTTP). Alloy forwards traces to Tempo (`otelcol.exporter.otlp "tempo"` in `alloy-config.alloy`). To send an engine's spans here, set `logging.egressOtel.endpoint` to `http://localhost:4318`. The engine posts a batch's logs before its spans, so Alloy accepts OTLP logs too and drops them: this stack already reads the log files from disk.

**Config.** `tempo-config.yaml` runs Tempo as one process with local disk storage under the `tempo-data` volume. `docker-compose.yml` mounts it; `dev.yaml` bakes it into an image with `Dockerfile.tempo`, because the `dev.yaml` executor drops `command:`. Change the image tag in both places together. The same config runs in the home-lab cluster.

**TraceQL metrics.** Queries like `{ } | rate() by (resource.service.name)` and Grafana's Traces Drilldown app work with no extra setup and no Prometheus. Tempo 3 answers them from its live-store (recent data) and its stored blocks. Tempo 2 needed the metrics-generator `local-blocks` processor for this; Tempo 3 removed it and will not start if a config still names it. Spans from the last 30 seconds are not in metrics results yet.

**Traces and logs link both ways.** In Grafana, a span's "Logs for this span" opens every log line whose JSON body has the same `trace_id`. A Loki line with a `trace_id` shows a "View trace in Tempo" link. Both are provisioned in `grafana/provisioning/datasources/datasources.yaml`.

If you don't need traces, comment out the `tempo` service in `docker-compose.yml` and `dev.yaml`, and the `otelcol.*` blocks in `alloy-config.alloy`.

## Prometheus

Prometheus stores the engine's OTLP System Metrics. It runs with `--web.enable-otlp-receiver`, so the engine writes to it directly; nothing is scraped. Point the engine at it:

```json
{
  "telemetry": {
    "enabled": true,
    "otel": {
      "metrics": { "enabled": true, "endpoint": "http://localhost:9090/api/v1/otlp/v1/metrics" }
    }
  }
}
```

Leave `temporality` at its default (`cumulative`): Prometheus stores cumulative series. OTel names become Prometheus names with the unit as a suffix: `ion.host.cpu.utilization` is `ion_host_cpu_utilization_ratio`, `ion.process.memory.rss` is `ion_process_memory_rss_bytes`. `prometheus.yml` promotes `service.name`, `service.instance.id`, and `host.name` to labels so a dashboard can split by machine.

## What Alloy collects

Alloy runs two separate pipelines:

**Structured log pipeline** (`ion_parse`) tails four explicit files:
- `~/.ion/engine.jsonl` — engine and extension logs
- `~/.ion/server.jsonl` — Ion Studio Server logs (`component=server`), and the browser-client lines it records for them (`component=web`)
- `~/.ion/desktop.jsonl` — desktop process logs
- `~/.ion/ios-diagnostic-logs.jsonl` — iOS client logs

Set `ION_LOGS_DIR` before `docker compose up` to point the mount at a data
directory other than `~/.ion` — a server started with its own `ION_DATA_DIR`
writes there, and this stack sees none of it otherwise.

It parses JSON and labels each line with the names its OTLP form carries (schema version 2, [`log-schema.md`](log-schema.md) § "Names in Loki"): `service_name` (`ion-` + the line's `component`), `level`, and `tag`. The `level` label carries the full five-level enum — `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` (TRACE and DEBUG appear only when a surface has them enabled; the default minimum is INFO). `trace_id` and `span_id` become structured metadata, filtered without a parser (`| trace_id = "..."`). `session_id`, `conversation_id`, and `msg` stay in the log body and are queried with `| json`. An operational line has no `event_name`, so a log query says `event_name=""` to leave telemetry out.

**Telemetry pipeline** (`ion_telemetry`) receives expanded events from `telemetry-forwarder`, which reads `~/.ion/telemetry.jsonl` and decodes records at any schema at or below its own. It promotes two labels:
- `service_name` — the service that recorded the event (`ion-engine`), set per stream by the telemetry forwarder
- `event_name` — the event name: `llm.call`, `tool.execute`, `run.complete`, `compaction`, and the additive instrumentation families (see [`consuming-logs.md`](consuming-logs.md)). Session/conversation lifecycle is `conversation.lifecycle` — one of the separate, standalone `conversation.*` family's event names (see [`log-schema.md`](log-schema.md) § "`conversation.*` event family"); this pipeline extracts its payload keys too when `conversationEvents`'s HTTP target is pointed at the same telemetry-forwarder.

All numeric and high-cardinality fields go into structured metadata (not labels): `model`, `run_cost_usd`, `duration_ms`, `num_turns`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `stop_reason`, `tool`, and the event's `trace_id`, `span_id`, `service_instance_id` (its install), and `service_version` (its build).

The two pipelines are separate. `telemetry.jsonl` is not processed by `ion_parse`, which prevents field misrouting. If the file does not exist, the telemetry forwarder stays idle and starts forwarding when the file appears.

## Local vs. hosted enterprise

The local stack is identical to a hosted deployment. The only difference is where Alloy ships logs:

- **Local**: Alloy pushes to `http://loki:3100` (the container in this compose)
- **Enterprise**: change the `loki.write` endpoint in `alloy-config.alloy` to your hosted Loki URL — labels, schema, and queries are identical

Metrics follow the same shape. Locally the engine writes OTLP metrics to Prometheus; hosted, it writes to an OpenTelemetry Collector that forwards them to the Application Insights metrics address, which stores them in the linked Azure Monitor workspace. The PromQL is the same against both.

Alloy is not the only downstream path. The engine can ship both streams itself, with no Alloy and no file tailing: operational logs via `logging.egressTargets` (`"http"` / `"otel"`) and telemetry via `telemetry.targets`. See [`consuming-logs.md`](consuming-logs.md) for the full consumer guide, including the egress reference, `jq` recipes, and retention/sizing guidance.

## LogQL cheat-sheet

**One conversation** — all log lines for a specific conversation:
```logql
{service_name=~".+", event_name=""} | json | conversation_id = "01932abc1234"
```

**One session** — all log lines for a session across all surfaces:
```logql
{service_name=~".+", event_name=""} | json | session_id = "01932abc1234"
```

**Errors in a time range** — use the Grafana time picker, then:
```logql
{level="ERROR"}
```
Or scoped to one component:
```logql
{service_name="ion-engine", level="ERROR"}
```

**One extension** — all logs from a specific extension:
```logql
{service_name="ion-extension", event_name="", tag="my-extension"}
```

**Trace correlation** — all logs sharing a trace_id found in Tempo:
```logql
{service_name=~".+", event_name=""} | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
```

### Telemetry LogQL

**All run.complete spans (last 24h)**:
```logql
{event_name="run.complete"}
```

**Runs by model**:
```logql
sum by (payload_model) (count_over_time({event_name="run.complete"}[24h]))
```

**Total cost last hour**:
```logql
sum(sum_over_time({event_name="run.complete"} | json | unwrap payload_run_cost_usd [1h]))
```

**Average run duration (ms)**:
```logql
avg(avg_over_time({event_name="run.complete"} | json | unwrap payload_duration_ms [24h]))
```

**Tool calls last hour**:
```logql
count_over_time({event_name="tool.execute"}[1h])
```

**Most-used tools (last 24h)**:
```logql
sum by (tool) (count_over_time({event_name="tool.execute"}[24h]))
```

## Stopping

```
docker compose -p ion-obs down
```

Data persists in named Docker volumes (`loki-data`, `grafana-data`, `tempo-data`).

## Wiping Loki state and re-ingesting

To reset Loki and Alloy state so all JSONL data re-ingests from scratch on the next stack start, use the sanctioned utility:

```
dev util clear-observability-data
```

This runs `docker compose -p ion-obs down -v`, which deletes `loki-data` and `alloy-data` (Alloy's tail read-positions). On the next observability-profile deploy (e.g. via `dev run` if observability is your default profile), Alloy re-tails every target file from byte 0 and pushes the full history into a clean Loki.

**What re-ingests:** Alloy tails `engine.jsonl`, `server.jsonl`, `desktop.jsonl`, and `ios-diagnostic-logs.jsonl`. The telemetry forwarder reads the live `telemetry.jsonl` and posts expanded events to Alloy.

**What does not re-ingest:** rotated `.1` archives and anything already truncated by `dev util clear-logs` (that content is gone).

**Event-time stamping (R18) makes re-ingest faithful to the original timeline.** Alloy uses `stage.timestamp` to index each event by its `ts` field rather than ingestion time, and Loki's `reject_old_samples` is disabled. Re-ingested events appear at their original timestamps in Grafana, not at the moment of re-ingest.
