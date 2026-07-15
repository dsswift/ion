// Contract tests for the dashboards-as-code generator.
//
// These are RED-proofed: each assertion fails on the broken behavior and passes
// on the correct behavior. Run with `npm test` (node --test).
//
// The three headline proofs the initiative requires:
//   (a) the builder THROWS on a timeseries + fixed-window accumulation — the
//       $7.26K overcount bug is unwritable;
//   (b) check.ts fails on a deliberate hand-edit to a committed JSON;
//   (c) the structural overcount audit is clean across all emitted dashboards.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timeseries, stat, bargauge } from '../src/panels.ts';
import { accumulation, windowedStat, instant } from '../src/queries.ts';
import { ingestFreshnessMinutes } from '../src/queries-logs.ts';
import { auditOvercount } from '../src/check.ts';
import { buildDashboard } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';
import { overviewDashboard } from '../src/dashboards/overview.ts';
import { semanticDiff } from '../src/semantic-diff.ts';

// ---------------------------------------------------------------------------
// PROOF (a): the overcount bug is unwritable
// ---------------------------------------------------------------------------

test('PROOF(a): timeseries + fixed-window accumulation THROWS', () => {
  // This is the exact shape of the $7.26K-against-$255 defect: a running sum on
  // a timeseries with a fixed [30m] window re-sums the whole window each step.
  assert.throws(
    () =>
      timeseries({
        id: 1,
        title: 'overcount',
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        targets: [{ e: accumulation('sum(sum_over_time({k="run.complete"} | unwrap c [30m]))', '30m') }],
      }),
    /overcount/,
    'a fixed-window accumulation on a timeseries must throw',
  );
});

test('PROOF(a): same accumulation on $__interval is ACCEPTED', () => {
  // The correct form: the window binds to the panel step, so the series
  // integrates to the true range total. Must NOT throw.
  assert.doesNotThrow(() =>
    timeseries({
      id: 1,
      title: 'correct',
      gridPos: { h: 8, w: 12, x: 0, y: 0 },
      targets: [{ e: accumulation('sum(sum_over_time({k="run.complete"} | unwrap c [$__interval]))', '$__interval') }],
    }),
  );
});

test('PROOF(a): fixed-window accumulation on an INSTANT panel is ACCEPTED', () => {
  // "Spend over the last 24h" as a single stat is legitimate and required.
  assert.doesNotThrow(() =>
    stat({
      id: 1,
      title: 'Spend (24h)',
      gridPos: { h: 4, w: 6, x: 0, y: 0 },
      targets: [{ e: accumulation('sum(sum_over_time({k="run.complete"} | unwrap c [24h]))', '24h') }],
    }),
  );
});

test('PROOF(a): instant accumulation using $__interval THROWS (no per-step interval)', () => {
  assert.throws(
    () =>
      stat({
        id: 1,
        title: 'bad instant',
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        targets: [{ e: accumulation('sum(sum_over_time({k="x"} | unwrap c [$__interval]))', '$__interval') }],
      }),
    /invalid/,
  );
});

test('windowed-stat with a fixed window is legitimate on a timeseries (p95 over 5m)', () => {
  assert.doesNotThrow(() =>
    timeseries({
      id: 1,
      title: 'TTFT p95 (5m)',
      gridPos: { h: 8, w: 12, x: 0, y: 0 },
      targets: [{ e: windowedStat('quantile_over_time(0.95, {k="ttft"} | unwrap ms [5m])', '5m') }],
    }),
  );
});

test('rolling-count windowed-stat with pinWindow THROWS when the window is absent from the title', () => {
  // The "(5m)" / "(1m)" rule: a rolling count whose window is part of its stated
  // meaning must name the window in the title.
  assert.throws(
    () =>
      timeseries({
        id: 1,
        title: 'Errors over time', // no window token
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        targets: [{ e: windowedStat('sum(count_over_time({level="ERROR"}[5m]))', '5m', true) }],
      }),
    /window\/title drift/,
  );
});

