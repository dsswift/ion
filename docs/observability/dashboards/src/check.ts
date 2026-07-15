// Drift + structural-audit gate (the CI check).
//
// Three independent checks, all must pass:
//
//   1. DRIFT — regenerate every dashboard JSON and queries.md in memory and
//      byte-compare against the committed files. Any hand-edit to a committed
//      JSON, or any query-module change not re-generated, fails here.
//
//   2. ORPHANS — every committed dashboard JSON under the provisioning tree must
//      correspond to a recipe. A committed dashboard with no recipe (or a recipe
//      whose output path is missing) is flagged, so no dashboard escapes the
//      drift gate.
//
//   3. STRUCTURAL OVERCOUNT AUDIT — walk the emitted JSON and assert that no
//      range-evaluated accumulation target carries a fixed window. This re-checks
//      the class invariant purely from emitted JSON (via the __ionClass stamp),
//      catching any raw-JSON escape hatch that bypassed the panel builders. It is
//      the belt-and-suspenders complement to the compile-time builder guard.
//
// Run: npm run check   (exit 1 on any failure)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAll } from './generate.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBS_ROOT = join(HERE, '..', '..');
const DASH_ROOT = join(OBS_ROOT, 'grafana', 'provisioning', 'dashboards');
const QUERIES_MD = join(OBS_ROOT, 'queries.md');

interface Failure {
  readonly check: string;
  readonly detail: string;
}

// --- 1. DRIFT ---------------------------------------------------------------

function checkDrift(): Failure[] {
  const failures: Failure[] = [];
  const result = buildAll(DASH_ROOT, QUERIES_MD);

  for (const { path, content } of result.dashboards) {
    if (!existsSync(path)) {
      failures.push({ check: 'drift', detail: `missing committed dashboard: ${rel(path)} (run npm run generate)` });
      continue;
    }
    const committed = readFileSync(path, 'utf8');
    if (committed !== content) {
      failures.push({ check: 'drift', detail: `${rel(path)} differs from generated output (run npm run generate; do not hand-edit committed JSON)` });
    }
  }

  if (!existsSync(QUERIES_MD)) {
    failures.push({ check: 'drift', detail: `missing queries.md (run npm run generate)` });
  } else if (readFileSync(QUERIES_MD, 'utf8') !== result.queriesMd.content) {
    failures.push({ check: 'drift', detail: `queries.md differs from generated output (run npm run generate)` });
  }

  return failures;
}

// --- 2. ORPHANS -------------------------------------------------------------

function walkJson(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walkJson(p));
    else if (name.endsWith('.json')) out.push(p);
  }
  return out;
}

function checkOrphans(): Failure[] {
  const failures: Failure[] = [];
  const generated = new Set(buildAll(DASH_ROOT, QUERIES_MD).dashboards.map((d) => d.path));
  for (const committed of walkJson(DASH_ROOT)) {
    if (!generated.has(committed)) {
      failures.push({ check: 'orphan', detail: `${rel(committed)} has no recipe — every committed dashboard must be generated (add a recipe to dashboards/index.ts)` });
    }
  }
  return failures;
}

// --- 3. STRUCTURAL OVERCOUNT AUDIT -----------------------------------------

// Recursively collect every target object (has expr + __ionClass) in a value.
function collectTargets(v: unknown, acc: Record<string, unknown>[]): void {
  if (Array.isArray(v)) {
    for (const item of v) collectTargets(item, acc);
  } else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.expr === 'string' && typeof o.__ionClass === 'string') acc.push(o);
    for (const val of Object.values(o)) collectTargets(val, acc);
  }
}

const FIXED_WINDOW = /\[\d+[smhd]\]/;

export function auditOvercount(json: Record<string, unknown>): string[] {
  const targets: Record<string, unknown>[] = [];
  collectTargets(json.panels, targets);
  const violations: string[] = [];
  for (const t of targets) {
    const cls = t.__ionClass as string;
    const mode = t.queryType as string;
    const expr = t.expr as string;
    if (cls === 'accumulation' && mode === 'range' && FIXED_WINDOW.test(expr)) {
      violations.push(`range accumulation with fixed window: ${expr}`);
    }
  }
  return violations;
}

function checkStructuralAudit(): Failure[] {
  const failures: Failure[] = [];
  for (const path of walkJson(DASH_ROOT)) {
    const json = JSON.parse(readFileSync(path, 'utf8'));
    for (const v of auditOvercount(json)) {
      failures.push({ check: 'overcount-audit', detail: `${rel(path)}: ${v}` });
    }
  }
  return failures;
}

function rel(p: string): string {
  return p.replace(OBS_ROOT + '/', '');
}

function main(): void {
  const failures = [...checkDrift(), ...checkOrphans(), ...checkStructuralAudit()];
  if (failures.length === 0) {
    console.log('dashboards check: PASS (drift clean, no orphans, overcount audit clean)');
    return;
  }
  console.error(`dashboards check: FAIL (${failures.length} issue(s))\n`);
  for (const f of failures) console.error(`  [${f.check}] ${f.detail}`);
  console.error('\nFix: edit docs/observability/dashboards, run `npm run generate`, and commit both.');
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
