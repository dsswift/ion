// Dashboard envelope assembly.
//
// Every recipe returns a `Dashboard` describing its identity, layout, and
// panels. `buildDashboard` wraps that into the full Grafana dashboard JSON
// object with the standard top-level fields, so the recipes carry only what is
// distinctive about each pack. The emitted key order here is fixed, which keeps
// generated JSON byte-stable across runs (the check.ts contract).

import { LOKI, PROMETHEUS } from './types.ts';

export interface TemplateVar {
  readonly name: string;
  readonly label: string;
  readonly type: 'query' | 'textbox';
  readonly description?: string;
  readonly query?: string;
  readonly current?: Record<string, unknown>;
  readonly datasource?: typeof LOKI | typeof PROMETHEUS;
  readonly refresh?: number;
  readonly includeAll?: boolean;
  readonly allValue?: string;
  readonly multi?: boolean;
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
  if (v.multi !== undefined) out.multi = v.multi;
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

// ---------------------------------------------------------------------------
// Fleet identity: every dashboard can be sliced by device and by person.
//
// Alloy stamps two stream labels on every line whatever its shape
// (`loki.process "ion_identity"` in alloy-config.alloy): `host_name` (OTLP
// host.name), the device
// it came from, and `user`, the signed-in operator. Each dashboard gets a
// Device and a User dropdown populated from those labels, and every stream
// selector in every query and annotation gets the matching matchers, here in
// one place rather than in each recipe. "All" is `.*`, which also matches a
// line with no identity label (a local file line, an anonymous install), so
// the default view loses nothing.
// ---------------------------------------------------------------------------

export const IDENTITY_VARS: readonly TemplateVar[] = [
  {
    name: 'host',
    label: 'Device',
    description: 'The device a line came from (label `host_name`, the OTLP host.name). Multi-select; All includes lines with no device.',
    type: 'query',
    datasource: LOKI,
    query: 'label_values(host_name)',
    refresh: 2,
    includeAll: true,
    allValue: '.*',
    multi: true,
    current: { selected: true, text: ['All'], value: ['$__all'] },
    hide: 0,
  },
  {
    name: 'user',
    label: 'User',
    description: 'The signed-in operator (Alloy label `user`). Multi-select; All includes lines with no identity.',
    type: 'query',
    datasource: LOKI,
    query: 'label_values(user)',
    refresh: 2,
    includeAll: true,
    allValue: '.*',
    multi: true,
    current: { selected: true, text: ['All'], value: ['$__all'] },
    hide: 0,
  },
];

const IDENTITY_MATCHERS = 'host_name=~"$host", user=~"$user"';

// A LogQL stream selector or a PromQL label selector (one grammar): `{` then
// one or more `name op "value"` matchers then `}`. A quoted value may contain
// `${var}` braces. A Go template in a label_format (`{{ .x }}`) never matches,
// because a matcher must open with a label name. On a Prometheus series the
// same two labels come from the OTLP resource: Tempo's span metrics carry
// `host.name` and `user` as dimensions (tempo-config.yaml) and Prometheus
// promotes `host.name` on the OTLP metrics export (prometheus.yml), each
// written `host_name`. A series with neither label still matches `.*`.
const SELECTOR = /\{(\s*[a-zA-Z_]\w*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\]|\\.)*"(?:\s*,\s*[a-zA-Z_]\w*\s*(?:=~|!~|!=|=)\s*"(?:[^"\\]|\\.)*")*\s*)\}/g;

/** Add the identity matchers to every selector in a LogQL or PromQL expression. */
export function scopeToIdentity(expr: string): string {
  return expr.replace(SELECTOR, (whole, matchers: string) =>
    /(^|[\s,])(host_name|user)\s*(=~|!~|!=|=)/.test(matchers) ? whole : `{${matchers.trimEnd()}, ${IDENTITY_MATCHERS}}`,
  );
}

/** Rewrite every `expr` in a panel tree (rows nest their panels). */
function scopePanels(panels: readonly unknown[]): unknown[] {
  return panels.map((p) => {
    if (!p || typeof p !== 'object') return p;
    const panel = { ...(p as Record<string, unknown>) };
    if (Array.isArray(panel.targets)) {
      panel.targets = panel.targets.map((t) => {
        const target = t as Record<string, unknown>;
        return typeof target.expr === 'string' ? { ...target, expr: scopeToIdentity(target.expr) } : target;
      });
    }
    if (Array.isArray(panel.panels)) panel.panels = scopePanels(panel.panels);
    return panel;
  });
}

// Grafana's own variables. Every other `$name` in a query must be one the
// dashboard defines: Grafana leaves an undefined one as literal text, which
// silently matches nothing.
const GRAFANA_VARS = /^__/;

function assertVariablesDefined(uid: string, defined: ReadonlySet<string>, body: unknown): void {
  const text = JSON.stringify(body);
  const missing = new Set<string>();
  for (const m of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const name = m[1] as string;
    if (!GRAFANA_VARS.test(name) && !defined.has(name)) missing.add(name);
  }
  if (missing.size) throw new Error(`${uid}: queries use variables the dashboard does not define: ${[...missing].sort().join(', ')}`);
}

export function buildDashboard(d: Dashboard): Record<string, unknown> {
  const own = (d.templating ?? []).filter((v) => !IDENTITY_VARS.some((i) => i.name === v.name));
  const panels = scopePanels(d.panels);
  const annotations = (d.annotations ?? []).map((a) => emitAnnotation(a.expr ? { ...a, expr: scopeToIdentity(a.expr) } : a));
  assertVariablesDefined(d.uid, new Set([...IDENTITY_VARS, ...own].map((v) => v.name)), { panels, annotations });
  return {
    annotations: { list: annotations },
    description: d.description,
    editable: true,
    fiscalYearStartMonth: 0,
    graphTooltip: d.graphTooltip ?? 0,
    id: null,
    links: [],
    panels,
    refresh: d.refresh,
    schemaVersion: d.schemaVersion,
    tags: d.tags,
    templating: { list: [...IDENTITY_VARS, ...own].map(emitTemplateVar) },
    time: { from: d.timeFrom, to: 'now' },
    timepicker: {},
    timezone: 'browser',
    title: d.title,
    uid: d.uid,
    version: d.version,
  };
}