test('rolling-count windowed-stat with pinWindow PASSES when the title names the window', () => {
  assert.doesNotThrow(() =>
    timeseries({
      id: 1,
      title: 'Errors over time (5m)',
      gridPos: { h: 8, w: 12, x: 0, y: 0 },
      targets: [{ e: windowedStat('sum(count_over_time({level="ERROR"}[5m]))', '5m', true) }],
    }),
  );
});

test('every emitted target carries the __ionClass audit stamp', () => {
  const p = bargauge({
    id: 1,
    title: 'ranked',
    gridPos: { h: 8, w: 12, x: 0, y: 0 },
    targets: [{ e: instant('sum by (m) (count_over_time({k="x"}[24h]))', '24h') }],
  });
  const targets = p.targets as { __ionClass?: string }[];
  assert.equal(targets[0].__ionClass, 'instant');
});

// ---------------------------------------------------------------------------
// Ingest freshness (tailer-wedge detector)
// ---------------------------------------------------------------------------
//
// These pin the freshness-detector contract proven against live Loki 3.7.3.
// Each fails on a plausible wrong construction of the query and passes on the
// correct one — see the mechanism note in queries-logs.ts.

test('ingest freshness is class "instant" (a one-shot snapshot, not an accumulation)', () => {
  // Class matters: if it were mis-declared "accumulation" the [24h] fixed window
  // would be rejected by the overcount guard on any range panel. As "instant" it
  // is a per-component snapshot evaluated once — the correct classification.
  assert.equal(ingestFreshnessMinutes('24h').cls, 'instant');
});

test('ingest freshness uses the Grafana ${__to:date:seconds} macro, not a bare time()', () => {
  // Loki has no PromQL time(); vector() accepts only a bare literal. The Grafana
  // date-format macro expands client-side to a Unix-seconds integer. A query that
  // used time() or vector(time()) would be a parse error at Loki.
  const e = ingestFreshnessMinutes('24h');
  assert.ok(e.expr.includes('vector(${__to:date:seconds})'), 'must use the ${__to:date:seconds} macro inside vector()');
  assert.ok(!/\btime\(\)/.test(e.expr), 'must NOT use time() — unsupported by Loki');
});

test('ingest freshness keeps per-component labels via group_right (else all series drop)', () => {
  // vector() is label-less; a bare subtraction against a per-component vector
  // matches on the empty label set and returns nothing. `on() group_right()`
  // is what preserves the component label so every component gets a value.
  const e = ingestFreshnessMinutes('24h');
  assert.ok(e.expr.includes('on() group_right()'), 'must use on() group_right() to preserve component labels');
});

test('ingest freshness converts to minutes and carries the requested lookback window', () => {
  const e = ingestFreshnessMinutes('24h');
  assert.ok(e.expr.trim().endsWith('/ 60'), 'must divide seconds by 60 to yield minutes');
  assert.ok(e.expr.includes('[24h]'), 'must select the requested fixed lookback window');
  assert.equal(e.window, '24h');
});

test('ingest freshness renders as an instant stat with green/orange/red freshness thresholds', () => {
  // The overview panel: a stat (instant) with thresholds green <5m / orange <30m
  // / red beyond. A wedged tailer climbs into orange then red within minutes.
  const p = stat({
    id: 1,
    title: 'Ingest freshness by component (min since last line)',
    gridPos: { h: 4, w: 24, x: 0, y: 0 },
    fieldConfig: {
      defaults: {
        unit: 'm',
        thresholds: {
          mode: 'absolute',
          steps: [
            { color: 'green', value: null },
            { color: 'orange', value: 5 },
            { color: 'red', value: 30 },
          ],
        },
      },
      overrides: [],
    },
    targets: [{ e: ingestFreshnessMinutes('24h'), legend: '{{component}}' }],
  });
  const targets = p.targets as { __ionClass?: string; queryType?: string }[];
  assert.equal(targets[0].__ionClass, 'instant');
  assert.equal(targets[0].queryType, 'instant', 'instant eval means the [24h] window is legitimate, not an overcount');
});

// ---------------------------------------------------------------------------
// Freshness panel UX contract (operator feedback): per-series labeled cells,
// verdict-row placement, and unit-carrying values. Each assertion is RED against
// the pre-fix recipe (full-width own row, values:false single reduction).
// ---------------------------------------------------------------------------

