// Every stream label a dashboard selects on must be one the local collector
// produces, and one the fleet OTLP config in central-log-collection.md
// produces. A selector on a label nothing emits matches no stream, and an
// empty panel looks exactly like a quiet system: dashboards once selected
// service_name="ion-telemetry", which no OTLP-shipped record carried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { buildDashboard } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVABILITY = join(HERE, '..', '..');
const REPO = join(OBSERVABILITY, '..', '..');

/** Labels an Alloy config promotes: the keys of every `stage.labels` block. */
function promotedLabels(alloy: string): Set<string> {
  const out = new Set<string>();
  for (const block of alloy.matchAll(/stage\.labels\s*\{\s*values\s*=\s*\{([^}]*)\}/g)) {
    for (const m of block[1].matchAll(/^\s*"?([a-z_]+)"?\s*=/gm)) out.add(m[1]);
  }
  return out;
}

/** Labels the local stack produces: Alloy's promoted labels plus the forwarder's stream label. */
function producedLabels(): Set<string> {
  const out = promotedLabels(readFileSync(join(OBSERVABILITY, 'alloy-config.alloy'), 'utf8'));
  const forwarder = readFileSync(join(REPO, 'engine', 'internal', 'telemetryforwarder', 'forwarder.go'), 'utf8');
  for (const m of forwarder.matchAll(/map\[string\]string\{"([a-z_]+)":/g)) out.add(m[1]);
  return out;
}

/** Labels the fleet Alloy config in docs/enterprise/central-log-collection.md promotes from OTLP. */
function fleetLabels(): Set<string> {
  const guide = readFileSync(join(REPO, 'docs', 'enterprise', 'central-log-collection.md'), 'utf8');
  const block = guide.match(/```alloy\n(\/\/ alloy-fleet-config\.alloy[\s\S]*?)```/);
  assert.ok(block, 'central-log-collection.md has no alloy-fleet-config.alloy block');
  return promotedLabels(block[1]);
}

// Loki expressions only: a PromQL target (datasource type prometheus) selects
// on Prometheus series labels, which no log collector produces.
function exprs(v: unknown, out: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) exprs(x, out);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ((o.datasource as Record<string, unknown> | undefined)?.type === 'prometheus') return out;
    for (const k of ['expr', 'rawQuery']) if (typeof o[k] === 'string') out.push(o[k] as string);
    for (const x of Object.values(o)) exprs(x, out);
  }
  return out;
}

/** Every stream label a dashboard selects on, as `uid: label`. */
function selectedLabels(): string[] {
  const selector = /\{(\s*[a-zA-Z_]\w*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*[a-zA-Z_]\w*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\]|\\.)*")*\s*)\}/g;
  const out: string[] = [];
  for (const recipe of RECIPES) {
    const d = buildDashboard(recipe());
    for (const e of exprs([d.panels, d.annotations], [])) {
      for (const s of e.matchAll(selector)) {
        for (const m of s[1].matchAll(/([a-zA-Z_]\w*)\s*(?:=~|!~|!=|=)/g)) out.push(`${d.uid}: ${m[1]}`);
      }
    }
  }
  return out;
}

const REQUIRED = ['service_name', 'event_name', 'level', 'tag', 'host_name', 'user'];

function unproduced(produced: Set<string>): string[] {
  return [...new Set(selectedLabels().filter((s) => !produced.has(s.slice(s.indexOf(': ') + 2))))];
}

test('every label a dashboard selects on is one the local collector produces', () => {
  const produced = producedLabels();
  for (const want of REQUIRED) assert.ok(produced.has(want), `collector does not produce ${want}: ${[...produced]}`);
  assert.deepEqual(unproduced(produced), []);
});

// The same dashboards import onto a fleet Loki fed by the guide's OTLP config,
// which once promoted no labels at all: every fleet panel was empty.
test('every label a dashboard selects on is one the central-log-collection fleet config produces', () => {
  const produced = fleetLabels();
  for (const want of REQUIRED) assert.ok(produced.has(want), `fleet config does not produce ${want}: ${[...produced]}`);
  assert.deepEqual(unproduced(produced), []);
});

test('a telemetry selector never names a service, and a log selector always excludes events', () => {
  for (const recipe of RECIPES) {
    const d = buildDashboard(recipe());
    for (const e of exprs([d.panels, d.annotations], [])) {
      for (const s of e.matchAll(/\{([^{}]*(?:service_name|event_name)[^{}]*)\}/g)) {
        const body = s[1];
        const telemetry = /event_name=~?"[^"]/.test(body);
        if (telemetry) assert.ok(!body.includes('service_name'), `${d.uid}: telemetry selector names a service: {${body}}`);
        else assert.ok(body.includes('event_name=""'), `${d.uid}: log selector lets telemetry in: {${body}}`);
      }
    }
  }
});
