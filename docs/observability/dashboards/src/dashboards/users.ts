// Recipe: Ion Users (uid ion-users).
//
// "Who is using Ion and what is their footprint?" Per-user utilization, spend,
// errors, tool failures, and trust posture, over the telemetry stream.
//
// Identity caveat: the top-level `user` field is populated when the engine has
// an identity to report (enterprise OIDC installs, or a configured operator
// identity). Lines without it coalesce to the "unassigned" bucket BEFORE the
// $user filter runs (see USER_PIPE in queries-fleet.ts), so typing `unassigned`
// into the User variable selects exactly the unattributed population, and the
// $install variable splits individual installs within it.

import type { Dashboard } from '../dashboard.ts';
import { row, text, stat, timeseries, bargauge, table, logs } from '../panels.ts';
import { accumulation, stream, telemetry } from '../queries.ts';
import {
  USER_PIPE,
  distinctLabelCount,
  totalSpend,
  spendBy,
  runsBy,
  kindCountBy,
  activityBy,
  unwrapSumBy,
} from '../queries-fleet.ts';

const PERM = telemetry('permission.decision');
const fixed = (steps: unknown[] = []) => ({ mode: 'absolute', steps });
const statOptions = (colorMode: string) => ({
  reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
  orientation: 'auto',
  textMode: 'auto',
  colorMode,
  graphMode: 'none',
});
const legendBottom = () => ({
  legend: { displayMode: 'list', placement: 'bottom', showLegend: true },
  tooltip: { mode: 'multi', sort: 'desc' },
});
const bars = (fillOpacity: number) => ({
  defaults: { unit: 'short', custom: { drawStyle: 'bars', fillOpacity, stacking: { mode: 'normal', group: 'A' } } },
  overrides: [],
});
const link = (title: string, url: string) => [{ title, url }];

const INTRO =
  '## Who is using Ion and what is their footprint?\n\nPer-user utilization over the telemetry stream: spend, runs, tool failures, permission denials, sandbox blocks, and secret containment — the product-intelligence and risk view of a single user. All panels honor the dashboard time picker.\n\n**Identity caveat.** The `user` field is populated when the engine has an identity to report (enterprise OIDC installs, or a configured operator identity). Telemetry without it groups under **unassigned** — type `unassigned` into the User variable to select exactly that population, and use the Install variable to split individual installs within it.\n\n| Related | Dashboard |\n|---|---|\n| Landing | [Ion Overview](/d/ion-overview) |\n| Hosts & installs | [Ion Fleet](/d/ion-fleet) |\n| Cost detail | [Ion Cost](/d/ion-cost) |\n| Trust detail | [Ion Trust](/d/ion-trust) |\n| Quality detail | [Ion Quality](/d/ion-quality) |';

