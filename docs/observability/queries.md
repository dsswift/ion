# Ion Telemetry Query Reference

> **Generated file — do not edit by hand.** This document is emitted by `docs/observability/dashboards` (`npm run generate`). Every expression below is defined once in the canonical query module and shared by the dashboard panels, so the reference cannot drift from what the dashboards actually run. Edit the query module and regenerate; `make check-dashboards` fails on drift.

All queries are LogQL targeting the Loki datasource. Field names are snake_case structured-metadata keys promoted by Alloy from the NDJSON telemetry log. See [`log-schema.md`](log-schema.md) for the full field reference.

## Query classes

Every expression declares a query class. The class is what the panel builders enforce:

| Class | Meaning |
|-------|---------|
| `accumulation` | Accumulation (sum/count_over_time). On a timeseries the window is $__interval so the series integrates to the true range total; on a stat/pie it is a fixed window evaluated instant. |
| `windowed-stat` | Windowed statistic (quantile/avg/max/last_over_time or a deliberate rolling count). The fixed rolling window is intrinsic to the calculation and is pinned in the panel title. |
| `instant` | Instant snapshot (ranked/pie/table), evaluated once over a fixed window. |

## Canonical calculations

### Total spend (payload_run_cost_usd)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Sum of payload_run_cost_usd across all run.complete events in the dashboard time range, instant. Used by the overview verdict tile and the model pie.

```logql
sum(sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | unwrap payload_run_cost_usd [$__range]))
```

### Ingest freshness by component (minutes since last line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent log line per component. The tailer-wedge detector: a frozen Alloy cursor makes one component climb while the others stay near zero. Thresholded green <5m / orange <30m / red beyond on the overview. vector() uses the Grafana ${__to:date:seconds} macro (Loki vector() needs a bare literal); group_right keeps the per-component labels; the [24h] lookback keeps a wedged component visible as a growing red value rather than dropping it from a narrow window.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (component) (max_over_time({component=~".+"} | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Total spend (bare run_cost_usd)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Sum of run_cost_usd across all run.complete events in the dashboard time range, instant. The cost pack headline and the extension coalesced sum reconcile to this value.

```logql
sum(sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | unwrap run_cost_usd [$__range]))
```

### Spend by extension (ranked/pie)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost per extension over the dashboard time range, evaluated instant. Empty-extension runs coalesce to the "unattributed" bucket. The ranked bargauge and the pie share this one expression, so their totals reconcile to the headline spend by construction.

