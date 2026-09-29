// Field resolution: LogQL label names to KQL expressions over the Ion views.
//
// The Azure target never names a landing table or a physical column. Every
// query reads three logical views whose column contract is fixed here and in
// docs/observability/azure-monitor.md; a deployment's target config maps its
// real tables onto them (target.ts). So a pipeline schema change is an edit to
// that config and nothing else.
//
// LogQL reaches a field three ways, and each resolves to one view column or one
// key inside a view's dynamic bag:
//   * a stream label or telemetry structured-metadata alias (`host`, `model`);
//   * a `| json`-flattened body path (`payload_run_cost_usd`, `fields_rtt_p95_ms`);
//   * an explicit `| json alias="fields.path"` parameter.

export type Family = 'telemetry' | 'logs';

export const VIEW: Readonly<Record<Family | 'spans', string>> = {
  telemetry: 'IonTelemetry',
  logs: 'IonLogs',
  spans: 'IonSpans',
};

// Scalar columns of each view, by the LogQL name that reads them. The OTLP
// envelope's own fields keep their Azure Monitor column names (TraceId,
// ServiceName, ...); Ion's own fields keep their LogQL names.
const COLUMNS: Readonly<Record<Family, Readonly<Record<string, string>>>> = {
  telemetry: {
    event_name: 'event_name',
    service_name: 'ServiceName',
    service_instance_id: 'ServiceInstanceId',
    service_version: 'ServiceVersion',
    host_name: 'host_name',
    user: 'user',
    trace_id: 'TraceId',
    span_id: 'SpanId',
    schema_version: 'schema',
  },
  logs: {
    level: 'level',
    service_name: 'ServiceName',
    service_instance_id: 'ServiceInstanceId',
    service_version: 'ServiceVersion',
    tag: 'tag',
    msg: 'msg',
    host_name: 'host_name',
    user: 'user',
    session_id: 'session_id',
    conversation_id: 'conversation_id',
    trace_id: 'TraceId',
    span_id: 'SpanId',
  },
};

// The bags a flattened `<bag>_<key>` name opens into, per family.
const BAGS: Readonly<Record<Family, readonly string[]>> = {
  telemetry: ['payload', 'context'],
  logs: ['fields'],
};

// Structured-metadata names the Alloy telemetry pipeline promotes
// (alloy-config.alloy, `loki.process "ion_telemetry"`), mapped back to the
// event path they were extracted from.
const TELEMETRY_ALIASES: Readonly<Record<string, string>> = {
  model: 'payload.model',
  tool: 'payload.tool',
  stop_reason: 'payload.stop_reason',
  duration_ms: 'payload.duration_ms',
  run_cost_usd: 'payload.run_cost_usd',
  agg_cost_usd: 'payload.aggregate_cost_usd',
  dispatch_depth: 'payload.dispatch_depth',
  num_turns: 'payload.num_turns',
  input_tokens: 'payload.input_tokens',
  output_tokens: 'payload.output_tokens',
  cache_read_tokens: 'payload.cache_read_input_tokens',
  cache_creation_tokens: 'payload.cache_creation_input_tokens',
  error: 'payload.error',
};

/** A KQL string literal. Verbatim form, so regex backslashes pass through. */
export function kqlString(s: string): string {
  return `@"${s.replace(/"/g, '""')}"`;
}

// `payload.run_cost_usd` -> `payload["run_cost_usd"]`; a bare column stays bare.
function pathExpr(path: string): string {
  const [head, ...rest] = path.split('.');
  return head + rest.map((k) => `[${kqlString(k)}]`).join('');
}

/**
 * Resolves names within one query. `local` holds columns the query itself
 * extended (a coalesced label, a timestamp); `aliases` holds `| json` params.
 */
export class Scope {
  private readonly local = new Set<string>();
  private readonly aliases = new Map<string, string>();

  readonly family: Family;

  constructor(family: Family) {
    this.family = family;
  }

  defineLocal(name: string): void {
    this.local.add(name);
  }

  alias(name: string, path: string): void {
    this.aliases.set(name, path);
  }

  /** The raw KQL path for a name: a column, or a bag lookup (dynamic). */
  raw(name: string): { expr: string; column: boolean } {
    if (this.local.has(name)) return { expr: name, column: true };
    const aliased = this.aliases.get(name);
    if (aliased) return { expr: pathExpr(aliased), column: !aliased.includes('.') };
    const column = COLUMNS[this.family][name];
    if (column) return { expr: column, column: true };
    if (this.family === 'telemetry' && TELEMETRY_ALIASES[name]) {
      const p = TELEMETRY_ALIASES[name];
      return { expr: pathExpr(p), column: !p.includes('.') };
    }
    for (const bag of BAGS[this.family]) {
      if (name.startsWith(`${bag}_`)) return { expr: pathExpr(`${bag}.${name.slice(bag.length + 1)}`), column: false };
    }
    throw new Error(`no ${this.family} field for LogQL name "${name}"`);
  }

  /** The name as a string (absent reads as ""). */
  str(name: string): string {
    const r = this.raw(name);
    return r.column ? r.expr : `tostring(${r.expr})`;
  }

  /** The name as a number, for `| unwrap`. */
  num(name: string): string {
    return `todouble(${this.raw(name).expr})`;
  }
}

/**
 * The view a stream selector reads, from its matchers: a selector that
 * requires an event name (`event_name="run.complete"`, `event_name=~".+"`)
 * reads telemetry; everything else reads logs.
 */
export function familyOf(matchers: readonly { name: string; op: string; value: string }[]): Family {
  return matchers.some((m) => m.name === 'event_name' && (m.op === '=' || m.op === '=~') && m.value !== '') ? 'telemetry' : 'logs';
}

/** True for the `event_name=""` matcher that only says "not telemetry". */
export function isLogsOnlyMatcher(m: { name: string; op: string; value: string }): boolean {
  return m.name === 'event_name' && m.op === '=' && m.value === '';
}
