// Canonical Ion Mobile expressions (per-device iOS operational-log stream).
//
// iOS emits NO telemetry — only operational log lines (component="ios") that
// ride the paired desktop's egress of ios-diagnostic-logs.jsonl. So this pack
// queries the STRUCTURED LOG stream ({component="ios"}), not the telemetry
// stream the Fleet/Users packs use.
//
// OTLP body is the full Ion JSONL line (since log-egress-otel.ts shipped the
// full-body fix). Alloy's ion_otlp_unwrap pipeline extracts it and rewrites the
// stored Loki line to that JSON, so `| json` parses the full record including
// all nested keys. The per-device identity lives under the `fields` object:
//
//   device_id / device_model / app_version / app_build / os_version   — stamped by iOS
//   mdm_device_id / mdm_serial                                         — stamped by iOS (MDM-enrolled only)
//   pairing_id / desktop_host                                           — stamped by the desktop
//
// Loki `| json` flattens nested objects with a `_` separator, so these become
// `fields_device_id`, `fields_app_version`, etc. Named extraction pulls them
// back to friendly label names via the Loki json extraction syntax
// (`| json device_id="fields.device_id"`).
// component and level are promoted stream labels — no json parse needed for them.
// The `$device` dashboard variable scopes by device_model (regex, default `.*`).

import type { Expr, Window } from './types.ts';
import { accumulation, instant, registerQuery } from './queries.ts';

// The iOS operational-log stream selector.
const IOS = '{component="ios"}';

// Named json extraction for device identity fields. Pulls nested fields.*
// values up to friendly top-level label names so the rest of every query can
// reference device_id / device_model / pairing_id / app_version / os_version /
// desktop_host / mdm_device_id / mdm_serial directly without the fields_ prefix.
// The extraction is applied once in DEVICE_PIPE so it composes cleanly into
// every expression.
const JSON_EXTRACT =
  '| json device_id="fields.device_id", device_model="fields.device_model",' +
  ' pairing_id="fields.pairing_id", desktop_host="fields.desktop_host",' +
  ' app_version="fields.app_version", app_build="fields.app_build",' +
  ' os_version="fields.os_version", mdm_device_id="fields.mdm_device_id",' +
  ' mdm_serial="fields.mdm_serial"';

// Stream pipe for the mobile pack: extract device identity fields, DROP any line
// whose body is not parseable JSON, then scope by the $device variable (matched
// against device_model, the hardware model identifier e.g. `iPhone15,3`).
//
// The `| __error__=""` stage is load-bearing, not defensive garnish. The
// {component="ios"} stream is heterogeneous: newer lines store the full Ion
// JSONL record as the Loki body, but older lines (shipped before the full-body
// OTLP egress fix) store only the bare `msg` string. `| json` raises
// JSONParserErr on those bare-string bodies, and in LogQL a parse error on even
// ONE line aborts the whole grouped series (`sum by (...)`) and returns NO data
// — which is exactly why every grouped panel was blank while the ungrouped
// totals (no `| json` stage) rendered. `| __error__=""` skips the unparseable
// lines so the good lines aggregate normally. It must come AFTER the json stage
// (it filters on the error that stage produces) and BEFORE the device filter.
export const DEVICE_PIPE = ` ${JSON_EXTRACT} | __error__="" | device_model=~"$device"`;

// ---------------------------------------------------------------------------
// Distinct counts (headline stats)
// ---------------------------------------------------------------------------

// Distinct values of an identity field across the iOS stream in the window.
// The inner sum collapses each value to one series; the outer count counts the
// series. Instant accumulation — pass $__range. Powers the "Devices reporting"
// / "App versions" headline stats.
export const distinctDeviceField = (field: string, window: Window): Expr =>
  registerQuery(
    `Distinct iOS ${field} count`,
    `Number of distinct \`${field}\` values seen in the iOS log stream over the window. ` +
      'The inner sum collapses each value to one series; the outer count counts the series. ' +
      'Powers the mobile "Devices reporting" and "App versions" headline stats.',
    accumulation(
      `count(sum by (${field}) (count_over_time(${IOS}${DEVICE_PIPE} [${window}])))`,
      window,
    ),
  );

// ---------------------------------------------------------------------------
// Per-device volume / errors
// ---------------------------------------------------------------------------

// All iOS log lines over the window (headline stat).
export const iosLinesCount = (window: Window): Expr =>
  accumulation(`sum(count_over_time(${IOS}${DEVICE_PIPE} [${window}]))`, window);

// iOS ERROR lines over the window (headline stat). level IS a promoted label,
// so this filters on the label before the json extraction for efficiency.
export const iosErrorCount = (window: Window): Expr =>
  accumulation(`sum(count_over_time({component="ios", level="ERROR"}${DEVICE_PIPE} [${window}]))`, window);

