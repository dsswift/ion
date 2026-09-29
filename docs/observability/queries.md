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

### Host CPU in use (from logs)

**Class:** `windowed-stat` &nbsp; **Window:** `5m`

Share of all host CPUs in use, averaged over the window, from the engine's 30 s INFO sample line (tag=sysmetrics). Works with telemetry off. Swap the field for any other flat sample field: `fields_host_memory_available_bytes`, `fields_host_disk_free_bytes`, `fields_<role>_cpu_percent`, `fields_<role>_rss_bytes`, `fields_heap_bytes`, `fields_goroutines`.

```logql
avg by (host_name) (avg_over_time({service_name="ion-engine", event_name=""} | json | tag="sysmetrics" | msg=~"system metrics sample|HIGH MEMORY" | fields_host_cpu_utilization != "" | unwrap fields_host_cpu_utilization [5m]))
```

### Studio GPU helper GPU (from logs)

**Class:** `windowed-stat` &nbsp; **Window:** `5m`

GPU time of Ion Studio's GPU helper as a share of wall time (100 = one GPU fully busy), from the desktop's Device Metrics sample line. macOS only; the field is absent, not zero, elsewhere.

```logql
avg by (host_name) (avg_over_time({service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="device metrics sample" | fields_gpu_helper_gpu_percent != "" | unwrap fields_gpu_helper_gpu_percent [5m]))
```

### Idle-repaint warnings (from logs)

**Class:** `accumulation` &nbsp; **Window:** `$__interval`

Count of `idle repaint detected` WARN lines: Studio's GPU helper or a renderer busy while no Studio window had focus or the machine was idle.

```logql
sum by (host_name) (count_over_time({service_name="ion-desktop", event_name=""} | json | tag="device-metrics" | msg="idle repaint detected" [$__interval]))
```