```logql
sum by (context_extension) (sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Spend by extension (ranked/pie)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost per extension over the dashboard time range, evaluated instant. Empty-extension runs coalesce to the "unattributed" bucket. The ranked bargauge and the pie share this one expression, so their totals reconcile to the headline spend by construction.

```logql
sum by (context_extension) (sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Per-extension model mix (spend)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Cost grouped by extension AND model over the dashboard time range, instant. Shows which models each extension drives and how much each costs within that extension.

```logql
sum by (context_extension, model) (sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Cost over time by extension (version legend, per interval)

**Class:** `accumulation` &nbsp; **Window:** `$__interval`

Run cost summed per $__interval, grouped by extension and version, with the empty extension coalesced to "unattributed" and a conditional " v<version>" suffix. Because the window is $__interval the area integrates to the same range total as the ranked bar.

```logql
label_replace(sum by (context_extension, context_extension_version) (sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension" | context_extension_version =~ "$version" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__interval])), "vsuffix", " v$1", "context_extension_version", "(.+)")
```

### Cost per version

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost grouped by extension and version over the dashboard time range, instant. Compare spend before and after a version bump.

```logql
sum by (context_extension, context_extension_version) (sum_over_time({service_name="ion-telemetry", kind="run.complete"} | json | context_extension =~ "$extension" | context_extension_version =~ "$version" | unwrap run_cost_usd [$__range]))
```

### Ingest freshness by component (minutes since last line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent log line per component. The tailer-wedge detector: a frozen Alloy cursor makes one component climb while the others stay near zero. Thresholded green <5m / orange <30m / red beyond on the overview. vector() uses the Grafana ${__to:date:seconds} macro (Loki vector() needs a bare literal); group_right keeps the per-component labels; the [24h] lookback keeps a wedged component visible as a growing red value rather than dropping it from a narrow window.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (component) (max_over_time({component=~".+"} | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Distinct user count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `user` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (user) (count_over_time({service_name="ion-telemetry"} | json | label_format user=`{{if .user}}{{.user}}{{else}}unassigned{{end}}` | user=~"$user" | install_id=~"$install" [$__range])))
```

### Distinct host count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `host` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (host) (count_over_time({service_name="ion-telemetry"} | json | host=~"$host" [$__range])))
```

### Distinct install_id count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `install_id` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (install_id) (count_over_time({service_name="ion-telemetry"} | json | host=~"$host" [$__range])))
```

### Distinct version count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `version` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (version) (count_over_time({service_name="ion-telemetry"} | json | host=~"$host" [$__range])))
```

### Host last-seen (minutes since last telemetry)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent telemetry event per host. The fleet liveness detector: a host whose engine stopped reporting climbs while the others stay near zero. Fixed [24h] lookback so a long-quiet host stays visible as a growing value rather than dropping out of a narrow dashboard range.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (host) (max_over_time({service_name="ion-telemetry"} | json | host=~"$host" | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Installs per host

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Distinct install_id count grouped by host. A host with more than one install is running several engine instances (e.g. headless daemons) side by side.

```logql
count by (host) (sum by (host, install_id) (count_over_time({service_name="ion-telemetry"} | json | host=~"$host" [$__range])))
```

### Distinct iOS device_id count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `device_id` values seen in the iOS log stream over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the mobile "Devices reporting" and "App versions" headline stats.

```logql
count(sum by (device_id) (count_over_time({component="ios"} | json device_name="fields.device_name", device_id="fields.device_id", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", desktop_host="fields.desktop_host" | __error__="" | device_name=~"$device" [$__range])))
```

### Distinct iOS app_version count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `app_version` values seen in the iOS log stream over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the mobile "Devices reporting" and "App versions" headline stats.

```logql
count(sum by (app_version) (count_over_time({component="ios"} | json device_name="fields.device_name", device_id="fields.device_id", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", desktop_host="fields.desktop_host" | __error__="" | device_name=~"$device" [$__range])))
```

### iOS device last-seen (minutes since last log line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent iOS log line per device. The mobile liveness detector: a device whose logs stopped arriving climbs while the others stay near zero. Fixed [24h] lookback so a long-quiet device stays visible as a growing value rather than dropping out of a narrow dashboard range.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (device_name) (max_over_time({component="ios"} | json device_name="fields.device_name", device_id="fields.device_id", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", desktop_host="fields.desktop_host" | __error__="" | device_name=~"$device" | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### iOS app-version drift by device

**Class:** `instant` &nbsp; **Window:** `$__range`

Every device_id / device_name / app_version / os_version combination reporting in the iOS log stream over the window, with its line count. Two rows for one device_id means it upgraded the app (or OS) mid-window. Answers "which device is on which build?".

```logql
sum by (device_id, device_name, app_version, app_build, os_version) (count_over_time({component="ios"} | json device_name="fields.device_name", device_id="fields.device_id", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", desktop_host="fields.desktop_host" | __error__="" | device_name=~"$device" [$__range]))
```

### iOS device↔desktop pairing matrix

**Class:** `instant` &nbsp; **Window:** `$__range`

Every device_id / device_name × desktop_host pair that produced iOS log lines over the window, with the line count. A device paired to two desktops yields two rows — this is the "which iOS device connected to which desktop, and generated logs there" view. desktop_host mirrors the telemetry `host` value, so a row cross-references the Ion Fleet board for the same machine.

```logql
sum by (device_id, device_name, desktop_host) (count_over_time({component="ios"} | json device_name="fields.device_name", device_id="fields.device_id", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", desktop_host="fields.desktop_host" | __error__="" | device_name=~"$device" [$__range]))
```
