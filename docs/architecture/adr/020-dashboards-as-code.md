# ADR-020: Dashboards as code — canonical query module, generated dashboards, drift enforcement

**Status:** Accepted  
**Date:** 2026-07-08  
**Authors:** Josh Sprague  
**Amended by:** [ADR-022](022-dashboard-time-window-policy.md) — window policy defaults changed (instant panels default to `$__range`; the "(5m)"/"(1m)" rolling-count trend panels converted to `$__interval`). The class taxonomy, builders, and drift gates below are unchanged.

## Context

The Grafana observability stack ships twelve provisioned dashboards as hand-written JSON under `docs/observability/grafana/provisioning/dashboards/`. Every panel embeds a LogQL expression inline, and the same calculation — total spend, per-extension spend, run counts, log volumes, latency quantiles — was duplicated across dashboards with local variations. That duplication produced real, shipped defects:

- A `[30m]` fixed window on a **timeseries** (range) target. A `sum_over_time` on a range query re-sums the entire fixed window at every step, so a per-interval spend chart integrated to **$7.26K against a true 24h total of ~$255** — a ~30× overcount. The correct form binds the window to the panel step (`$__interval`) so each point sums only its own bucket.
- A spend pie missing the extension filter, and legend-template bugs, both from copy-paste drift between near-identical panels.

A post-fix audit of the packs that were **not** touched by the initial correction found **17 more fixed-window range expressions** across the remaining dashboards. Some were genuine members of the overcount class; others were legitimate windowed statistics (a p95 over a rolling 5-minute window is *supposed* to carry a fixed window). Nothing in the hand-written JSON distinguished the two: a `[5m]` that is correct and a `[24h]` that is a defect looked identical to a reviewer.

The root problem is that the calculation and its correctness rules lived nowhere. There was no single definition of "spend over 24h," no type that said "this expression is an accumulation and therefore must use `$__interval` on a range target," and no gate that could tell a legitimate rolling window from an overcount.

Grafana OSS offers no shareable calculation registry. The saved-query library is Grafana Enterprise-only and cannot be provisioned upstream; library panels share whole panels, not expressions. So the unification has to live in a generation layer above Grafana — the industry-standard posture for OSS Grafana at scale.

## Decision

Introduce a **dashboards-as-code** layer at `docs/observability/dashboards/` (TypeScript, zero runtime dependencies, Node native type-stripping). The committed dashboard JSONs remain the provisioned artifacts — no Grafana-side change, no new runtime — but they are now **generated** from typed source, and a CI gate regenerates and diffs them.

### 1. A canonical query module, typed by query class

Every LogQL expression is defined exactly once and declares a **query class** that encodes its correctness rule:

| Class | Calculation | Range-target rule |
|-------|-------------|-------------------|
| `accumulation` | `sum_over_time` / `count_over_time` — a running total or count | **MUST** use `$__interval`. A fixed window on a range target is the overcount bug. On an **instant** target a fixed window is correct and required. |
| `windowed-stat` | `quantile` / `avg` / `max` / `last_over_time`, and deliberately-rolling counts | A fixed rolling window is intrinsic to the calculation and is legitimate on any target. For rolling counts whose window is part of the panel's stated meaning (the "(5m)" / "(1m)" panels), the window is pinned in the panel title. |
| `instant` | ranked / pie / table snapshots | Evaluated once over a fixed window (or `$__range`). Never plotted as a per-step series. |

### 2. Class-enforcing panel builders — the overcount bug is unwritable

Panels are constructed through typed builders that know their evaluation mode. A range/series builder (`timeseries`, `heatmap`) **throws** if handed an `accumulation` target with a fixed window; the exact `[30m]`-in-timeseries defect cannot be constructed. The inverse is also enforced (an instant panel cannot use `$__interval`). Rolling-count windowed-stats that opt into title-pinning throw on title/window drift.

