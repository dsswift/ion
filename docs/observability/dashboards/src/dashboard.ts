// Dashboard envelope assembly.
//
// Every recipe returns a `Dashboard` describing its identity, layout, and
// panels. `buildDashboard` wraps that into the full Grafana dashboard JSON
// object with the standard top-level fields, so the recipes carry only what is
// distinctive about each pack. The emitted key order here is fixed, which keeps
// generated JSON byte-stable across runs (the check.ts contract).

import { LOKI } from './types.ts';

export interface TemplateVar {
  readonly name: string;
  readonly label: string;
  readonly type: 'query' | 'textbox';
  readonly description?: string;
  readonly query?: string;
  readonly current?: Record<string, unknown>;
  readonly datasource?: typeof LOKI;
  readonly refresh?: number;
  readonly includeAll?: boolean;
  readonly allValue?: string;
  readonly hide?: number;
}

export interface Annotation {
  readonly name: string;
  readonly expr?: string;
  readonly rawQuery?: string;
  readonly iconColor: string;
  readonly titleFormat: string;
  readonly type?: string;
  readonly step?: string;
}

export interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly schemaVersion: number;
  readonly version: number;
  readonly refresh: string | false;
  readonly timeFrom: string;
  readonly graphTooltip?: number;
  readonly panels: readonly Record<string, unknown>[];
  readonly templating?: readonly TemplateVar[];
  readonly annotations?: readonly Annotation[];
  // Folder path under the provisioning tree (relative to dashboards/), e.g.
  // "cost" -> cost/ion-cost.json. Empty string emits at the tree root.
  readonly folder: string;
  // File basename without extension, e.g. "ion-cost".
  readonly file: string;
}

function emitTemplateVar(v: TemplateVar): Record<string, unknown> {
  const out: Record<string, unknown> = { name: v.name, label: v.label, type: v.type };
  if (v.description !== undefined) out.description = v.description;
  if (v.datasource !== undefined) out.datasource = v.datasource;
  if (v.query !== undefined) out.query = v.query;
  if (v.refresh !== undefined) out.refresh = v.refresh;
  if (v.includeAll !== undefined) out.includeAll = v.includeAll;
  if (v.allValue !== undefined) out.allValue = v.allValue;
  out.current = v.current ?? {};
  if (v.hide !== undefined) out.hide = v.hide;
  return out;
}

function emitAnnotation(a: Annotation): Record<string, unknown> {
  const out: Record<string, unknown> = {
    datasource: LOKI,
    enable: true,
    hide: false,
    iconColor: a.iconColor,
    name: a.name,
    titleFormat: a.titleFormat,
  };
  if (a.type !== undefined) out.type = a.type;
  if (a.rawQuery !== undefined) out.rawQuery = a.rawQuery;
  if (a.expr !== undefined) out.expr = a.expr;
  if (a.step !== undefined) out.step = a.step;
  return out;
}

export function buildDashboard(d: Dashboard): Record<string, unknown> {
  return {
    annotations: { list: (d.annotations ?? []).map(emitAnnotation) },
    description: d.description,
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: d.graphTooltip ?? 0,
    id: null,
    links: [],
    panels: d.panels,
    refresh: d.refresh,
    schemaVersion: d.schemaVersion,
    tags: d.tags,
    templating: { list: (d.templating ?? []).map(emitTemplateVar) },
    time: { from: d.timeFrom, to: 'now' },
    timepicker: {},
    timezone: 'browser',
    title: d.title,
    uid: d.uid,
    version: d.version,
  };
}