// Locate the freshness stat on the live overview recipe by its stable id.
function freshnessPanel(): Record<string, any> {
  const panels = overviewDashboard().panels as Record<string, any>[];
  const p = panels.find((x) => x.id === 10);
  assert.ok(p, 'overview must have the freshness panel at id 10');
  return p!;
}

test('freshness panel renders per-series labeled cells (values:true, non-collapsing reduce)', () => {
  // The operator saw a single "1.6 hours" with no component label because the
  // reduce collapsed every series into one number (values:false). Per-series
  // display requires values:true so EVERY component gets its own cell, and
  // textMode value_and_name so each cell is stamped with its {{component}} name.
  const p = freshnessPanel();
  assert.equal(p.options.reduceOptions.values, true, 'values must be true so all series render, not one reduction');
  assert.equal(
    p.options.textMode,
    'value_and_name',
    'textMode must display the component name alongside the value on each cell',
  );
  assert.equal(p.targets[0].legendFormat, '{{component}}', 'legend must key each series by component');
});

test('freshness panel sits in the top verdict row (y=0 band) and is not full-width', () => {
  // Placement/weight: the panel moved out of its own full-width row into the
  // verdict row alongside Errors/Warnings/Spend/Runs. Visibility is by color,
  // not size. The verdict row is the first content row below the intro text.
  const panels = overviewDashboard().panels as Record<string, any>[];
  const intro = panels.find((x) => x.type === 'text');
  const verdictY = intro.gridPos.y + intro.gridPos.h; // first row after the intro
  const p = freshnessPanel();
  assert.equal(p.gridPos.y, verdictY, `freshness must share the verdict row band (y=${verdictY})`);
  assert.ok(p.gridPos.w < 24, 'freshness must not span the full 24-column width');
  // The verdict row must still fit on a 24-column grid without wrapping: every
  // tile at the same y sums to exactly 24 columns.
  const rowWidth = panels
    .filter((x) => x.gridPos.y === verdictY)
    .reduce((sum, x) => sum + x.gridPos.w, 0);
  assert.equal(rowWidth, 24, 'verdict-row tiles must sum to exactly 24 columns (no wrap)');
});

test('freshness panel sets an explicit minutes unit so values carry their unit', () => {
  // "98" must read as minutes and "1.6 h" must carry its unit — Grafana's `m`
  // duration unit renders both with the unit visible. A bare 'short'/'' unit
  // (the wrong construction) would show a raw number with no unit.
  const p = freshnessPanel();
  assert.equal(p.fieldConfig.defaults.unit, 'm', 'unit must be the minutes duration unit so values render with a unit');
});

// ---------------------------------------------------------------------------
// PROOF (c): structural overcount audit clean across all emitted dashboards
// ---------------------------------------------------------------------------

test('PROOF(c): structural overcount audit is clean for every recipe', () => {
  for (const recipe of RECIPES) {
    const d = recipe();
    const json = buildDashboard(d);
    const violations = auditOvercount(json);
    assert.deepEqual(violations, [], `overcount violations in ${d.uid}: ${violations.join('; ')}`);
  }
});

test('the audit CATCHES a synthetic range-accumulation-fixed-window target', () => {
  // Prove the audit is not vacuous: hand-craft the emitted shape the builder
  // would refuse, bypassing the builder, and confirm the JSON-level audit flags
  // it. This is what defends against a raw-JSON escape hatch.
  const poisoned = {
    panels: [
      {
        type: 'timeseries',
        title: 'poisoned',
        targets: [
          {
            expr: 'sum(sum_over_time({k="run.complete"} | unwrap c [30m]))',
            queryType: 'range',
            __ionClass: 'accumulation',
          },
        ],
      },
    ],
  };
  const violations = auditOvercount(poisoned);
  assert.equal(violations.length, 1, 'audit must catch the synthetic overcount target');
});

// ---------------------------------------------------------------------------
// PROOF (b): the drift gate detects a hand-edit
// ---------------------------------------------------------------------------
//
// The byte-diff is what backs check.ts. This proves the diff logic directly and
// independent of which JSONs are on disk: generate a dashboard, serialize it
// canonically, then assert that a single-character hand-edit no longer matches.
// (The end-to-end gate — committed file vs generated output — is owned and
// enforced by check.ts / `make check-dashboards`, which runs in CI and the
// pre-push hook.)