### 3. Dashboards are generated; a CI gate diffs them

`generate.ts` emits every dashboard JSON into the provisioning tree and regenerates `queries.md` from the query registry, so the reference doc cannot drift from the panels. `check.ts` regenerates to memory and **byte-diffs** against the committed files; any hand-edit or un-regenerated module change fails the build. The gate also walks emitted JSON and re-runs the overcount audit structurally (via an `__ionClass` stamp on every target), catching any raw-JSON escape hatch that bypassed the builders — belt-and-suspenders against the compile-time guard.

### 4. Toolchain: plain Node, zero runtime deps

Node is already a repository requirement (desktop, extensions). Node ≥ 22.6 strips TypeScript types natively and runs `node --test` directly on `.ts`, so the generator, checker, and contract tests need no build step and no dependency install. No Jsonnet/grafonnet, no new toolchain.

## Recording rules: explicitly NOT in the local stack

A tempting alternative is Loki recording rules (or a Mimir/Prometheus ruler) that precompute the aggregations so dashboards read cheap derived series. **This is rejected for the local deployment.**

The local stack treats Loki as a **disposable index**: the sanctioned `clear-observability-data` utility wipes Loki and Alloy's read positions, and on the next start Alloy re-tails every `~/.ion/*.jsonl` file from byte 0 and re-ingests the full history at original event-time (the R18 event-time model — `stage.timestamp` + `reject_old_samples = false`). This wipe-at-will / re-ingest property is load-bearing: the raw JSONL files are the source of truth and Loki is rebuildable from them at any time.

A ruler breaks that property. The ruler precomputes at evaluation time and **never backfills** — derived metrics produced before a wipe are gone and are not reconstructed from re-ingested source, and derived metrics for re-ingested historical windows are never produced at all (the ruler only evaluates forward from "now"). The derived series would silently diverge from the raw index the moment history is re-ingested. Raw LogQL over the disposable index has no such divergence: every query is computed from source on demand.

## The enterprise seam

The query module is structured so its calculations are portable across execution strategies. Each expression is a named, classed definition independent of how it is evaluated. A future **enterprise deployment** — where Loki is durable, not disposable, and the wipe/re-ingest property does not apply — MAY add an emitter that renders the same definitions as **Loki ruler YAML + PromQL dashboards**. That is a pure additive emitter over the existing registry: the calculations stay in the portable code layer, and only the execution target differs per deployment. Nothing in this ADR forecloses that; the registry shape is the seam that keeps it a pure addition rather than a rewrite.

## Consequences

- **Every committed dashboard is a generated artifact.** Editing a dashboard means editing `dashboards` and running `npm run generate`; hand-edits to the committed JSON fail `make check-dashboards`. This is documented in `docs/observability/README.md` and in a generated-file banner at the top of `queries.md`.
- **The overcount class of defect is eliminated by construction**, not by review vigilance. New panels cannot express it.
- **The 17-suspect audit is resolved by class, not case-by-case.** The genuine overcounts were fixed in migration (intelligence "Autonomy ratio trend" / "Thrash trend" `[1d]` → `$__interval`; errors-health "Top error sources (24h)" `[24h]` range → instant; live-logs "Extension log volume (1h)" `[1h]` → `$__interval`); the legitimate windowed statistics (wire-latency quantiles, errors-health/live-logs rolling counts) are now typed `windowed-stat` so the checker permits them and the builder pins their window in the title.
- **The gate runs in CI** (`quality.yml` `dashboards` job: `make check-dashboards` + `npm test`) and in the pre-push hook (change-scoped to `docs/observability/`).

## Explicitly out of scope

- **Loki recording rules / Mimir-Prometheus in the local compose stack** — rejected above (breaks wipe/re-ingest rebuildability; the ruler never backfills). The enterprise deployment revisits via the module's emitter seam.
- **Grafana Enterprise saved-query library** — unavailable in OSS, unprovisionable upstream.
