// Azure Monitor flavor of the dashboard suite.
//
// Renders every recipe twice over: first the Loki dashboard exactly as
// generate.ts emits it, then its Azure twin (kql/dashboard.ts). The output is a
// folder a Grafana-as-code deployment can load as-is:
//
//   <out>/<folder>/<file>.json    e.g. ion/ion-cost.json
//
// The Loki tree's pack folders do not carry over: every dashboard lands in the
// target's one folder. The generator owns that folder; a stale JSON left in it
// is removed, and --check fails on it.
//
// Run: npm run generate:azure -- --target <config.json> --out <dir> [--check]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDashboard } from './dashboard.ts';
import { RECIPES } from './dashboards/index.ts';
import { serialize } from './generate.ts';
import { toAzure } from './kql/dashboard.ts';
import { loadTarget, type AzureTarget } from './kql/target.ts';

export interface AzureArtifact {
  readonly folder: string;
  readonly path: string;
  readonly content: string;
}

/** Build every Azure dashboard in memory, keyed by its path under `out`. */
export function buildAzure(out: string, target: AzureTarget): AzureArtifact[] {
  const folder = target.folder;
  return RECIPES.map((recipe) => {
    const d = recipe();
    return {
      folder,
      path: join(out, folder, `${d.file}.json`),
      content: serialize(toAzure(buildDashboard(d), target)),
    };
  });
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const targetPath = arg('--target');
  const out = arg('--out');
  if (!targetPath || !out) {
    console.error('usage: generate-azure.ts --target <config.json> --out <dir> [--check]');
    process.exit(2);
  }
  const check = process.argv.includes('--check');
  const artifacts = buildAzure(out, loadTarget(targetPath));
  const owned = new Set(artifacts.map((a) => a.folder));
  const expected = new Set(artifacts.map((a) => a.path));
  const problems: string[] = [];

  for (const folder of owned) {
    const dir = join(out, folder);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const p = join(dir, name);
      if (expected.has(p)) continue;
      if (check) problems.push(`stale dashboard with no recipe: ${p}`);
      else {
        rmSync(p);
        console.log(`removed ${p}`);
      }
    }
  }
  for (const a of artifacts) {
    if (check) {
      if (!existsSync(a.path) || readFileSync(a.path, 'utf8') !== a.content) problems.push(`out of date: ${a.path}`);
      continue;
    }
    mkdirSync(dirname(a.path), { recursive: true });
    writeFileSync(a.path, a.content, 'utf8');
    console.log(`wrote ${a.path}`);
  }
  if (check) {
    if (problems.length) {
      console.error(`azure dashboards check: FAIL\n${problems.map((p) => `  ${p}`).join('\n')}`);
      process.exit(1);
    }
    console.log(`azure dashboards check: PASS (${artifacts.length} dashboards)`);
    return;
  }
  console.log(`\n${artifacts.length} Azure dashboards generated.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
