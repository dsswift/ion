---
title: Performance
description: Running the perf harness locally, capturing a profile on each surface, reading the Performance dashboard, and comparing two commits.
sidebar_position: 10
---

# Performance

Latency in Ion is measured from spans: one W3C trace per prompt with a timed span at every hop
([log-schema § Spans](../observability/log-schema.md#spans)). Three tools read them:

| Tool | Answers | Where |
|---|---|---|
| Perf harness | Did this commit change a span's distribution, under a fixed load? | `make perf`, `make perf-compare`, nightly `Perf` workflow, results under `perf/results/` |
| Profiles | Where inside one process is the time going? | `ion debug profile`, the `profile.capture` developer surface, `RELAY_PPROF_LISTEN`, Instruments |
| Ion Performance dashboard | What are live users seeing, by backend, model, transport, client? | Grafana, from Tempo span metrics |

The harness runs nightly in `.github/workflows/perf.yml`, **outside the quality gate** and every
release path, and is report only: a `fail_on_regression` dispatch input exists and defaults off.
Nothing under `perf/` or `scripts/perf/` is referenced from `quality.yml`, `make test-linux`, or
a release workflow.

## Run the harness locally

```bash
make perf-build                          # engine/bin/ion and server/dist/main.js
make perf SCENARIO=smoke                 # writes perf/results/smoke/<sha>.json
make perf SCENARIO=soak ALLOY=http://localhost:4318
```

`make perf` starts an isolated Environment under `/tmp/ion-perf-<timestamp>`: its own
`ION_DATA_DIR`, an `engine.json` with the mock provider on (`providers.mock.enabled`, scripted by
the scenario's `provider` block: per-turn TTFT, token count, token rate, deterministic from
`seed`), telemetry to a file, and a `server.json` with the local listener only. It then drives the
scenario's `plan` over the Studio wire through the server's local socket (tabs, prompts with a
fresh `traceparent` each, body loads, snapshot polls), stops only the two processes it started,
reduces every span inside the window, and prints a table. Your own `~/.ion` is never touched.

With `ALLOY=` the engine ships the run's logs and spans to the local observability stack
(`logging.egressTargets: ["otel"]`), so the same run is visible in Tempo and on the dashboard.
Start the stack with `dev run` under the `observability` profile first. `scripts/perf/run.sh
--help`-style flags: `--scenario`, `--out`, `--alloy`, `--relay <url> --relay-psk <psk>` (the server
joins the relay; a client-side relay leg needs an OIDC bearer the harness has no issuer for, so it
is not driven), `--max-minutes` (default 20; the runner fails itself and records `timedOut`),
`--keep` (keeps the data dir for inspection).

Scenarios live in `scripts/perf/scenarios/`. `smoke` is the nightly default and finishes in a few
minutes on a hosted runner; `soak` is manual only and widens the window for distribution tails.
A new scenario is a new file there plus an entry in the workflow's `scenario` input.

## Compare two commits

```bash
make perf-compare A=perf/results/smoke/<old>.json B=perf/results/smoke/<new>.json
make perf-compare A=... B=... THRESHOLD=0.05 FAIL=1
```

The rule (effect on p50, Mann-Whitney U on the raw samples, `regressed` / `improved` /
`unchanged`) is documented in [`perf/results/README.md`](../../perf/results/README.md). Only
results from the same scenario and runner class are comparable; anything else is an observation.
The nightly job compares each run to the latest `main` result for the same scenario and writes the
table to the run summary. To measure an arbitrary commit, dispatch the workflow with `sha`; such a
run uploads its result as an artifact and does not record it on `main`.

Go micro-benchmarks are separate: `make bench` runs every `Benchmark*` under `engine/internal/`
six times into `engine/bench.txt`; `make bench-compare OLD=<file> NEW=<file>` runs `benchstat`
(installed into `GOBIN` when missing).

## Capture a profile

| Surface | How | Reference |
|---|---|---|
| Engine | `debug.pprof.listen` in `engine.json` opens Go's pprof endpoint on a loopback address; `ion debug profile --kind cpu\|heap\|goroutine --seconds N` writes a profile file to the data dir | `engine/AGENTS.md` |
| Server | The `profile.capture` developer surface (Settings, Developer) captures a CPU profile or heap snapshot of the server process into `<ION_DATA_DIR>/profiles/`; disabled for every connection by `customFields['ion-server'].developerSurfaces` | `packages/shared/src/developer-surfaces.ts` |
| Desktop | The same `profile.capture` surface on the Studio window captures the renderer; the main process via Electron's own `--inspect` | `desktop/AGENTS.md` |
| Relay | `RELAY_PPROF_LISTEN=127.0.0.1:6060` starts pprof; `go tool pprof http://127.0.0.1:6060/debug/pprof/profile` | `relay/pprof.go` |
| iOS | Instruments with the os_signpost template: every span the app logs is also a signpost interval, so `prompt.send` and the render spans appear as named intervals | `ios/IonRemote` `DiagnosticLog.logSpan` |

Profiles contain file paths and symbol names from the host; treat them as diagnostic artifacts,
not telemetry, and do not attach one to an issue without looking at it first.

## Read the Ion Performance dashboard

The dashboard is provisioned from `docs/observability/dashboards/` (`ion-performance.json`) and
reads Tempo's span metrics (`traces_spanmetrics_*`) from Prometheus:

- **Latency by span**: p50/p95/p99 per span name per service, split by `backend`, `model`,
  `transport`, `client_kind`. Percentiles come from the histogram, never from averaging.
- **Run duration beside cost per run**: a slower model is not a regression if cost moved with it.
- **Cold starts**: engine, server, Studio, iOS, and extension start spans.
- **Store, snapshot, render**: store action latency by action, snapshot and patch build, render and
  hydrate times.
- **Relay**: forward latency and round trip.
- **Runtime**: event-loop delay and GC pause for the server and Studio.

A panel that is empty for one service means that service shipped no spans in the range: check
its egress (`logging.egressTargets`) before reading it as "fast". Exemplars on the latency panels
link to the trace in Tempo. Alerts (p95 `action.handle` and `run.execute`, server event-loop p99,
host memory) are listed with the dashboard. Queries: [`docs/observability/queries.md`](../observability/queries.md).

## What a result is not

The harness drives a mock provider, so live-provider latency (`llm.call` against a real backend)
is never in a result; it is an observation from telemetry on the dashboard. A number is comparable
only with the same scenario, window, and recipe.
