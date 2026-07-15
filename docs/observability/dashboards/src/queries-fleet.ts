// Canonical fleet & audience expressions (host / install / version / user).
//
// Identity fields live at the TOP LEVEL of every telemetry line (`host`,
// `install_id`, `version`, `user`), but `host` and `user` are NOT promoted by
// Alloy as structured metadata — they exist only in the raw JSON body. Every
// expression here therefore parses with `| json`, which yields the bare labels
// (`host`, `user`, `install_id`, `version`) and the `payload_`-prefixed payload
// fields. `| json` is the deliberate choice even for the fields Alloy does
// promote: promotion is not retroactive, so a metadata-only query silently
// drops every historical line; the parser works uniformly on old and new
// entries.
//
// `user` is populated only on enterprise installs with an OIDC auth context
// (log-schema.md R20) and on newer default-install lines where the engine had
// an identity to report. Lines without it coalesce to the "unassigned" bucket
// BEFORE the `$user` filter runs, so `unassigned` is itself a selectable value.

import type { Expr, Window } from './types.ts';
import { accumulation, instant, registerQuery, telemetry, coalesceStage } from './queries.ts';

// All telemetry, any kind — for distinct-count and activity expressions.
const ALL = '{service_name="ion-telemetry"}';
const RUN = telemetry('run.complete');

// Stream pipe for the fleet pack: parse the body, scope by the $host variable.
export const HOST_PIPE = ' | json | host=~"$host"';

// Stream pipe for the users pack: parse, coalesce absent user to "unassigned"
// (before the filter, so the default-install population is selectable), then
// scope by the $user and $install variables.
export const USER_PIPE = ` | json ${coalesceStage('user', 'unassigned')} | user=~"$user" | install_id=~"$install"`;

// ---------------------------------------------------------------------------
// Distinct counts (headline stats)
// ---------------------------------------------------------------------------

// Distinct values of an identity label across all telemetry in the window.
// The inner sum collapses each label value to one series; the outer count
// counts the series. Instant accumulation — pass $__range.
export const distinctLabelCount = (label: string, pipe: string, window: Window): Expr =>
  registerQuery(
    `Distinct ${label} count`,
    `Number of distinct \`${label}\` values seen in telemetry over the window. ` +
      'The inner sum collapses each value to one series; the outer count counts the series. ' +
      'Powers the fleet "Hosts reporting" / "Installs" / "Engine versions" and the users ' +
      '"Active users" headline stats.',
    accumulation(`count(sum by (${label}) (count_over_time(${ALL}${pipe} [${window}])))`, window),
  );

// Distinct install_ids per host (instant bargauge). More than one means
// several engine instances (e.g. headless daemons) share a machine.
export const installsPerHost = (window: Window): Expr =>
  registerQuery(
    'Installs per host',
    'Distinct install_id count grouped by host. A host with more than one install is ' +
      'running several engine instances (e.g. headless daemons) side by side.',
    accumulation(
      `count by (host) (sum by (host, install_id) (count_over_time(${ALL}${HOST_PIPE} [${window}])))`,
      window,
    ),
  );

// ---------------------------------------------------------------------------
// Grouped spend / run / activity accumulations over an arbitrary pipe
// ---------------------------------------------------------------------------

// run.complete cost summed and grouped. With `| json` in the pipe the cost
// field parses as payload_run_cost_usd (the bare run_cost_usd name is the
// Alloy structured-metadata alias, unavailable behind a parser).
export const spendBy = (by: readonly string[], pipe: string, window: Window): Expr =>
  accumulation(
    `sum by (${by.join(', ')}) (sum_over_time(${RUN}${pipe} | unwrap payload_run_cost_usd [${window}]))`,
    window,
  );

// Total run.complete cost over the pipe (headline stat).
export const totalSpend = (pipe: string, window: Window): Expr =>
  accumulation(`sum(sum_over_time(${RUN}${pipe} | unwrap payload_run_cost_usd [${window}]))`, window);

// run.complete count, grouped (or pass [] for the bare total).
export const runsBy = (by: readonly string[], pipe: string, window: Window): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(`${grouping} (count_over_time(${RUN}${pipe} [${window}]))`, window);
};

// Count of any telemetry kind over the pipe, grouped.
export const kindCountBy = (kind: string, by: readonly string[], pipe: string, window: Window, filter = ''): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(`${grouping} (count_over_time(${telemetry(kind)}${pipe}${filter} [${window}]))`, window);
};

// All-telemetry activity count over the pipe, grouped (event volume proxy).
export const activityBy = (by: readonly string[], pipe: string, window: Window): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(`${grouping} (count_over_time(${ALL}${pipe} [${window}]))`, window);
};

// Sum of an unwrapped payload field over the pipe, grouped.
export const unwrapSumBy = (kind: string, field: string, by: readonly string[], pipe: string, window: Window, filter = ''): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(
    `${grouping} (sum_over_time(${telemetry(kind)}${pipe}${filter} | unwrap ${field} [${window}]))`,
    window,
  );
};

// Telemetry events carrying a non-empty payload_error, grouped. Ops-log ERROR
// lines carry no host/user identity, so telemetry error fields are the only
// per-host / per-user error signal.
export const errorEventsBy = (by: readonly string[], pipe: string, window: Window): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(`${grouping} (count_over_time(${ALL}${pipe} | payload_error!="" [${window}]))`, window);
};

// ---------------------------------------------------------------------------
// Host freshness (minutes since last telemetry per host)
// ---------------------------------------------------------------------------

// Same detector shape as ingestFreshnessMinutes (queries-logs.ts), grouped by
// host instead of component. Fixed [24h] lookback, NOT $__range: a host that
// went quiet hours ago must stay VISIBLE as a growing red value instead of
// dropping out of a narrow range — the point of a last-seen detector
// (ADR-022 detector class).
export const hostLastSeenMinutes = (window: Window): Expr =>
  registerQuery(
    'Host last-seen (minutes since last telemetry)',
    'Minutes since the most recent telemetry event per host. The fleet liveness detector: ' +
      'a host whose engine stopped reporting climbs while the others stay near zero. ' +
      'Fixed [24h] lookback so a long-quiet host stays visible as a growing value rather ' +
      'than dropping out of a narrow dashboard range.',
    instant(
      `(vector(\${__to:date:seconds}) - on() group_right() ` +
        `max by (host) (max_over_time(${ALL}${HOST_PIPE} ` +
        `| label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [${window}]))) / 60`,
      window,
    ),
  );
