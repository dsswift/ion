# Perf results

One JSON file per scenario per commit: `perf/results/<scenario>/<sha>.json`, written by
`scripts/perf/run.mts` (`make perf`) and recorded on `main` by the nightly `Perf` workflow
(`.github/workflows/perf.yml`). The workflow is report only and runs outside the quality
gate and every release path ([docs/contributing/performance.md](../../docs/contributing/performance.md)).

## File format (`schema: 1`)

| Field | Meaning |
|---|---|
| `scenario` | Scenario file name under `scripts/perf/scenarios/` (`smoke`, `soak`) |
| `sha`, `branch` | The commit measured |
| `startedAt`, `endedAt` | The exact window the plan ran in (ISO 8601). Only spans that END inside it count |
| `wallMs`, `timedOut` | Whole-run wall time, and whether the runner's `--max-minutes` cap fired |
| `runner` | `os`, `arch`, `cpus`, `node`, `go`: where the numbers came from; a result from another runner class is an observation, not a baseline |
| `plan` | The driver plan the scenario carried: tabs, prompts per tab, body loads, snapshot polls, pacing |
| `prompts` | `attempted`, `completed`, `failed` |
| `spans` | Keyed `<service>/<span name>` (`ion-engine/run.execute`, `ion-server/prompt.handle`). Each has `count`, `p50`, `p95`, `p99`, `max`, `mean`, and `samples` (the raw durations in ms, ascending, kept when `count <= 2000`) |

Percentiles are computed from the raw samples (linear interpolation, Hyndman-Fan type 7),
never by averaging other percentiles. Span sources and shapes:
[log-schema § Spans](../../docs/observability/log-schema.md#spans). The engine's spans come
from its telemetry stream, the server's from `tag=span` log lines; both are read from the run's
own data dir after the two processes exit, so every span is flushed.

## Comparison rule (`scripts/perf/compare.mts`)

For every span key present in both files, A the baseline and B the candidate:

1. The effect is the relative change of p50, `(p50_B - p50_A) / p50_A`. p95 and its delta are
   reported beside it.
2. When both files carry raw `samples`, a two-sided Mann-Whitney U test (normal approximation,
   tie-corrected) gives `p`.
3. Verdict: `regressed` when the effect is `>= threshold` (default 10%) and `p < 0.05`; `improved`
   when the effect is `<= -threshold` and `p < 0.05`; otherwise `unchanged`. Without raw samples
   on both sides there is no test, the threshold alone decides, and `p` is `n/a`.

The table lists regressions first. The exit code is 1 only with `--fail` and at least one
regression; the nightly workflow passes `--fail` only when dispatched with
`fail_on_regression`. A result is comparable only to another from the same scenario; the CLI
warns on a mismatch and still prints the table as an observation.

The 10% threshold is a starting value; hosted-runner noise is measured from the first runs on
`main` and the threshold tuned from them.