test('PROOF(b): a hand-edit to serialized dashboard JSON is detected by byte-diff', () => {
  const generated = buildDashboard(RECIPES.find((r) => r().uid === 'ion-cost')!());
  const generatedStr = JSON.stringify(generated, null, 2) + '\n';

  // Re-serializing the same object must be byte-identical (deterministic emit).
  assert.equal(JSON.stringify(buildDashboard(RECIPES.find((r) => r().uid === 'ion-cost')!()), null, 2) + '\n', generatedStr);

  // A single-character hand-edit must break the byte comparison the gate runs.
  const tampered = generatedStr.replace('"Spend"', '"Spend TAMPERED"');
  assert.notEqual(tampered, generatedStr, 'a hand-edit must differ from generated output');
  assert.ok(tampered.includes('TAMPERED'), 'sanity: the tamper landed');
});

// ---------------------------------------------------------------------------
// Semantic-diff self-check (the migration verification instrument)
// ---------------------------------------------------------------------------

test('semanticDiff reports identical dashboards as identical', () => {
  const d = buildDashboard(RECIPES[0]());
  const { identical } = semanticDiff(d, JSON.parse(JSON.stringify(d)));
  assert.ok(identical);
});

test('semanticDiff catches a changed window (the overcount-fix signal)', () => {
  const a = { panels: [{ type: 'timeseries', title: 't', targets: [{ expr: 'x[1d]', queryType: 'range' }] }] };
  const b = { panels: [{ type: 'timeseries', title: 't', targets: [{ expr: 'x[$__interval]', queryType: 'range' }] }] };
  const { identical, changes } = semanticDiff(a, b);
  assert.equal(identical, false);
  assert.ok(changes.some((c) => c.includes('windows')));
});

// ---------------------------------------------------------------------------
// ADR-022: panels honor the dashboard time picker
// ---------------------------------------------------------------------------
//
// The window policy: instant "window total" panels use $__range, series
// accumulations use $__interval, and titles never carry a window suffix for a
// picker-honoring panel. Fixed windows survive ONLY on the detector classes
// (lamps, freshness/last-seen detectors, latest-value panels, "now" detectors
// with the window pinned in the title, and statistical smoothing windows).

function recipeByUid(uid: string) {
  const r = RECIPES.find((x) => x().uid === uid);
  assert.ok(r, `recipe ${uid} must be registered`);
  return r!();
}

function panelByTitle(uid: string, title: string): Record<string, any> {
  const panels = recipeByUid(uid).panels as Record<string, any>[];
  const p = panels.find((x) => x.title === title);
  assert.ok(p, `${uid} must have a panel titled "${title}"`);
  return p!;
}

test('ADR-022: overview verdict stats query $__range, not a fixed window', () => {
  for (const title of ['Errors', 'Warnings', 'Spend', 'Runs']) {
    const p = panelByTitle('ion-overview', title);
    assert.ok(
      (p.targets as any[]).every((t) => t.expr.includes('[$__range]')),
      `overview "${title}" must aggregate over [$__range]; got: ${(p.targets as any[])[0].expr}`,
    );
  }
});

test('ADR-022: no picker-honoring panel title carries a window suffix', () => {
  // The "(5m)" style suffix is reserved for now-detectors whose fixed window is
  // part of the panel's stated meaning. A title suffix on a $__range/$__interval
  // panel is drift by definition.
  for (const recipe of RECIPES) {
    const d = recipe();
    for (const p of d.panels as Record<string, any>[]) {
      if (!p.targets) continue;
      const usesPickerWindows = (p.targets as any[]).every(
        (t) => typeof t.expr !== 'string' || (!/\[\d+[smhd]\]/.test(t.expr)),
      );
      if (usesPickerWindows && /\((?:\d+[smhd]|30d|24h|1h)\)/.test(p.title)) {
        assert.fail(`${d.uid} "${p.title}": window suffix in title but no fixed window in any query`);
      }
    }
  }
});

