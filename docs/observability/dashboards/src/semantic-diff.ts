// Semantic diff for migration verification.
//
// Byte-diff is too strict for the migration step: the generator emits canonical
// formatting that differs from the hand-written originals (key order, spacing)
// while the QUERIES and PANEL SEMANTICS are identical. This tool extracts the
// meaningful shape of each dashboard — panel titles, types, target expressions,
// evaluation mode (instant vs range), and any [window] tokens — and compares two
// JSON files on that shape alone.
//
// Used at migration time to prove semantic identity for the already-correct
// packs, and to review that intended diffs (the overcount fixes) are exactly the
// panels we meant to change. Not part of the CI gate (check.ts byte-diff is);
// this is a developer/migration instrument. Run:
//
//   node src/semantic-diff.ts <committed.json> <generated.json>

import { readFileSync } from 'node:fs';

interface PanelShape {
  title: string;
  type: string;
  targets: TargetShape[];
}
interface TargetShape {
  expr: string;
  mode: string; // queryType or instant/range flag
  windows: string[]; // all [..] tokens in the expr
}

function windowsOf(expr: string): string[] {
  const m = expr.match(/\[[^\]]+\]/g);
  return m ? m.map((w) => w.slice(1, -1)) : [];
}

function targetShape(t: Record<string, unknown>): TargetShape {
  const expr = String(t.expr ?? '');
  let mode = String(t.queryType ?? '');
  if (!mode) {
    if (t.instant === true) mode = 'instant';
    else if (t.range === true) mode = 'range';
  }
  return { expr, mode, windows: windowsOf(expr) };
}

// Flatten nested row panels too (Grafana rows may embed panels[]).
function collectPanels(panels: unknown[]): PanelShape[] {
  const out: PanelShape[] = [];
  for (const raw of panels) {
    const p = raw as Record<string, unknown>;
    if (p.type === 'row') {
      if (Array.isArray(p.panels) && p.panels.length) out.push(...collectPanels(p.panels));
      continue;
    }
    if (p.type === 'text') continue; // prose, not semantic
    const targets = Array.isArray(p.targets) ? (p.targets as Record<string, unknown>[]) : [];
    out.push({
      title: String(p.title ?? ''),
      type: String(p.type ?? ''),
      targets: targets.map(targetShape),
    });
  }
  return out;
}

export function dashboardShape(json: Record<string, unknown>): PanelShape[] {
  const panels = Array.isArray(json.panels) ? json.panels : [];
  return collectPanels(panels);
}

export interface SemanticDiff {
  identical: boolean;
  changes: string[];
}

export function semanticDiff(a: Record<string, unknown>, b: Record<string, unknown>): SemanticDiff {
  const sa = dashboardShape(a);
  const sb = dashboardShape(b);
  const changes: string[] = [];

  const byTitleA = new Map(sa.map((p) => [p.title, p]));
  const byTitleB = new Map(sb.map((p) => [p.title, p]));

  for (const title of byTitleA.keys()) {
    if (!byTitleB.has(title)) changes.push(`panel removed: "${title}"`);
  }
  for (const title of byTitleB.keys()) {
    if (!byTitleA.has(title)) changes.push(`panel added: "${title}"`);
  }
  for (const [title, pa] of byTitleA) {
    const pb = byTitleB.get(title);
    if (!pb) continue;
    if (pa.type !== pb.type) changes.push(`panel "${title}": type ${pa.type} -> ${pb.type}`);
    const n = Math.max(pa.targets.length, pb.targets.length);
    for (let i = 0; i < n; i++) {
      const ta = pa.targets[i];
      const tb = pb.targets[i];
      if (!ta) { changes.push(`panel "${title}" target ${i}: added`); continue; }
      if (!tb) { changes.push(`panel "${title}" target ${i}: removed`); continue; }
      if (ta.expr !== tb.expr) changes.push(`panel "${title}" target ${i} expr:\n  - ${ta.expr}\n  + ${tb.expr}`);
      if (ta.mode !== tb.mode) changes.push(`panel "${title}" target ${i} mode: ${ta.mode} -> ${tb.mode}`);
      if (ta.windows.join(',') !== tb.windows.join(','))
        changes.push(`panel "${title}" target ${i} windows: [${ta.windows}] -> [${tb.windows}]`);
    }
  }

  return { identical: changes.length === 0, changes };
}

function main(): void {
  const [aPath, bPath] = process.argv.slice(2);
  if (!aPath || !bPath) {
    console.error('usage: node src/semantic-diff.ts <committed.json> <generated.json>');
    process.exit(2);
  }
  const a = JSON.parse(readFileSync(aPath, 'utf8'));
  const b = JSON.parse(readFileSync(bPath, 'utf8'));
  const { identical, changes } = semanticDiff(a, b);
  if (identical) {
    console.log(`SEMANTIC IDENTICAL: ${aPath} == ${bPath}`);
  } else {
    console.log(`SEMANTIC DIFF (${changes.length}): ${aPath} vs ${bPath}`);
    for (const c of changes) console.log(`  ${c}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main();
}
