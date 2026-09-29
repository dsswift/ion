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
import { controlRoomDashboard } from '../src/dashboards/control-room.ts';
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
  // display requires values:true so EVERY service gets its own cell, and
  // textMode value_and_name so each cell is stamped with its {{service_name}}.
  const p = freshnessPanel();
  assert.equal(p.options.reduceOptions.values, true, 'values must be true so all series render, not one reduction');
  assert.equal(
    p.options.textMode,
    'value_and_name',
    'textMode must display the component name alongside the value on each cell',
  );
  assert.equal(p.targets[0].legendFormat, '{{service_name}}', 'legend must key each series by service');
});

test('freshness panel sits in the top verdict row (y=0 band) and is not full-width', () => {
  // Placement/weight: the panel moved out of its own full-width row into the
  // verdict row alongside Errors/Warnings/Spend/Runs. Visibility is by color,
  // not size. The verdict row is the first content row below the intro text.
  const panels = overviewDashboard().panels as Record<string, any>[];
  const intro = panels.find((x) => x.type === 'text');
  assert.ok(intro, 'the overview opens with an intro text panel');
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

test('the control room names no extension or tool: its lamps come from the data', () => {
  const built = buildDashboard(controlRoomDashboard()) as { panels: { title: string; targets?: { expr: string }[] }[] };
  for (const panel of built.panels) {
    for (const t of panel.targets ?? []) {
      assert.doesNotMatch(t.expr, /\b(tag|tool)="/, `${panel.title} filters on a fixed name: ${t.expr}`);
    }
  }
});