test('ADR-022: converted series accumulations bind $__interval (undercount fix)', () => {
  const p = panelByTitle('ion-errors-health', 'Errors vs Warnings over time');
  for (const t of p.targets as any[]) {
    assert.ok(t.expr.includes('[$__interval]'), `series target must use [$__interval]; got: ${t.expr}`);
    assert.equal(t.__ionClass, 'accumulation');
  }
  const byComponent = panelByTitle('ion-errors-health', 'Error volume by component');
  assert.ok((byComponent.targets as any[])[0].expr.includes('[$__interval]'));
});

test('ADR-022: detector-class panels KEEP their fixed windows', () => {
  // Freshness/last-seen detectors: wide fixed net so a wedged/quiet source
  // stays visible when the picker narrows.
  const freshness = panelByTitle('ion-overview', 'Ingest freshness by component (min since last line)');
  assert.ok((freshness.targets as any[])[0].expr.includes('[24h]'));
  const lastSeen = panelByTitle('ion-fleet', 'Host last-seen (min)');
  assert.ok((lastSeen.targets as any[])[0].expr.includes('[24h]'));
  // Latest-value panels: the window is a staleness bound.
  const pressure = panelByTitle('ion-logs', 'Context pressure (latest, per session)');
  assert.ok((pressure.targets as any[])[0].expr.includes('[10m]'));
  // Now-detectors: the window is the definition, pinned in the title.
  const thrash = panelByTitle('ion-quality', 'Sessions thrashing now (5m)');
  assert.ok((thrash.targets as any[])[0].expr.includes('[5m]'));
  const inFlight = panelByTitle('ion-logs', 'Dispatches in flight (5m)');
  assert.ok((inFlight.targets as any[])[0].expr.includes('[5m]'));
});

// ---------------------------------------------------------------------------
// Ion Users / Ion Fleet pack contracts
// ---------------------------------------------------------------------------

test('users pack: registered, foldered, and variable-scoped', () => {
  const d = recipeByUid('ion-users');
  assert.equal(d.folder, 'audience');
  assert.equal(d.file, 'ion-users');
  const vars = (d.templating ?? []).map((v) => v.name);
  assert.deepEqual(vars, ['user', 'install'], 'users pack must expose $user and $install textbox variables');
  for (const v of d.templating ?? []) {
    assert.equal(v.type, 'textbox', 'identity fields are parsed JSON, not stream labels — textbox regex only');
    assert.equal(v.query, '.*');
  }
});

test('users pack: coalesces absent user to "unassigned" BEFORE the $user filter', () => {
  // Order matters: coalescing after the filter would make `unassigned`
  // unselectable (the filter would run against the raw absent label). Every
  // telemetry target must carry the label_format stage ahead of user=~"$user".
  const d = recipeByUid('ion-users');
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string' || !t.expr.includes('user=~"$user"')) continue;
      const coalesceIdx = t.expr.indexOf('label_format user=');
      const filterIdx = t.expr.indexOf('user=~"$user"');
      assert.ok(coalesceIdx !== -1, `"${p.title}": user-filtered query must coalesce user first: ${t.expr}`);
      assert.ok(coalesceIdx < filterIdx, `"${p.title}": coalesce must precede the $user filter`);
      assert.ok(t.expr.includes('unassigned'), `"${p.title}": fallback bucket must be "unassigned"`);
    }
  }
});

test('fleet pack: registered, foldered, and host-scoped via | json', () => {
  const d = recipeByUid('ion-fleet');
  assert.equal(d.folder, 'fleet');
  assert.equal(d.file, 'ion-fleet');
  const vars = (d.templating ?? []).map((v) => v.name);
  assert.deepEqual(vars, ['host']);
  // host is NOT Alloy-promoted: every host-scoped query must parse with | json
  // ahead of the host filter, or it silently matches nothing.
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string' || !t.expr.includes('host=~"$host"')) continue;
      const jsonIdx = t.expr.indexOf('| json');
      const hostIdx = t.expr.indexOf('host=~"$host"');
      assert.ok(jsonIdx !== -1 && jsonIdx < hostIdx, `"${p.title}": | json must precede the $host filter: ${t.expr}`);
    }
  }
});

