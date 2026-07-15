// Dashboard generator.
//
// Emits every recipe's dashboard JSON into the provisioning tree and regenerates
// queries.md from the canonical query registry. The committed JSONs are the
// provisioned artifacts; this is the build step that produces them. check.ts
// regenerates to a temp dir and byte-diffs against the committed copies.
//
// Run: npm run generate   (writes in place)
//      node src/generate.ts --out <dir>   (writes to an alternate root)

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard, type Dashboard } from './dashboard.ts';
import { RECIPES } from './dashboards/index.ts';
import { renderQueriesDoc } from './queries-doc.ts';
import { registeredQueries } from './queries.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// dashboards/src -> docs/observability
const OBS_ROOT = join(HERE, '..', '..');
const DASH_ROOT = join(OBS_ROOT, 'grafana', 'provisioning', 'dashboards');
const QUERIES_MD = join(OBS_ROOT, 'queries.md');

// Canonical JSON serialization: 2-space indent, trailing newline. This is the
// byte-stable contract check.ts diffs against.
export function serialize(obj: unknown): string {
  return JSON.stringify(obj, null, 2) + '\n';
}

export function dashboardPath(root: string, d: Dashboard): string {
  return d.folder ? join(root, d.folder, `${d.file}.json`) : join(root, `${d.file}.json`);
}

export interface GenerateResult {
  readonly dashboards: { path: string; content: string }[];
  readonly queriesMd: { path: string; content: string };
}

// Build all artifacts in memory (no writes). Used by both generate and check.
export function buildAll(dashRoot: string, queriesMdPath: string): GenerateResult {
  const dashboards = RECIPES.map((recipe) => {
    const d = recipe();
    return { path: dashboardPath(dashRoot, d), content: serialize(buildDashboard(d)) };
  });
  // queries.md is rendered after all recipes have run, so the registry is full.
  const queriesMd = { path: queriesMdPath, content: renderQueriesDoc(registeredQueries()) };
  return { dashboards, queriesMd };
}

function writeArtifact(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function main(): void {
  const outArg = process.argv.indexOf('--out');
  const dashRoot = outArg >= 0 ? join(process.argv[outArg + 1], 'grafana', 'provisioning', 'dashboards') : DASH_ROOT;
  const qmdPath = outArg >= 0 ? join(process.argv[outArg + 1], 'queries.md') : QUERIES_MD;

  const result = buildAll(dashRoot, qmdPath);
  for (const { path, content } of result.dashboards) {
    writeArtifact(path, content);
    console.log(`wrote ${path}`);
  }
  writeArtifact(result.queriesMd.path, result.queriesMd.content);
  console.log(`wrote ${result.queriesMd.path}`);
  console.log(`\n${result.dashboards.length} dashboards + queries.md generated.`);
}

// Only run when invoked directly (not when imported by check.ts).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
