// Recipe: Ion Overview (uid ion-overview).
//
// The landing dashboard — headline signals with links into the packs, plus the
// firing-alert stream (see alerting/ for the rule definitions). 2026-09-28
// operator direction (docs/observability/dashboards/AGENTS.md history): no raw
// dollar figure here (cost is a downstream effect of usage, not an operational
// signal — it stays in the Cost pack); no raw-JSON log panels (a table with
// useful columns replaces them, full payload on demand); the log-volume chart
// is condensed; and a cross-pack signal row pulls one live, high-value stat
// from each granular pack instead of leaving the operator to click through
// blind. Anomalies (cost spikes, runaway usage) are alert rules now, not
// numbers an operator has to notice themselves — this dashboard surfaces the
// firing count/stream via Grafana's native alertlist panel.
//
// Note the "Runs" and "Errors"/"Warnings" verdict tiles use the payload_-
// prefixed and bare fields respectively as inherited from the original
// migration; see queries-cost.ts's note on the field split.

import type { Dashboard } from '../dashboard.ts';
import { text, stat, timeseries, logsTable, escapeHatch } from '../panels.ts';
import { stream } from '../queries.ts';
import { runCount } from '../queries-cost.ts';
import { levelCount, logRateByComponent, ingestFreshnessMinutes } from '../queries-logs.ts';
import { distinctLabelCount, HOST_PIPE, USER_COUNT_PIPE } from '../queries-fleet.ts';
import { activeExtensionCount } from '../queries-logs.ts';
import { distinctDeviceField } from '../queries-mobile.ts';
import { accumulation, telemetry } from '../queries.ts';

const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const packLink = (title: string, url: string) => [{ title, url, targetBlank: false }];
const PERM = telemetry('permission.decision');

const INTRO =
  '## Ion Observability Overview\n\nThe landing dashboard. **Verdict row**: headline signals over the dashboard time range, plus the count of critical alerts currently firing — click through for the list. **Signal row**: one live figure pulled from each granular pack. Green = healthy. Any orange, red, or a firing alert — click through to the relevant pack.\n\n| Pack | Question | Dashboard |\n|---|---|---|\n| Cost | What is it costing me? | [Ion Cost](/d/ion-cost) |\n| Reliability | Is Ion healthy? | [Ion Errors & Health](/d/ion-errors-health) |\n| Live | What is Ion doing right now? | [Ion Live Logs](/d/ion-logs) |\n| Fleet | Who is running Ion, where, on what version? | [Ion Fleet](/d/ion-fleet) |\n| Users | Who is using Ion and what is their footprint? | [Ion Users](/d/ion-users) |\n| Trust | Can you trust the autonomy dial? | [Ion Trust](/d/ion-trust) |\n| Quality | Is the agent actually doing good work? | [Ion Quality](/d/ion-quality) |\n| Extensions | What is extension spend and activity? | [Ion Extensions](/d/ion-extensions) |\n| Mobile | Which iOS devices are running Ion? | [Ion Mobile](/d/ion-mobile) |';

