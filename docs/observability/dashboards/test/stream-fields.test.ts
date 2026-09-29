// Operational log lines and telemetry events have different shapes. Only a
// telemetry event carries a `context` object (context_conversation_id,
// context_session_id); an operational line carries its correlation ids at the
// top level (conversation_id, session_id). A log-stream query that filters on a
// context_* key matches nothing once the filter value is set.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboard } from '../src/dashboard.ts';
import { RECIPES } from '../src/dashboards/index.ts';

function exprs(v: unknown, out: string[]): string[] {
  if (Array.isArray(v)) for (const x of v) exprs(x, out);
  else if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.expr === 'string') out.push(o.expr);
    for (const x of Object.values(o)) exprs(x, out);
  }
  return out;
}

test('no operational-log query reads a telemetry-only context_* key', () => {
  const offenders: string[] = [];
  for (const recipe of RECIPES) {
    const d = buildDashboard(recipe());
    for (const e of exprs(d.panels, [])) {
      // Split on selectors so a query mixing both streams is judged per stream.
      for (const part of e.split(/(?=\{(?:service_name|event_name|level)\b)/)) {
        const telemetry = /^\{event_name=~?"[^"]/.test(part);
        if (!telemetry && part.startsWith('{') && /\|\s*context_\w+\s*(=|!=|=~|!~)/.test(part)) offenders.push(`${d.uid}: ${e}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
