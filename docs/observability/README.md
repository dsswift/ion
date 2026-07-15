# Ion Observability Stack

A local, batteries-included observability stack for Ion: Grafana Alloy + Loki + Grafana OSS, with optional Tempo for trace correlation.

## Quick start

```
dev run
```

Or detached (returns immediately):

```
dev run -d
```

Open http://localhost:3000. Grafana opens with Ion data already flowing. No manual datasource setup, no dashboard import. Everything is pre-provisioned.

`dev run` is the single entry point for the stack. The `observability` profile is the default, so no profile argument is needed. The telemetry schema gate has been removed (see ADR-019 § "Superseded mechanisms"): the engine's telemetry file is append-only and version-forward, so Loki data never needs auto-wiping on a schema transition. Each event line carries `schema` in `structured_metadata`, enabling schema-filtered queries without any pipeline changes.

> **Pinned versions are known-good.** Bump them only after running `docker compose pull` — not just `docker compose config`, which validates syntax but does not check whether the image tag actually exists on Docker Hub.

## What's running

| Service | Image | Port | Purpose |
|---|---|---|---|
| Grafana | `grafana/grafana:13.1.0` | 3000 | Dashboards and log explorer |
| Loki | `grafana/loki:3.7.3` | 3100 | Log storage and query backend |
| Alloy | `grafana/alloy:v1.17.1` | 12345 | Log collection agent (HTTP UI) |
| mount-refresher | `busybox:1.37.0` (built) | — | macOS bind-mount cache refresher (see § Tailer wedge) |
| Tempo | `grafana/tempo:2.10.7` | 4317/4318 | Trace storage (optional, see below) |

> **Version pins (2026-07-04):** Grafana 13.1.0 (11.x → 13.x bump, registry-verified push 2026-06-23, `sha256:121a7a9e...`) and Tempo 2.10.7 (`sha256:032b3acb...`) were pull-tested against the live stack before commit per the standing rule. Loki 3.7.3 and Alloy v1.17.1 were already latest and were not changed. Tempo 2.10.7 requires an explicit storage backend config (the `local` default was removed); `tempo-config.yaml` was added to the stack for this reason.

## Dashboard story-packs

Dashboards are organized into packs, each answering one question. The Ion Overview is the landing page with headline signals linking into the packs.

### The packs

| Pack | Dashboard | Question it answers | Data source |
|---|---|---|---|
| Overview | Ion Overview | Landing verdict: errors, cost, recent activity | engine.jsonl logs |
| Cost | Ion Cost | What is it costing me? Spend, runs, cache ratio, model breakdown | telemetry.jsonl (requires telemetry enabled — see below) |
| Extensions | Ion Extensions | Which extension is driving spend? Cost by extension and version, model mix, dispatch drill-down | telemetry.jsonl + `version` in extension.json |
| Users | Ion Users | Who is using Ion and what is their footprint? Per-user spend, runs, tool failures, trust posture | telemetry.jsonl. The `user` field populates when the engine has an identity (enterprise OIDC); other traffic groups as "unassigned", splittable by `install_id` |
| Fleet | Ion Fleet | Who is running Ion, where, and on what version? Hosts, installs per host, engine/extension version drift, per-host spend and errors | telemetry.jsonl (`host`, `install_id`, `version` on every event) |
| Explore Cookbook | Ion Explore Cookbook | Ad-hoc investigation recipes with dashboard variables for conversation_id / session_id / extension | telemetry.jsonl + engine.jsonl |
| Reliability | Ion Errors & Health | Is Ion healthy? Error rate, error sources, live error stream | engine.jsonl logs |
| Wire Latency | Ion Wire Latency | Is the desktop↔iOS wire healthy? Latency quantiles and drops | desktop.jsonl + ios-diagnostic-logs.jsonl |
| Live | Ion Live Logs | What is Ion doing right now? Volume by component, live tail | engine.jsonl logs |
| Control Room | Ion Control Room | Is activity happening right now? Per-surface liveness lamps | engine.jsonl + telemetry.jsonl |
| Quality | Ion Quality | Is the agent doing good work? Tool failures, thrash, hook latency | telemetry.jsonl |
| Trust | Ion Trust | Can you trust the autonomy dial? Permission decisions, sandbox blocks, secret containment | telemetry.jsonl |
| Forensics | Ion Conversation Forensics | What happened in this specific conversation? | telemetry.jsonl + engine.jsonl |
| Intelligence | Ion Product Intelligence | What does 30 days of usage say about the product? | telemetry.jsonl |

