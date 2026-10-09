# Ion dashboards on Azure Monitor

The dashboard suite has two flavors built from the same recipes. The local and
home stacks read Loki and Tempo. A hosted deployment whose logs land in Log
Analytics reads the Azure Monitor flavor: the same dashboards, folders, panels,
thresholds, links, and transformations, with every query in KQL.

There is no second copy of any query. `dashboards/src/generate-azure.ts` builds
each Loki dashboard exactly as `generate.ts` does, then compiles every LogQL
expression to KQL (`dashboards/src/kql/`). A recipe change reaches both flavors
in one edit. A LogQL construct the compiler does not know fails generation,
naming the dashboard and panel, so a panel is never dropped or emitted wrong.

## Render

```bash
cd docs/observability/dashboards
npm run generate:azure -- --target <config.json> --out <dir>
npm run generate:azure -- --target <config.json> --out <dir> --check   # drift gate
```

Output is one folder holding every dashboard: `<dir>/ion/ion-cost.json`,
`<dir>/ion/ion-overview.json`, and so on. The Loki flavor's pack folders do not
carry over. The generator owns that folder and removes a stale dashboard it no
longer builds. Dashboard uids are unchanged, so the cross-dashboard links (`/d/ion-cost`) keep working.

## The target config

Everything specific to one deployment lives in its own JSON file, kept in the
deployment's repository, not here:

```json
{
  "datasource": { "type": "grafana-azure-monitor-datasource", "uid": "<data source uid>" },
  "prometheus": { "type": "prometheus", "uid": "<Prometheus data source uid over the Azure Monitor workspace>" },
  "resources": ["/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<ws>"],
  "folder": "ion",
  "views": {
    "IonTelemetry": "<KQL that returns the telemetry view>",
    "IonLogs": "<KQL that returns the logs view>",
    "IonSpans": "<KQL that returns the spans view>"
  }
}
```

Every query starts with `let` bindings for the views it reads, taken from
`views`. When the pipeline's landing tables or columns change, edit `views` and
re-render. No query changes.

A PromQL target (the Ion Performance pack's span metrics and relay metrics, and
the System Metrics PromQL) is not compiled: the same expression runs against the
Azure Monitor workspace, so it is pointed at `prometheus` unchanged. Span metrics
reach the workspace from a Tempo or an OpenTelemetry Collector `spanmetrics`
connector that remote-writes to it; Application Insights computes request and
dependency durations from the same spans on its own.

## The view contract

Each view is a KQL tabular expression that returns these columns (schema version 3,
[`log-schema.md`](log-schema.md)). The OTLP envelope's fields keep their Azure Monitor column names,
so a view over `OTelLogs` or `OTelSpans` passes them through; Ion's own fields are snake_case. Empty
values read as `""`, the same as an absent Loki label.

| View | Columns |
|---|---|
| `IonTelemetry` | `TimeGenerated`, `event_name` (the `event.name` attribute, e.g. `run.complete`), `RoleName`, `ServiceName`, `ServiceInstanceId`, `ServiceVersion`, `host_name`, `user`, `TraceId`, `SpanId`, `schema`, `payload` (dynamic), `context` (dynamic), `body` (the event as a JSON string) |
| `IonLogs` | `TimeGenerated`, `level`, `RoleName`, `ServiceName`, `ServiceInstanceId`, `ServiceVersion`, `tag`, `msg`, `host_name`, `user`, `session_id`, `conversation_id`, `TraceId`, `SpanId`, `fields` (dynamic), `body` (the line as a JSON string) |
| `IonSpans` | `TimeGenerated`, `Name`, `TraceId`, `SpanId`, `ParentSpanId`, `DurationMs`, `RoleName`, `ServiceName`, `ServiceInstanceId`, `host_name`, `user`, `session_id`, `conversation_id`, `attributes` (dynamic) |

`host_name` is the resource's `host.name`, which already has `.local` trimmed. A telemetry event is a
record with an `event.name` attribute; an operational line has none, so the two views split
`OTelLogs` on it.

A LogQL name resolves to one of those columns or one bag key: `service_name` reads `ServiceName`,
`trace_id` reads `TraceId`, `service_instance_id` reads `ServiceInstanceId`, `payload_model` reads
`payload["model"]`, `context_extension` reads `context["extension"]`, `fields_rtt_p95_ms` reads
`fields["rtt_p95_ms"]`, and the Alloy structured-metadata names (`model`, `run_cost_usd`,
`cache_read_tokens`) read the payload key they were extracted from. A stream selector that names an
event (`event_name="run.complete"`, `event_name=~".+"`) reads `IonTelemetry`; any other reads
`IonLogs`, and its `event_name=""` matcher needs no filter there.

## How queries translate

| LogQL | KQL |
|---|---|
| Accumulation per `$__interval` on a series | `summarize … by bin(TimeGenerated, $__interval)` |
| Instant over `$__range` | `$__timeFilter(TimeGenerated)` |
| Instant over a fixed window `W` | the `W` before `$__timeTo()`, where Loki evaluates it |
| Rolling window `W` on a series | `bin(TimeGenerated, max_of(W, $__interval))`; counts and sums scale to `W`, so a point still reads "per `W`" |
| `sum by (x) (count_over_time(…))` and the other same-statistic pairs | one `summarize` over the matching lines |
| `A / B`, `A + B` between vectors | `join kind=inner` on the shared labels, real arithmetic |
| `> 3` against a vector | `where Value > 3` |
| `label_format x=`{{if .x}}…{{else}}F{{end}}`` | `extend x = iff(isempty(x), "F", x)` |
| `label_replace` | a conditional `extend` with `replace_regex` |
| `$host`, `$user` | `host_name in (…)`, `user in (…)`; All sends `__all__`, which also keeps lines with no identity |
| A regex textbox (`$model`) | `matches regex "^(?:…)$"`, anchored like a Loki matcher |

Series keep their Loki names: a table's value column is `Value` or `Value #A`, a
fixed legend names the value column, and a templated legend becomes a
per-query display name. Raw-row tables get the same flattened `labels` object
Loki hands them, so their `extractFields` transformations work unchanged.

## What does not carry over

- **The Tempo dispatch tree** (Ion Conversation Forensics). Grafana cannot draw a
  trace tree from Log Analytics rows. The panel lists the matching spans from
  `IonSpans`; open a `TraceId` in Application Insights (Transaction search) for
  the tree. Application Insights is the trace investigation surface in Azure, keyed by `TraceId`.
- **Explore correlations** (conversation id to logs, trace id to Tempo). These
  are Loki data source settings, not dashboard content. In Azure, filter by
  `conversation_id` or `session_id` with the dashboard variables, and search a
  `TraceId` in Application Insights (Transaction search) for its trace tree.