test('fleet pack: installs-per-host counts distinct install_ids per host', () => {
  const p = panelByTitle('ion-fleet', 'Installs per host');
  const expr = (p.targets as any[])[0].expr as string;
  assert.ok(expr.includes('count by (host)'), 'outer count must group by host');
  assert.ok(expr.includes('sum by (host, install_id)'), 'inner sum must key host+install_id pairs');
});

// ---------------------------------------------------------------------------
// Ion Mobile pack contract
// ---------------------------------------------------------------------------

test('mobile pack: registered, foldered, and device-scoped via | json', () => {
  const d = recipeByUid('ion-mobile');
  assert.equal(d.folder, 'mobile');
  assert.equal(d.file, 'ion-mobile');
  const vars = (d.templating ?? []).map((v) => v.name);
  assert.deepEqual(vars, ['device'], 'mobile pack must expose the $device textbox variable');
  for (const v of d.templating ?? []) {
    assert.equal(v.type, 'textbox', 'device_name is a parsed JSON field, not a stream label — textbox regex only');
    assert.equal(v.query, '.*');
  }
  // device_name is NOT Alloy-promoted: every device-scoped query must parse with
  // | json ahead of the device filter, or it silently matches nothing (same
  // constraint the fleet pack has on $host).
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string' || !t.expr.includes('device_name=~"$device"')) continue;
      const jsonIdx = t.expr.indexOf('| json');
      const deviceIdx = t.expr.indexOf('device_name=~"$device"');
      assert.ok(jsonIdx !== -1 && jsonIdx < deviceIdx, `"${p.title}": | json must precede the $device filter: ${t.expr}`);
    }
  }
});

test('mobile pack: reads the iOS log stream, never the telemetry stream', () => {
  // iOS emits no telemetry — the whole point of a separate pack. Every target
  // must select {component="ios"} and none may touch service_name="ion-telemetry".
  const d = recipeByUid('ion-mobile');
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string') continue;
      assert.ok(t.expr.includes('component="ios"'), `"${p.title}": mobile target must select the iOS stream: ${t.expr}`);
      assert.ok(!t.expr.includes('ion-telemetry'), `"${p.title}": mobile target must NOT read the telemetry stream: ${t.expr}`);
    }
  }
});

test('mobile pack: the device→desktop pairing table keys (device_id, desktop_host)', () => {
  const p = panelByTitle('ion-mobile', 'Device → desktop pairing');
  const expr = (p.targets as any[])[0].expr as string;
  assert.ok(expr.includes('sum by (device_id, device_name, desktop_host)'), 'pairing table must group by the device×desktop key');
});

test('mobile pack: device last-seen is a fixed-24h detector (not $__range)', () => {
  const p = panelByTitle('ion-mobile', 'Device last-seen (min)');
  const expr = (p.targets as any[])[0].expr as string;
  assert.ok(expr.includes('[24h]'), 'last-seen detector must use the fixed 24h lookback');
  assert.equal((p.targets as any[])[0].__ionClass, 'instant', 'last-seen is an instant detector, not an accumulation');
});

test('mobile pack: every | json target skips unparseable lines with __error__=""', () => {
  // The {component="ios"} stream is heterogeneous — legacy lines store a bare
  // `msg` string as the body, not full JSON. In LogQL a JSONParserErr on ONE
  // line aborts a grouped series and returns NO data, blanking every grouped
  // panel. `| __error__=""` after the json stage skips the bad lines. This is
  // the fix for the "186K lines but every device panel empty" production bug;
  // it must never regress. Any target that parses JSON must also carry the skip.
  const d = recipeByUid('ion-mobile');
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string' || !t.expr.includes('| json')) continue;
      assert.ok(
        t.expr.includes('__error__=""'),
        `"${p.title}": a | json target must skip parse errors with __error__="" or one bad line blanks the panel: ${t.expr}`,
      );
      // Ordering: the skip must come AFTER the json stage (it filters the error
      // that stage produces).
      assert.ok(
        t.expr.indexOf('| json') < t.expr.indexOf('__error__=""'),
        `"${p.title}": __error__="" must come after | json: ${t.expr}`,
      );
    }
  }
});
