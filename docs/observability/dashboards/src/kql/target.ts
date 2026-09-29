// Azure Monitor target configuration.
//
// Everything deployment-specific about the Azure flavor lives in one JSON file
// the deployment owns (not this repo): which Grafana data source to use, which
// Log Analytics resources to query, and the KQL that maps the deployment's
// landing tables onto the three Ion views. Changing the pipeline schema is an
// edit to `views` in that file, then a re-render.
//
// View contract (docs/observability/azure-monitor.md). The OTLP envelope's
// fields keep their Azure Monitor column names; Ion's own fields are snake_case.
//   IonTelemetry  TimeGenerated, event_name, RoleName, ServiceName, ServiceInstanceId,
//                 ServiceVersion, host_name, user, TraceId, SpanId, schema,
//                 payload (dynamic), context (dynamic), body (string)
//   IonLogs       TimeGenerated, level, RoleName, ServiceName, ServiceInstanceId,
//                 ServiceVersion, tag, msg, host_name, user, session_id,
//                 conversation_id, TraceId, SpanId, fields (dynamic), body (string)
//   IonSpans      TimeGenerated, Name, TraceId, SpanId, ParentSpanId, DurationMs,
//                 RoleName, ServiceName, ServiceInstanceId, host_name, user,
//                 session_id, conversation_id, attributes (dynamic)

import { readFileSync } from 'node:fs';

export interface AzureTarget {
  readonly datasource: { readonly type: string; readonly uid: string };
  readonly resources: readonly string[];
  // Folder uid every rendered dashboard lands in. The Loki tree's pack folders
  // collapse into it, so one deployment keeps the whole suite in one folder.
  readonly folder: string;
  readonly views: {
    readonly IonTelemetry: string;
    readonly IonLogs: string;
    readonly IonSpans: string;
  };
}

export type ViewName = keyof AzureTarget['views'];
const VIEW_NAMES: readonly ViewName[] = ['IonTelemetry', 'IonLogs', 'IonSpans'];

function need(ok: boolean, msg: string): void {
  if (!ok) throw new Error(`azure target: ${msg}`);
}

export function parseTarget(raw: unknown): AzureTarget {
  need(!!raw && typeof raw === 'object', 'must be a JSON object');
  const t = raw as Record<string, unknown>;
  const ds = t.datasource as Record<string, unknown> | undefined;
  need(!!ds && typeof ds.type === 'string' && typeof ds.uid === 'string', 'datasource needs type and uid');
  need(Array.isArray(t.resources) && t.resources.length > 0, 'resources must list at least one Log Analytics resource id');
  for (const r of t.resources as unknown[]) need(typeof r === 'string' && r.startsWith('/subscriptions/'), `resource "${String(r)}" is not an ARM id`);
  need(typeof t.folder === 'string' && /^[a-z0-9-]+$/.test(t.folder), 'folder must be a folder uid: lowercase letters, digits, and dashes');
  const views = t.views as Record<string, unknown> | undefined;
  need(!!views, 'views is required');
  for (const v of VIEW_NAMES) {
    need(typeof views![v] === 'string' && (views![v] as string).trim().length > 0, `views.${v} must be a KQL tabular expression`);
  }
  return t as unknown as AzureTarget;
}

export function loadTarget(path: string): AzureTarget {
  return parseTarget(JSON.parse(readFileSync(path, 'utf8')));
}

/** `let` bindings for the views a query reads, then the query. */
export function withViews(target: AzureTarget, query: string): string {
  const lets = VIEW_NAMES.filter((v) => new RegExp(`\\b${v}\\b`).test(query)).map(
    (v) => `let ${v} = ${target.views[v].trim().replace(/;\s*$/, '')};`,
  );
  return [...lets, query].join('\n');
}
