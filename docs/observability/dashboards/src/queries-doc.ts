// Generated queries.md renderer.
//
// Renders the canonical query registry into the reference doc. The header states
// the file is generated; check.ts byte-diffs it so it cannot drift from the
// query module. Only NAMED queries (registered via registerQuery) appear here —
// they are the reusable, reconciliation-relevant calculations worth documenting.

import type { RegisteredQuery } from './queries.ts';

const CLASS_BLURB: Record<RegisteredQuery['cls'], string> = {
  accumulation:
    'Accumulation (sum/count_over_time). On a timeseries the window is $__interval so the series integrates to the true range total; on a stat/pie it is a fixed window evaluated instant.',
  'windowed-stat':
    'Windowed statistic (quantile/avg/max/last_over_time or a deliberate rolling count). The fixed rolling window is intrinsic to the calculation and is pinned in the panel title.',
  instant: 'Instant snapshot (ranked/pie/table), evaluated once over a fixed window.',
};

export function renderQueriesDoc(queries: readonly RegisteredQuery[]): string {
  const lines: string[] = [];
  lines.push('# Ion Telemetry Query Reference');
  lines.push('');
  lines.push(
    '> **Generated file — do not edit by hand.** This document is emitted by ' +
      '`docs/observability/dashboards` (`npm run generate`). Every expression below is ' +
      'defined once in the canonical query module and shared by the dashboard panels, so the ' +
      'reference cannot drift from what the dashboards actually run. Edit the query module and ' +
      'regenerate; `make check-dashboards` fails on drift.',
  );
  lines.push('');
  lines.push(
    'All queries are LogQL targeting the Loki datasource. Field names are snake_case ' +
      'structured-metadata keys promoted by Alloy from the NDJSON telemetry log. See ' +
      '[`log-schema.md`](log-schema.md) for the full field reference.',
  );
  lines.push('');
  lines.push('## Query classes');
  lines.push('');
  lines.push('Every expression declares a query class. The class is what the panel builders enforce:');
  lines.push('');
  lines.push('| Class | Meaning |');
  lines.push('|-------|---------|');
  lines.push(`| \`accumulation\` | ${CLASS_BLURB.accumulation} |`);
  lines.push(`| \`windowed-stat\` | ${CLASS_BLURB['windowed-stat']} |`);
  lines.push(`| \`instant\` | ${CLASS_BLURB.instant} |`);
  lines.push('');
  lines.push('## Canonical calculations');
  lines.push('');

  for (const q of queries) {
    lines.push(`### ${q.name}`);
    lines.push('');
    lines.push(`**Class:** \`${q.cls}\`${q.window ? ` &nbsp; **Window:** \`${q.window}\`` : ''}`);
    lines.push('');
    lines.push(q.commentary);
    lines.push('');
    lines.push('```logql');
    lines.push(q.expr);
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}