// Per-device log volume, grouped (bargauge / table / timeseries).
// Default grouping uses device_id + device_model: stable hardware identity with
// a human-readable model name for display.
export const volumeByDevice = (by: readonly string[], window: Window): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(`${grouping} (count_over_time(${IOS}${DEVICE_PIPE} [${window}]))`, window);
};

// Per-device ERROR volume, grouped.
export const errorsByDevice = (by: readonly string[], window: Window): Expr => {
  const grouping = by.length > 0 ? `sum by (${by.join(', ')})` : 'sum';
  return accumulation(
    `${grouping} (count_over_time({component="ios", level="ERROR"}${DEVICE_PIPE} [${window}]))`,
    window,
  );
};

// ---------------------------------------------------------------------------
// Attribution tables (device / app-version drift, device↔desktop pairing)
// ---------------------------------------------------------------------------

// Every device / app-version / os-version combination reporting in the window
// with its line count. Two rows for one device_id means it upgraded mid-window.
// Groups by stable device_id (survives re-pairings) plus human-readable model
// name and MDM identity for cross-system correlation.
// Instant snapshot (table).
export const appVersionByDevice = (window: Window): Expr =>
  registerQuery(
    'iOS app-version drift by device',
    'Every device_id / device_model / app_version / os_version combination reporting in the ' +
      'iOS log stream over the window, with its line count. Two rows for one device_id means ' +
      'it upgraded the app (or OS) mid-window. Answers "which device is on which build?". ' +
      'mdm_device_id and mdm_serial appear when the device is enrolled in MDM, enabling ' +
      'cross-reference to Intune or other MDM consoles.',
    instant(
      `sum by (device_id, device_model, pairing_id, mdm_device_id, mdm_serial, app_version, app_build, os_version) ` +
        `(count_over_time(${IOS}${DEVICE_PIPE} [${window}]))`,
      window,
    ),
  );

// The device→desktop pairing matrix: every device_id × desktop_host pair that
// produced lines in the window, with the count. A device paired to two desktops
// yields two rows; this is the "which device connected to which desktop" view.
// device_id is the stable hardware identity (identifierForVendor UUID) that
// survives re-pairings; pairing_id is the ECDH channel ID that links to a
// specific desktop pairing session.
// Instant snapshot (table).
export const devicePairingMatrix = (window: Window): Expr =>
  registerQuery(
    'iOS device↔desktop pairing matrix',
    'Every device_id / device_model × desktop_host pair that produced iOS log lines over the ' +
      'window, with the line count. A device paired to two desktops yields two rows — this is ' +
      'the "which iOS device connected to which desktop, and generated logs there" view. ' +
      'pairing_id is the ECDH channel ID for the specific pairing session; device_id is the ' +
      'stable per-device hardware identity (survives re-pairings). ' +
      'desktop_host mirrors the telemetry `host` value, so a row cross-references the Ion Fleet ' +
      'board for the same machine. mdm_device_id / mdm_serial enable Intune correlation.',
    instant(
      `sum by (device_id, device_model, pairing_id, mdm_device_id, mdm_serial, desktop_host) (count_over_time(${IOS}${DEVICE_PIPE} [${window}]))`,
      window,
    ),
  );

// ---------------------------------------------------------------------------
// Device freshness (minutes since last iOS line per device)
// ---------------------------------------------------------------------------

// Same detector shape as fleet's hostLastSeenMinutes, grouped by device_id
// (stable hardware identity) instead of host. Fixed [24h] lookback, NOT
// $__range: a device that went quiet hours ago must stay VISIBLE as a growing
// red value instead of dropping out of a narrow range (ADR-022 detector class).
export const deviceLastSeenMinutes = (window: Window): Expr =>
  registerQuery(
    'iOS device last-seen (minutes since last log line)',
    'Minutes since the most recent iOS log line per device. The mobile liveness detector: ' +
      'a device whose logs stopped arriving climbs while the others stay near zero. ' +
      'Grouped by device_id (stable hardware identity) and device_model for display. ' +
      'Fixed [24h] lookback so a long-quiet device stays visible as a growing value rather ' +
      'than dropping out of a narrow dashboard range.',
    instant(
      `(vector(\${__to:date:seconds}) - on() group_right() ` +
        `max by (device_id, device_model) (max_over_time(${IOS}${DEVICE_PIPE} ` +
        `| label_format ts_unix="{{ __timestamp__ | unixEpoch }}" | unwrap ts_unix [${window}]))) / 60`,
      window,
    ),
  );