### Ingest freshness by component (minutes since last line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent log line per component. The tailer-wedge detector: a frozen Alloy cursor makes one component climb while the others stay near zero. Thresholded green <5m / orange <30m / red beyond on the overview. vector() uses the Grafana ${__to:date:seconds} macro (Loki vector() needs a bare literal); group_right keeps the per-component labels; the [24h] lookback keeps a wedged component visible as a growing red value rather than dropping it from a narrow window.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (service_name) (max_over_time({service_name=~".+", event_name=""} | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Distinct host_name count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `host_name` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (host_name) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Distinct service_version count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `service_version` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (service_version) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Distinct user count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `user` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (user) (count_over_time({event_name=~".+"} | json | label_format user=`{{if .user}}{{.user}}{{else}}unassigned{{end}}` [$__range])))
```

### Distinct iOS device_id count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `device_id` values seen in the iOS log stream over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the mobile "Devices reporting" and "App versions" headline stats.

```logql
count(sum by (device_id) (count_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" [$__range])))
```

### Total spend (bare run_cost_usd)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Sum of run_cost_usd across all run.complete events in the dashboard time range, instant. The cost pack headline and the extension coalesced sum reconcile to this value.

```logql
sum(sum_over_time({event_name="run.complete"} | json | unwrap run_cost_usd [$__range]))
```

### Spend by extension (ranked/pie)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost per extension over the dashboard time range, evaluated instant. Empty-extension runs coalesce to the "unattributed" bucket. The ranked bargauge and the pie share this one expression, so their totals reconcile to the headline spend by construction.

```logql
sum by (context_extension) (sum_over_time({event_name="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Spend by extension (ranked/pie)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost per extension over the dashboard time range, evaluated instant. Empty-extension runs coalesce to the "unattributed" bucket. The ranked bargauge and the pie share this one expression, so their totals reconcile to the headline spend by construction.

```logql
sum by (context_extension) (sum_over_time({event_name="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Per-extension model mix (spend)

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Cost grouped by extension AND model over the dashboard time range, instant. Shows which models each extension drives and how much each costs within that extension.

```logql
sum by (context_extension, model) (sum_over_time({event_name="run.complete"} | json | context_extension =~ "$extension" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__range]))
```

### Cost over time by extension (version legend, per interval)

**Class:** `accumulation` &nbsp; **Window:** `$__interval`

Run cost summed per $__interval, grouped by extension and version, with the empty extension coalesced to "unattributed" and a conditional " v<version>" suffix. Because the window is $__interval the area integrates to the same range total as the ranked bar.

```logql
label_replace(sum by (context_extension, context_extension_version) (sum_over_time({event_name="run.complete"} | json | context_extension =~ "$extension" | context_extension_version =~ "$version" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}` | unwrap run_cost_usd [$__interval])), "vsuffix", " v$1", "context_extension_version", "(.+)")
```

### Cost per version

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Total run.complete cost grouped by extension and version over the dashboard time range, instant. Compare spend before and after a version bump. Empty extension/version coalesce to "no extension"/"unversioned" so a compiled extension with no reported version is a legible bucket rather than a bare "v".

```logql
sum by (context_extension, context_extension_version) (sum_over_time({event_name="run.complete"} | json | context_extension =~ "$extension" | context_extension_version =~ "$version" | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}no extension{{end}}` | label_format context_extension_version=`{{if .context_extension_version}}{{.context_extension_version}}{{else}}unversioned{{end}}` | unwrap run_cost_usd [$__range]))
```

### Ingest freshness by component (minutes since last line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent log line per component. The tailer-wedge detector: a frozen Alloy cursor makes one component climb while the others stay near zero. Thresholded green <5m / orange <30m / red beyond on the overview. vector() uses the Grafana ${__to:date:seconds} macro (Loki vector() needs a bare literal); group_right keeps the per-component labels; the [24h] lookback keeps a wedged component visible as a growing red value rather than dropping it from a narrow window.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (service_name) (max_over_time({service_name=~".+", event_name=""} | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Distinct user count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `user` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (user) (count_over_time({event_name=~".+"} | json | label_format user=`{{if .user}}{{.user}}{{else}}unassigned{{end}}` | user=~"$user" | service_instance_id=~"$install" [$__range])))
```

### Distinct host_name count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `host_name` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (host_name) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Distinct service_instance_id count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `service_instance_id` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (service_instance_id) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Distinct service_version count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `service_version` values seen in telemetry over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users "Active users" headline stats.

```logql
count(sum by (service_version) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Host last-seen (minutes since last telemetry)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent telemetry event per host. The fleet liveness detector: a host whose engine stopped reporting climbs while the others stay near zero. Fixed [24h] lookback so a long-quiet host stays visible as a growing value rather than dropping out of a narrow dashboard range.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (host_name) (max_over_time({event_name=~".+"} | json | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### Installs per host

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Distinct service_instance_id count grouped by host. A host with more than one install is running several engine instances (e.g. headless daemons) side by side.

```logql
count by (host_name) (sum by (host_name, service_instance_id) (count_over_time({event_name=~".+"} | json [$__range])))
```

### Distinct iOS device_id count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `device_id` values seen in the iOS log stream over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the mobile "Devices reporting" and "App versions" headline stats.

```logql
count(sum by (device_id) (count_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" | device_model=~"$device" [$__range])))
```

### Distinct iOS app_version count

**Class:** `accumulation` &nbsp; **Window:** `$__range`

Number of distinct `app_version` values seen in the iOS log stream over the window. The inner sum collapses each value to one series; the outer count counts the series. Powers the mobile "Devices reporting" and "App versions" headline stats.

```logql
count(sum by (app_version) (count_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" | device_model=~"$device" [$__range])))
```

### iOS device last-seen (minutes since last log line)

**Class:** `instant` &nbsp; **Window:** `24h`

Minutes since the most recent iOS log line per device. The mobile liveness detector: a device whose logs stopped arriving climbs while the others stay near zero. Grouped by device_id (stable hardware identity) and device_model for display. Fixed [24h] lookback so a long-quiet device stays visible as a growing value rather than dropping out of a narrow dashboard range.

```logql
(vector(${__to:date:seconds}) - on() group_right() max by (device_id, device_model) (max_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" | device_model=~"$device" | label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [24h]))) / 60
```

### iOS app-version drift by device

**Class:** `instant` &nbsp; **Window:** `$__range`

Every device_id / device_model / app_version / os_version combination reporting in the iOS log stream over the window, with its line count. Two rows for one device_id means it upgraded the app (or OS) mid-window. Answers "which device is on which build?". mdm_device_id and mdm_serial appear when the device is enrolled in MDM, enabling cross-reference to Intune or other MDM consoles.

```logql
sum by (device_id, device_model, pairing_id, mdm_device_id, mdm_serial, app_version, app_build, os_version) (count_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" | device_model=~"$device" [$__range]))
```

### iOS device↔server pairing matrix

**Class:** `instant` &nbsp; **Window:** `$__range`

Every device_id / device_model × desktop_host pair that produced iOS log lines over the window, with the line count. A device paired to two servers yields two rows — this is the "which iOS device connected to which server, and generated logs there" view. pairing_id is the ECDH channel ID for the specific pairing session; device_id is the stable per-device hardware identity (survives re-pairings). desktop_host mirrors the telemetry `host` value, so a row cross-references the Ion Fleet board for the same machine. mdm_device_id / mdm_serial enable Intune correlation.

```logql
sum by (device_id, device_model, pairing_id, mdm_device_id, mdm_serial, desktop_host) (count_over_time({service_name="ion-ios", event_name=""} | json device_id="fields.device_id", device_model="fields.device_model", pairing_id="fields.pairing_id", desktop_host="fields.desktop_host", app_version="fields.app_version", app_build="fields.app_build", os_version="fields.os_version", mdm_device_id="fields.mdm_device_id", mdm_serial="fields.mdm_serial" | __error__="" | device_model=~"$device" [$__range]))
```

## System Metrics (PromQL)

For the OTLP metrics export (`telemetry.otel.metrics`), against the Prometheus data source. The same expressions run against the local Prometheus and an Azure Monitor workspace behind Application Insights. See [Signals and where they go](README.md#signals-and-where-they-go).

### Host CPU in use

Share of all host CPUs in use, per machine.

```promql
avg by (host_name) (ion_host_cpu_utilization_ratio)
```

### Host memory in use

Memory in use against the container limit, or physical memory when none applies.

```promql
1 - (ion_host_memory_available_bytes / ion_host_memory_limit_bytes)
```

### Disk free

Free space on the volume holding the engine's data.

```promql
ion_host_disk_free_bytes
```

### CPU cores by process role

Cores in use by each role of the engine's process tree.

```promql
sum by (role) (ion_process_cpu_utilization)
```

### Resident memory by process role

Resident memory of each role of the engine's process tree.

```promql
sum by (role) (ion_process_memory_rss_bytes)
```

### Engine heap and sessions

Go heap in use; `ion_engine_sessions` and `ion_engine_goroutines` sit beside it.

```promql
ion_engine_heap_bytes
```

### Samples observed per minute

How many System Metrics samples each export observed; zero means the engine stopped sampling.

```promql
rate(ion_system_metrics_samples_total[5m]) * 60
```