export function usersDashboard(): Dashboard {
  const panels = [
    text(1, { h: 5, w: 24, x: 0, y: 0 }, INTRO),
    stat({
      id: 2,
      title: 'Active users',
      description: 'Distinct user values seen in telemetry over the dashboard time range. Default installs without identity all count as the single "unassigned" bucket.',
      gridPos: { h: 4, w: 4, x: 0, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: distinctLabelCount('user', USER_PIPE, '$__range') }],
    }),
    stat({
      id: 3,
      title: 'Spend',
      gridPos: { h: 4, w: 4, x: 4, y: 5 },
      fieldConfig: {
        defaults: { unit: 'currencyUSD', decimals: 4, color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: link('Ion Cost', '/d/ion-cost'), noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: totalSpend(USER_PIPE, '$__range') }],
    }),
    stat({
      id: 4,
      title: 'Runs',
      gridPos: { h: 4, w: 4, x: 8, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'blue' }, thresholds: fixed(), mappings: [], links: link('Ion Cost', '/d/ion-cost'), noValue: 'telemetry off' },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: runsBy([], USER_PIPE, '$__range') }],
    }),
    stat({
      id: 5,
      title: 'Tool failures',
      description: 'tool.execute events carrying a non-empty payload_error for the selected user(s).',
      gridPos: { h: 4, w: 4, x: 12, y: 5 },
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
          links: link('Ion Quality', '/d/ion-quality'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: kindCountBy('tool.execute', [], USER_PIPE, '$__range', ' | payload_error!=""') }],
    }),
    stat({
      id: 6,
      title: 'Denials',
      description: 'Denied permission checks for the selected user(s). Denials are the safety mechanism working; watch the trend, not the count.',
      gridPos: { h: 4, w: 4, x: 16, y: 5 },
      fieldConfig: {
        defaults: { unit: 'short', color: { mode: 'fixed', fixedColor: 'orange' }, thresholds: fixed(), mappings: [], links: link('Ion Trust', '/d/ion-trust') },
        overrides: [],
      },
      options: statOptions('value'),
      targets: [{ e: kindCountBy('permission.decision', [], USER_PIPE, '$__range', ' | payload_decision="deny"') }],
    }),
    stat({
      id: 7,
      title: 'Sandbox blocks',
      gridPos: { h: 4, w: 4, x: 20, y: 5 },
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
          links: link('Ion Trust', '/d/ion-trust'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: kindCountBy('sandbox.block', [], USER_PIPE, '$__range') }],
    }),
    row(20, 'Footprint by user', 9),
    bargauge({
      id: 8,
      title: 'Spend by user',
      gridPos: { h: 8, w: 12, x: 0, y: 10 },
      fieldConfig: { defaults: { unit: 'currencyUSD', decimals: 4 }, overrides: [] },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['sum'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [{ e: spendBy(['user'], USER_PIPE, '$__range'), legend: '{{user}}' }],
    }),
    bargauge({
      id: 9,
      title: 'Autonomy ratio by user',
      description: 'Fraction of permission checks resolving to allow, per user. A user with a falling ratio is asking for more than the rule set absorbs.',
      gridPos: { h: 8, w: 8, x: 12, y: 10 },
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
        },
        overrides: [],
      },
      options: { orientation: 'horizontal', reduceOptions: { calcs: ['lastNotNull'] }, displayMode: 'gradient', showUnfilled: true },
      targets: [
        {
          e: accumulation(
            `sum by (user) (count_over_time(${PERM}${USER_PIPE} | payload_decision="allow" [$__range])) / sum by (user) (count_over_time(${PERM}${USER_PIPE} [$__range]))`,
            '$__range',
          ),
          legend: '{{user}}',
        },
      ],
    }),
    stat({
      id: 10,
      title: 'Secrets contained',
      description: 'Secret matches redacted before leaving the engine, for the selected user(s). Each is one near-miss.',
      gridPos: { h: 8, w: 4, x: 20, y: 10 },
      fieldConfig: {
        defaults: {
          unit: 'short',
          color: { mode: 'thresholds' },
          thresholds: fixed([
            { color: 'green', value: null },
            { color: 'yellow', value: 1 },
            { color: 'red', value: 5 },
          ]),
          mappings: [],
          links: link('Ion Trust', '/d/ion-trust'),
        },
        overrides: [],
      },
      options: statOptions('background'),
      targets: [{ e: unwrapSumBy('secret.containment', 'payload_match_count', [], USER_PIPE, '$__range') }],
    }),
    row(30, 'What they use', 18),
    table({
      id: 11,
      title: 'Model mix by user (spend)',
      gridPos: { h: 8, w: 8, x: 0, y: 19 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'currencyUSD', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Spend', desc: true }] },
      transformations: [
        { id: 'organize', options: { renameByName: { user: 'User', payload_model: 'Model', Value: 'Spend' } } },
      ],
      targets: [{ e: spendBy(['user', 'payload_model'], USER_PIPE, '$__range'), legend: '{{user}} / {{payload_model}}' }],
    }),
    table({
      id: 12,
      title: 'Extensions used',
      description: "run.complete counts grouped by user and hosting extension. Runs without an extension group as 'unattributed'.",
      gridPos: { h: 8, w: 8, x: 8, y: 19 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Runs', desc: true }] },
      transformations: [
        { id: 'organize', options: { renameByName: { user: 'User', context_extension: 'Extension', Value: 'Runs' } } },
      ],
      targets: [
        {
          e: kindCountBy(
            'run.complete',
            ['user', 'context_extension'],
            USER_PIPE,
            '$__range',
            ' | label_format context_extension=`{{if .context_extension}}{{.context_extension}}{{else}}unattributed{{end}}`',
          ),
          legend: '{{user}} / {{context_extension}}',
        },
      ],
    }),
    table({
      id: 13,
      title: 'Tool failure leaderboard',
      description: 'tool.execute failures grouped by user and tool. The user/tool pair with the highest count is the one most likely stuck in a loop.',
      gridPos: { h: 8, w: 8, x: 16, y: 19 },
      mode: 'instant',
      fieldConfig: { defaults: { unit: 'short', custom: { align: 'auto', displayMode: 'auto' } }, overrides: [] },
      options: { footer: { show: false }, sortBy: [{ displayName: 'Failures', desc: true }] },
      transformations: [
        { id: 'organize', options: { renameByName: { user: 'User', payload_tool: 'Tool', Value: 'Failures' } } },
      ],
      targets: [
        { e: kindCountBy('tool.execute', ['user', 'payload_tool'], USER_PIPE, '$__range', ' | payload_error!=""'), legend: '{{user}} / {{payload_tool}}' },
      ],
    }),
    row(40, 'Over time', 27),
    timeseries({
      id: 14,
      title: 'Activity over time by user',
      description: 'All telemetry events per interval, grouped by user — the utilization pulse.',
      gridPos: { h: 8, w: 12, x: 0, y: 28 },
      fieldConfig: bars(60),
      options: legendBottom(),
      targets: [{ e: activityBy(['user'], USER_PIPE, '$__interval'), legend: '{{user}}' }],
    }),
    timeseries({
      id: 15,
      title: 'Spend over time by user',
      gridPos: { h: 8, w: 12, x: 12, y: 28 },
      fieldConfig: {
        defaults: { unit: 'currencyUSD', custom: { drawStyle: 'bars', fillOpacity: 60, stacking: { mode: 'normal', group: 'A' } } },
        overrides: [],
      },
      options: legendBottom(),
      targets: [{ e: spendBy(['user'], USER_PIPE, '$__interval'), legend: '{{user}}' }],
    }),
    logs({
      id: 16,
      title: 'Recent denials',
      description: "The engine's verbatim record of denied tool calls for the selected user(s).",
      gridPos: { h: 10, w: 24, x: 0, y: 36 },
      target: { e: stream(`${PERM}${USER_PIPE} | payload_decision="deny"`) },
    }),
  ];

  return {
    uid: 'ion-users',
    title: 'Ion Users',
    description: 'Ion users — who is using Ion and what is their footprint?',
    tags: ['ion', 'users', 'audience'],
    schemaVersion: 39,
    version: 1,
    refresh: '1m',
    timeFrom: 'now-24h',
    folder: 'audience',
    file: 'ion-users',
    panels,
    templating: [
      // `user` and `install_id` are parsed JSON fields, not indexed stream
      // labels, so label_values() cannot populate a dropdown (same constraint
      // as the extensions pack). Textbox regex variables defaulting to `.*`
      // match everyone; `unassigned` selects the coalesced no-identity bucket.
      {
        name: 'user',
        label: 'User',
        description: "User identity to scope panels. Accepts regex. `unassigned` selects default installs without an identity. Default matches all.",
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
      {
        name: 'install',
        label: 'Install',
        description: 'install_id to scope panels — the secondary identity that splits individuals within the unassigned bucket. Accepts regex. Default matches all.',
        type: 'textbox',
        current: { value: '.*' },
        query: '.*',
        hide: 0,
      },
    ],
  };
}