export function overviewDashboard(): Dashboard {
  const panels = [
    text(1, { h: 4, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Errors',
      gridPos: { h: 4, w: 4, x: 0, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 1 },
            { color: 'red', value: 10 },
          ]),
          mappings: [],
          links: packLink('Errors and Health', '/d/ion-errors-health'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('ERROR', '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Warnings',
      gridPos: { h: 4, w: 4, x: 4, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 5 },
            { color: 'orange', value: 20 },
          ]),
          mappings: [],
          links: packLink('Errors and Health', '/d/ion-errors-health'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: levelCount('WARN', '$__range') }],
    }),
    stat({
      id: 5,
      title: 'Runs',
      gridPos: { h: 4, w: 4, x: 8, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'fixed', fixedColor: 'blue' },
          thresholds: fixed(),
          mappings: [],
          links: packLink('Ion Cost Dashboard', '/d/ion-cost'),
          noValue: 'telemetry off',
        },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: runCount() }],
    }),
    // Grafana's native alert-list panel — no LogQL target, no `-- Grafana --`
    // datasource query. It reads live alert-instance state straight from
    // Grafana's own alerting engine (the rules provisioned in
    // ../../grafana/provisioning/alerting/ locally, and the grafana_rule_group
    // resources in az-lz-cloudops for the deployed instance). Filtered to the
    // `ion` tag and the Alerting/Error states so a healthy fleet shows "0" and
    // an anomaly (a cost spike, a runaway agent left running overnight, a
    // wedged tailer) shows up here instead of requiring an operator to notice
    // a raw number drifting on some other panel.
    escapeHatch({
      id: 4,
      type: 'alertlist',
      title: 'Critical alerts firing',
      description: 'Grafana alert rules (tag "ion") currently in the Alerting or Error state. See Alerting > Alert rules for the full list and history.',
      gridPos: { h: 4, w: 4, x: 12, y: 4 },
      extra: {
        datasource: null,
        options: {
          maxItems: 10,
          sortOrder: 3,
          dashboardAlerts: false,
          stateFilter: { firing: true, pending: false, noData: false, normal: false, error: true },
          alertInstanceLabelFilter: '',
          folder: '',
          tags: ['ion'],
          viewMode: 'list',
          showInactiveAlerts: false,
        },
      },
    }),
    stat({
      id: 10,
      title: 'Ingest freshness by component (min since last line)',
      description:
        'Minutes since the most recent log line for each component. Green < 5m, orange < 30m, ' +
        'red beyond. A wedged tailer (one component stops flowing while the others advance — ' +
        'see README "Tailer wedge") turns its tile red within minutes. The [24h] lookback keeps ' +
        'a long-wedged component visible as a growing red value instead of dropping it.',
      gridPos: { h: 4, w: 8, x: 16, y: 4 },
      fieldConfig: {
        defaults: {
          unit: 'm',
          decimals: 1,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 5 },
            { color: 'red', value: 30 },
          ]),
          mappings: [],
          links: packLink('Ion Live Logs', '/d/ion-logs'),
        },
        overrides: [],
      },
      // Per-series display: one labeled cell per component, NOT a single reduced
      // value. `values: true` emits every series (a bare `lastNotNull` reduction
      // with values:false collapses all components into one number — the operator
      // saw "1.6 hours" with no component label). `textMode: value_and_name`
      // stamps the {{service_name}} label on each cell so every tile carries both
      // its component name and its unit-formatted value.
      options: {
        ...statOptions('background'),
        textMode: 'value_and_name',
        reduceOptions: { calcs: ['lastNotNull'], fields: '', values: true },
      },
      targets: [{ e: ingestFreshnessMinutes('24h'), legend: '{{service_name}}' }],
    }),
    // ---- Signal row: one live figure per granular pack -------------------
    stat({
      id: 11,
      title: 'Hosts reporting (Fleet)',
      gridPos: { h: 4, w: 4, x: 0, y: 8 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: packLink('Ion Fleet', '/d/ion-fleet'), noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctLabelCount('host_name', HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 12,
      title: 'Engine versions in fleet (Fleet)',
      description: 'Distinct engine version strings reporting in the window. More than one is version drift.',
      gridPos: { h: 4, w: 4, x: 4, y: 8 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'orange', value: 2 },
            { color: 'red', value: 3 },
          ]),
          mappings: [],
          links: packLink('Ion Fleet', '/d/ion-fleet'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: distinctLabelCount('service_version', HOST_PIPE, '$__range') }],
    }),
    stat({
      id: 13,
      title: 'Active extensions (Extensions)',
      gridPos: { h: 4, w: 4, x: 8, y: 8 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: packLink('Ion Extensions', '/d/ion-extensions'), noValue: 'no active extensions' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: activeExtensionCount('$__range') }],
    }),
    stat({
      id: 14,
      title: 'Active users (Users)',
      description: 'Distinct user values seen in telemetry. Installs with no configured identity all count as one "unassigned" bucket.',
      gridPos: { h: 4, w: 4, x: 12, y: 8 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: packLink('Ion Users', '/d/ion-users'), noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctLabelCount('user', USER_COUNT_PIPE, '$__range') }],
    }),
    stat({
      id: 15,
      title: 'iOS devices reporting (Mobile)',
      gridPos: { h: 4, w: 4, x: 16, y: 8 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: packLink('Ion Mobile', '/d/ion-mobile'), noValue: 'no iOS logs' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctDeviceField('device_id', '$__range', false) }],
    }),
    stat({
      id: 16,
      title: 'Autonomy ratio (Trust)',
      description:
        'Fraction of permission checks that resolved to allow. Binds to Phase-B telemetry ' +
        '(permission.decision) — reads "no data" until the engine ships that instrumentation; ' +
        'query is valid and activates automatically once it does.',
      gridPos: { h: 4, w: 4, x: 20, y: 8 },
      fieldConfig: {
        defaults: {
          unit: 'percentunit',
          decimals: 2,
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'red', value: null },
            { color: 'yellow', value: 0.5 },
            { color: 'green', value: 0.8 },
          ]),
          mappings: [],
          links: packLink('Ion Trust', '/d/ion-trust'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: accumulation(`sum(count_over_time(${PERM} | json | payload_decision="allow" [$__range])) / sum(count_over_time(${PERM} | json [$__range]))`, '$__range') }],
    }),
    // ---- Log volume: condensed (was h:8; a per-component trend line reads
    // the same at h:5 and the freed 3 rows go to the signal row above) -------
    timeseries({
      id: 6,
      title: 'Log volume by component',
      gridPos: { h: 5, w: 24, x: 0, y: 12 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          custom: { drawStyle: 'bars', fillOpacity: 50, stacking: { mode: 'normal', group: 'A' } },
        },
        overrides: [],
      },
      options: {
        legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
        tooltip: { mode: 'multi', sort: 'desc' },
      },
      targets: [{ e: logRateByComponent('1m'), legend: '{{service_name}}' }],
    }),
    // ---- Recent activity: one table, columns not raw JSON, full payload on
    // demand (was 3 separate raw-JSON logs panels: Error logs / Extension
    // activity / Recent logs). ---------------------------------------------
    logsTable({
      id: 9,
      title: 'Recent activity',
      description: 'Every log line across all surfaces. Sort or filter any column; expand "payload" on a row for the full parsed body.',
      gridPos: { h: 12, w: 24, x: 0, y: 17 },
      target: { e: stream('{service_name=~".+", event_name=""} | json') },
    }),
  ];

  return {
    uid: 'ion-overview',
    title: 'Ion Overview',
    description: 'Ion unified overview — headline signals with links into the story-packs',
    tags: ['ion'],
    schemaVersion: 39,
    version: 5,
    refresh: '30s',
    timeFrom: 'now-1h',
    folder: '',
    file: 'ion-overview',
    panels,
  };
}
