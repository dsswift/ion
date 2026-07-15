# ADR-022: Dashboard time-window policy — panels honor the time picker

**Status:** Accepted
**Date:** 2026-07-12
**Authors:** Josh Sprague
**Amends:** [ADR-020](020-dashboards-as-code.md) (window guidance for the `instant` and rolling-count `windowed-stat` classes)

## Context

The story-pack dashboards shipped with fixed windows baked into most headline queries: the Ion Overview verdict row hardcoded `[1h]` for errors/warnings and `[24h]` for spend/runs, and the same pattern ran through the cost, extensions, quality, trust, live-logs, and intelligence packs (`[1h]`, `[24h]`, `[30d]`). Grafana's time-range selector changed only the panels that happened to carry no fixed window, so one picker adjustment moved some panels and left others frozen — an incoherent dashboard where "Errors" answered a different time question than the chart beside it.

The fixed-window rolling counts had a second, quieter defect: **undersampling at wide ranges**. A `[5m]` rolling count on a range panel is evaluated at the panel step; once the step exceeds the window (at a 30-day range the step is ~1296 s against a 300 s window), most entries fall *between* samples and the series silently reports a fraction of the real volume. That is the mirror image of the overcount bug ADR-020 eliminated — the same "window not bound to the step" root cause, in the other direction.

ADR-020 built the mechanism (query classes, class-enforcing builders, the structural audit) but left the window *policy* implicit: its `instant` class allowed "a fixed window (or `$__range`)" without saying which is the default, and its title-pinning rule legitimized "(5m)"/"(1m)" rolling counts that are now understood to undersample. Nothing stopped the next dashboard from hardcoding `[24h]` again.

## Decision

### 1. Default: every panel honors the dashboard time picker

- **Instant "window total" panels** (verdict stats, ranked bars, pies, snapshot tables) aggregate over **`[$__range]`**.
- **Series panels** (timeseries, heatmaps) accumulate per **`[$__interval]`**, so bars integrate to the same total the `$__range` headline reports at any picker setting.
- **Panel titles never carry a window suffix** for picker-honoring panels. "Errors (1h)" becomes "Errors"; the picker states the window.

### 2. Fixed windows are reserved for the detector classes

A fixed window is legitimate only when the window is part of the panel's *meaning*, not merely "the period being viewed":

| Detector class | Example | Why the window is fixed |
|---|---|---|
| Liveness lamps | Control-room `[5m]` / `[1m]` lamps | "Alive NOW" semantics; a `$__range` lamp would glow green from stale history when the operator widens the range |
| Freshness / last-seen detectors | Overview ingest freshness `[24h]`; Fleet host last-seen `[24h]` | Wide fixed net so a wedged tailer or quiet host stays visible as a growing value instead of dropping out of a narrow range |
| Latest-value panels | `last_over_time(...[10m])` context pressure / backpressure | The window is a staleness bound on "the current value", not an aggregation period |
| "Now" detectors | "Sessions thrashing now (5m)", "Dispatches in flight (5m)" | The window *is* the definition (3+ same-tool failures in 5 minutes); it is pinned in the title per ADR-020 |
| Statistical smoothing | `rate(...[1m])` volume, wire-latency `[1m]`/`[5m]` quantiles | An intensity/statistic over a rolling window, not a count; titles conventionally omit smoothing windows |

### 3. The decision rule for new panels

> If the window is part of the panel's **meaning**, it is fixed and (for rolling counts) pinned in the title. If the window is just **the period the operator is looking at**, it belongs to the picker: `$__range` on instant, `$__interval` on series.

ADR-020's builders enforce the mechanics (an accumulation cannot carry a fixed window on a range target; an instant accumulation cannot carry `$__interval`); this ADR is the policy layer that says which legitimate form to reach for.

### 4. Amendments to ADR-020 guidance

- The `instant` class guidance "evaluated once over a fixed window (or `$__range`)" tightens to: **`$__range` unless the panel is detector-class**.
- The title-pinned rolling-count allowance narrows to genuine now-detectors. The former "(5m)"/"(1m)" trend panels (errors-vs-warnings, error volume by component, live-logs volume panels) were converted to `$__interval` accumulations — a correctness fix for the undersampling defect above, not just UX. The `pinWindow` mechanism remains for the now-detectors that keep it.
- Dashboard **default** time ranges still express each pack's intent (`now-1h` for live, `now-24h` for cost, `now-30d` for intelligence); the default is a starting point, never a lock.

## Consequences

- One picker adjustment moves every non-detector panel coherently; the verdict row, the trends, and the drill-downs all answer the same time question.
- Wide-range trend charts now integrate to the headline totals (the undersampling defect is gone along with the overcount one).
- Generator tests pin the policy: converted verdict stats must query `[$__range]`, converted series must bind `[$__interval]`, no picker-honoring title may carry a window suffix, and each detector-class panel must keep its fixed window (`test/generator.test.ts`, "ADR-022" block).
- New dashboards (Ion Users, Ion Fleet) were authored under this policy from their first commit.

## Explicitly out of scope

- **Per-panel `timeFrom` overrides** (Grafana's panel-level time shift) — not used; the query window, not panel time overrides, is the mechanism of record here.
- **Re-litigating the class taxonomy** — ADR-020's classes, builders, and drift gates are unchanged; this ADR only fixes which windows the classes are used with.