Every dashboard opens with a text panel stating the question it answers and how to read it. The row structure is always verdict (stats) then evidence (timeseries/charts) then drill-down (logs/tables). Panels that bind to Phase-B telemetry events (noted in each dashboard's intro text) are provisioned with valid queries and stay data-empty until the instrumented engine ships.

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



### Extension attribution

The **Ion Extensions** dashboard uses `context_extension` and `context_extension_version` — structured-metadata fields promoted by Alloy from the `context.extension` and `context.extension_version` fields in the telemetry JSON.

To enable attribution for your extension, add a `version` field to its `extension.json`:

```json
{ "name": "my-extension", "version": "1.2.0" }
```

Old log lines without these fields are valid — they group as "unattributed" in the Extensions dashboard. This is the first exercised additive evolution of the telemetry context under ADR-019: no schema bump, backward-compatible.

### Explore correlations

The Loki datasource has three provisioned correlations (defined in `grafana/provisioning/datasources/datasources.yaml`, picked up on Grafana startup):

| Correlation | Field | Behavior |
|---|---|---|
| All logs for conversation | `context_conversation_id` | Filters all log lines across components to this conversation |
| Session telemetry | `context_session_id` | Filters telemetry events to this engine session |
| View trace | `trace_id` | Jumps to the Tempo trace for this LLM call |

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

Then restart the engine and run:

```
docker compose restart alloy
```

The Cost pack panels show "No data" until telemetry is enabled. This is expected — the panels are correct, the data just isn't there yet.

### What telemetry.jsonl contains

One NDJSON line per event. All payload field names are **snake_case**. Three core event types:

| Event | When emitted | Key payload fields |
|---|---|---|
| `llm.call` | After each LLM turn completes | `model`, `turn`, `stop_reason`, `duration_ms`, `error` |
| `tool.execute` | After each tool call completes | `tool`, `duration_ms`, `error` |
| `run.complete` | Once per completed run | `model`, `run_cost_usd`, `aggregate_cost_usd`, `dispatch_depth`, `duration_ms`, `num_turns`, `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens` |

All cost and token accounting happens at `run.complete`. The other two event types track latency.

**Top-level fields (all events; current schema is v3 — see `docs/observability/log-schema.md` for the normative table):**
- `ts` — RFC3339Nano UTC timestamp string (e.g. `"2025-07-06T15:04:05.123456789Z"`).
- `schema` — schema version integer. Self-describing for sinks.
- `component` — always `"engine"`.
- `install_id` — anonymous per-install UUID (stable across restarts, minted at `~/.ion/install_id`).
- `host` — machine hostname.
- `version` — engine build version string.
- `event_id` — per-event unique ID (schema v3) for downstream dedup.
- `user` — omit-when-absent; populated via the enterprise OIDC identity seam, absent on default installs.

**`run.complete` cost fields:**
- `run_cost_usd` — cost of this run only, excluding dispatched sub-agents. Canonical cost field for dashboard queries.
- `aggregate_cost_usd` — cost of this run plus all descendant sub-agent dispatches (the full conversation scope).
- `dispatch_depth` — nesting depth of the emitting run (`0` = root/orchestrator). Filter to `dispatch_depth=0` to sum `aggregate_cost_usd` without double-counting ancestor aggregates.

### Schema versioning (version-forward)

The engine writes a `~/.ion/telemetry.schema.json` sidecar alongside `telemetry.jsonl`. The sidecar's
`highestSchemaSeen` field is a monotonic high-water mark — only raised, never lowered. On a version
transition the engine appends a `telemetry.schema_writer_changed` event so the transition is observable
in Loki. Files are never archived or wiped. Multi-schema files are handled by filtering on `schema_version`
in `structured_metadata`. See `docs/observability/log-schema.md` and ADR-019 for details.

## After stack changes, restart

```
docker compose -p ion-obs restart alloy grafana
```

Alloy and Grafana both read their config at startup. After editing `alloy-config.alloy` or any dashboard JSON file, restart both containers. Loki does not need restarting for those changes.

## Troubleshooting

### Tailer wedge (one component's logs stop while others keep flowing)

**Symptom.** One component (e.g. `engine`) stops appearing in Loki while `desktop`, `ios`, and telemetry keep advancing normally. No Alloy errors, no Loki rejections. The overview's **Ingest freshness by component** tile for the stalled component climbs into orange then red while the others stay near zero.

**Cause.** On macOS, Docker Desktop serves the `~/.ion` bind mount through a virtualized filesystem whose **attribute cache goes stale under sustained host-side writes** to a high-write-rate file. `engine.jsonl` is that file — it is written far faster than `desktop.jsonl` or the iOS log, which is why the engine tailer wedges while the others keep flowing. When the cache is stale, an in-container `stat` returns an old, smaller size than the host file, which is still growing on the same inode (`O_APPEND`). Alloy polls that size, sees no growth, and parks its cursor at an offset equal to the stale size. Because the stale size is never *smaller* than the stored offset, Alloy's truncation-reset (size < offset) never fires, so it neither advances nor resets — it simply waits for growth its cached view never shows. This is not an Alloy bug and not host-side log rotation: the engine rotates in place (truncate, never unlink/rename — see `engine/internal/utils/logger.go` `rotateInPlace`), so the inode is stable and there is no fd-to-deleted-inode swap.

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

If the stored offset is far below the host size and the timeline in Loki stops at a fixed moment while other components keep arriving, the tailer is wedged. Confirm the stale view directly: `docker exec ion-obs-alloy stat -c 'size=%s' /ion-logs/engine.jsonl` will report the frozen (smaller) size, not the host size. (Positions live under `loki.source.file.ion_jsonl` for the structured-log pipeline and `loki.source.file.telemetry_jsonl` for telemetry — these directory names match the `loki.source.file` block names in `alloy-config.alloy`.)

**Restart (palliative — no longer the fix).** If the sidecar is not running (e.g. on an older stack), restarting Alloy clears the stale view *once*:

```
docker compose -p ion-obs restart alloy
```

It resumes from the stored offset (no data loss) and drains the backlog; because the pipeline stamps each line by event time (`ts`) not ingestion time, recovered lines land at their original timeline position. But it will re-wedge within minutes — deploy the `mount-refresher` sidecar for the durable fix.

**Why not a Docker Desktop setting (Option B, evaluated).** The operator's Docker Desktop already runs the VirtualizationFramework with VirtioFS enabled (`UseVirtualizationFramework: true`, `UseVirtualizationFrameworkVirtioFS: true` in `settings-store.json`). VirtioFS did **not** provide coherent attribute caching for this workload — the wedge reproduced with those settings already active — so there is no file-sharing toggle that fixes it. A machine setting would also not be repo-encoded; the sidecar is, so every dev gets the fix on `dev run` with no per-machine configuration.

**Enterprise-faithful escalation path (Option C, not built).** The fleet-host shape ships logs to Alloy over HTTP (a `loki.source.api` listener) rather than tailing bind-mounted files, which sidesteps the virtualized-mount cache entirely. This is the most production-faithful design but the largest change: a new Alloy listener, a desktop egress-forwarder target, and careful handling of the engine lines the desktop tailer already reads via its own native-host cursors (which are immune to this wedge). The sidecar durably solves local dev, so Option C is deliberately deferred. It is recorded here as the escalation path if the `readdir` refresher ever proves insufficient (e.g. a future Docker Desktop virtualization change that no longer honors `readdir`-triggered revalidation).

**Prevention.** The overview's per-component **Ingest freshness** tile (green < 5m / orange < 30m / red beyond) surfaces a wedged tailer as a red tile within minutes, so the wedge is caught by a glance at the landing dashboard rather than by noticing a component has gone quiet.

## Tempo (optional)

Tempo is included for trace correlation via `trace_id`. It requires `tempo-config.yaml` (in this directory) which sets the local storage backend — Tempo 2.x no longer defaults to local storage, so this config must be present. If you don't need traces, comment out the `tempo` service block in `docker-compose.yml` and the `otelcol.*` blocks in `alloy-config.alloy`.

## What Alloy collects

Alloy runs two separate pipelines:

**Structured log pipeline** (`ion_parse`) tails three explicit files:
- `~/.ion/engine.jsonl` — engine and extension logs
- `~/.ion/desktop.jsonl` — desktop process logs
- `~/.ion/ios-diagnostic-logs.jsonl` — iOS client logs

It parses JSON and promotes three fields as Loki stream labels: `component`, `level`, `tag`. The `level` label carries the full five-level enum — `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR` (TRACE and DEBUG appear only when a surface has them enabled; the default minimum is INFO). All other fields — `session_id`, `conversation_id`, `trace_id`, `msg` — stay in the log body and are queried with `| json`.

**Telemetry pipeline** (`ion_telemetry`) tails `~/.ion/telemetry.jsonl` with its own dedicated pipeline. It promotes two labels:
- `service="ion-telemetry"` (constant, from the file match target)
- `kind` — the event name: `llm.call`, `tool.execute`, `run.complete`, `session.start`, `session.end`, `compaction`, `error`

All numeric and high-cardinality fields go into structured metadata (not labels): `model`, `cost_usd`, `duration_ms`, `num_turns`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `stop_reason`, `tool`.

The two pipelines are separate. `telemetry.jsonl` is not processed by the `ion_parse` pipeline, which prevents field misrouting. If `telemetry.jsonl` doesn't exist, the pipeline is silent — Alloy self-heals and starts collecting when the file appears.

## Local vs. hosted enterprise

The local stack is identical to a hosted deployment. The only difference is where Alloy ships logs:

- **Local**: Alloy pushes to `http://loki:3100` (the container in this compose)
- **Enterprise**: change the `loki.write` endpoint in `alloy-config.alloy` to your hosted Loki URL — labels, schema, and queries are identical

Alloy is not the only downstream path. The engine can ship both streams itself, with no Alloy and no file tailing: operational logs via `logging.egressTargets` (`"http"` / `"otel"`) and telemetry via `telemetry.targets`. See [`consuming-logs.md`](consuming-logs.md) for the full consumer guide, including the egress reference, `jq` recipes, and retention/sizing guidance.

## LogQL cheat-sheet

**One conversation** — all log lines for a specific conversation:
```logql
{component=~".+"} | json | conversation_id = "01932abc1234"
```

**One session** — all log lines for a session across all surfaces:
```logql
{component=~".+"} | json | session_id = "01932abc1234"
```

**Errors in a time range** — use the Grafana time picker, then:
```logql
{level="ERROR"}
```
Or scoped to one component:
```logql
{component="engine", level="ERROR"}
```

**One extension** — all logs from a specific extension:
```logql
{component="extension", tag="ion-meta"}
```

**Trace correlation** — all logs sharing a trace_id found in Tempo:
```logql
{component=~".+"} | json | trace_id = "4bf92f3577b34da6a3ce929d0e0e4736"
```

### Telemetry LogQL

**All run.complete spans (last 24h)**:
```logql
{service="ion-telemetry", kind="run.complete"}
```

**Runs by model**:
```logql
sum by (payload_model) (count_over_time({service="ion-telemetry", kind="run.complete"}[24h]))
```

**Total cost last hour**:
```logql
sum(sum_over_time({service="ion-telemetry", kind="run.complete"} | json | unwrap payload_costUsd [1h]))
```

**Average run duration (ms)**:
```logql
avg(avg_over_time({service="ion-telemetry", kind="run.complete"} | json | unwrap payload_durationMs [24h]))
```

**Tool calls last hour**:
```logql
count_over_time({service="ion-telemetry", kind="tool.execute"}[1h])
```

**Most-used tools (last 24h)**:
```logql
sum by (tool) (count_over_time({service="ion-telemetry", kind="tool.execute"}[24h]))
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

**What re-ingests:** the four live `~/.ion/*.jsonl` files Alloy targets — `engine.jsonl`, `desktop.jsonl`, `ios-diagnostic-logs.jsonl`, and `telemetry.jsonl`.

**What does not re-ingest:** `.bak` archives (telemetry schema rotation backups — outside Alloy's targets) and anything already truncated by `dev util clear-logs` (that content is gone).

**Event-time stamping (R18) makes re-ingest faithful to the original timeline.** Alloy uses `stage.timestamp` to index each event by its `ts` field rather than ingestion time, and Loki's `reject_old_samples` is disabled. Re-ingested events appear at their original timestamps in Grafana, not at the moment of re-ingest.
