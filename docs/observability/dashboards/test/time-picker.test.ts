// Contract tests for the dashboards-as-code generator: the time-picker window
// policy (ADR-022). Split from generator.test.ts at its section boundary; run
// with `npm test` (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { stat } from '../src/panels.ts';
import { instant } from '../src/queries.ts';
import { buildDashboard, scopeToIdentity } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';
import { overviewDashboard } from '../src/dashboards/overview.ts';

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
  // 2026-09-28: the dollar "Spend" tile was removed from the overview (cost is
  // a downstream effect of usage, not an operational signal; it stays in the
  // Cost pack) — see overview.ts's header comment.
  for (const title of ['Errors', 'Warnings', 'Runs']) {
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
  // $user is the global identity dropdown (dashboard.ts IDENTITY_VARS);
  // install_id is not a stream label, so it stays a textbox regex.
  const vars = (d.templating ?? []).map((v) => v.name);
  assert.deepEqual(vars, ['install'], 'users pack keeps only its $install textbox; $user is global');
  for (const v of d.templating ?? []) {
    assert.equal(v.type, 'textbox');
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
  // $host is the global identity dropdown; the recipe declares none of its own.
  assert.deepEqual((d.templating ?? []).map((v) => v.name), []);
  // The device is the host_name stream label the identity matchers scope, so
  // no fleet query filters a parsed body host.
  for (const p of d.panels as Record<string, any>[]) {
    for (const t of (p.targets ?? []) as any[]) {
      if (typeof t.expr === 'string') assert.ok(!/\|\s*host\s*=~/.test(t.expr), `"${p.title}": filters a parsed host: ${t.expr}`);
    }
  }
});

test('fleet pack: installs-per-host counts distinct installs per host', () => {
  const p = panelByTitle('ion-fleet', 'Installs per host');
  const expr = (p.targets as any[])[0].expr as string;
  assert.ok(expr.includes('count by (host_name)'), 'outer count must group by host');
  assert.ok(expr.includes('sum by (host_name, service_instance_id)'), 'inner sum must key host+install pairs');
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
  // must select the ion-ios log stream and none may select telemetry.
  const d = recipeByUid('ion-mobile');
  for (const p of d.panels as Record<string, any>[]) {
    if (!p.targets) continue;
    for (const t of p.targets as any[]) {
      if (typeof t.expr !== 'string') continue;
      assert.ok(t.expr.includes('{service_name="ion-ios", event_name=""'), `"${p.title}": mobile target must select the iOS stream: ${t.expr}`);
      assert.ok(!/event_name=~?"[^"]/.test(t.expr), `"${p.title}": mobile target must NOT read the telemetry stream: ${t.expr}`);
    }
  }
});

test('mobile pack: the device→server pairing table keys (device_id, desktop_host)', () => {
  const p = panelByTitle('ion-mobile', 'Device → server pairing');
  const expr = (p.targets as any[])[0].expr as string;
  assert.ok(expr.includes('sum by (device_id, device_model,') && expr.includes('desktop_host)'), 'pairing table must group by the device×desktop key');
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

// ---------------------------------------------------------------------------
// Fleet identity: every dashboard slices by device and person
// ---------------------------------------------------------------------------

test('every dashboard carries the Device and User dropdowns first', () => {
  for (const recipe of RECIPES) {
    const built = buildDashboard(recipe()) as Record<string, any>;
    const vars = built.templating.list as Record<string, any>[];
    assert.deepEqual(vars.slice(0, 2).map((v) => v.name), ['host', 'user'], `${built.uid}: identity vars first`);
    for (const v of vars.slice(0, 2)) {
      assert.equal(v.type, 'query');
      assert.equal(v.query, `label_values(${v.name === 'host' ? 'host_name' : v.name})`);
      assert.equal(v.allValue, '.*', 'All must also match lines with no identity label');
      assert.equal(v.multi, true);
    }
    assert.equal(new Set(vars.map((v) => v.name)).size, vars.length, `${built.uid}: no duplicate variable names`);
  }
});

test('every stream selector in every query and annotation is scoped to $host and $user', () => {
  const selector = /(?<!\{)\{\s*[a-zA-Z_]\w*\s*(?:=~|!~|!=|=)\s*"[^}]*\}/g;
  for (const recipe of RECIPES) {
    const built = buildDashboard(recipe()) as Record<string, any>;
    const exprs: string[] = [];
    const walk = (panels: any[]): void => {
      for (const p of panels) {
        for (const t of p.targets ?? []) if (typeof t.expr === 'string') exprs.push(t.expr);
        if (Array.isArray(p.panels)) walk(p.panels);
      }
    };
    walk(built.panels);
    for (const a of built.annotations.list) if (typeof a.expr === 'string') exprs.push(a.expr);
    for (const expr of exprs) {
      for (const m of expr.match(selector) ?? []) {
        assert.ok(m.includes('host_name=~"$host"') && m.includes('user=~"$user"'), `${built.uid}: unscoped selector ${m} in ${expr}`);
      }
    }
  }
});

test('scopeToIdentity leaves label_format templates alone and never double-scopes', () => {
  assert.equal(
    scopeToIdentity('{service_name="${service}"} | json | label_format x="{{.y}}"'),
    '{service_name="${service}", host_name=~"$host", user=~"$user"} | json | label_format x="{{.y}}"',
  );
  assert.equal(scopeToIdentity('{host_name="a", event_name="x"}'), '{host_name="a", event_name="x"}');
});

test('every dashboard defines each variable its queries use', () => {
  // Grafana leaves an undefined $name as literal text, which matches nothing and
  // renders a zero. buildDashboard refuses to emit one.
  for (const recipe of RECIPES) assert.doesNotThrow(() => buildDashboard(recipe()));
});

test('a query that uses a variable the dashboard does not define fails the build', () => {
  const d = overviewDashboard();
  const bad = {
    ...d,
    panels: [
      ...d.panels,
      stat({ id: 999, title: 'undefined var', gridPos: { h: 1, w: 1, x: 0, y: 99 }, targets: [{ e: instant('sum(count_over_time({event_name=~".+"} | json | x=~"$nope" [$__range]))', '$__range') }] }),
    ],
  };
  assert.throws(() => buildDashboard(bad), /ion-overview: queries use variables the dashboard does not define: nope/);
});
