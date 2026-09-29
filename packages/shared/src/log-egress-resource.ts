/**
 * log-egress-resource.ts — the OTLP resource and the trace correlation ids
 * every shipped log record and span carries.
 *
 * The TypeScript twin of engine/internal/utils/log_egress_resource.go: the
 * same rule, so a record gets the same resource whichever exporter ships it.
 *
 * One egress batch holds records from several sources (server, desktop, web,
 * engine, iOS, telemetry), so the resource is derived from each record: a
 * record's service is `ion-<component>`, and records group into one
 * resourceLogs/resourceSpans entry per distinct resource. Logs and spans from
 * one source share a resource, which is what lets a backend join them.
 *
 * Application Insights derives RoleName from service.namespace and
 * service.name, and RoleInstance from service.instance.id; Tempo and Loki
 * read service.name. See docs/observability/log-schema.md § Correlation model.
 */
import { readFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import { dataDir } from './data-dir'
import { warn as _warn } from './log-sink'
import type { EgressRecord } from './log-egress-types'
import { isTelemetryEventRecord, type OtlpLogAttr } from './log-egress-otel'
import { isValidSpanId, isValidTraceId } from './trace-context'

/** The service.namespace every Ion component reports. */
export const ION_SERVICE_NAMESPACE = 'ion'

/**
 * Lines the iOS app wrote ship from the paired host but describe the device,
 * so their instance and version come from the line.
 */
const IOS_COMPONENT = 'ios'

let serviceVersion = ''

/** Records the build version this process reports as service.version. */
export function setEgressServiceVersion(version: string): void {
  serviceVersion = version
}

/** The version setEgressServiceVersion stored, or "dev". */
export function egressServiceVersion(): string {
  return serviceVersion || 'dev'
}

/** The OS hostname without macOS's ".local" suffix, matching the engine's host.name. */
export function resourceHostName(): string {
  return hostname().replace(/\.local$/, '')
}

let installId: string | undefined

/**
 * This host's install id: the value the engine minted at `<data dir>/install_id`,
 * which the engine reports as its service.instance.id. Read once. Empty when
 * the engine has not run on this host yet.
 */
export function hostInstallId(): string {
  if (installId !== undefined) return installId
  try {
    installId = readFileSync(join(dataDir(), 'install_id'), 'utf-8').trim()
  } catch (err) {
    installId = ''
    _warn('log_egress_otel', 'install_id unreadable; service.instance.id not set', { error: String(err) })
  }
  return installId
}

/** Test seam: forget the cached install id. */
export function resetHostInstallIdForTest(value?: string): void {
  installId = value
}

/** The service.name of a record from `component`. */
export function serviceNameForComponent(component: unknown): string {
  return `ion-${typeof component === 'string' && component ? component : 'engine'}`
}

function stringAt(src: unknown, key: string): string {
  if (src === null || typeof src !== 'object') return ''
  const v = (src as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : ''
}

/**
 * The resource of the source that wrote `r`, sorted by key. An iOS line and a
 * telemetry event carry their source's identity themselves; every other
 * record was written on this host. `configured` (the
 * otel config's resourceAttributes) wins over every derived value except
 * service.name, which always names the record's source.
 */
export function egressResourceAttrs(r: EgressRecord, configured?: Record<string, string>): OtlpLogAttr[] {
  const values: Record<string, string> = { 'service.namespace': ION_SERVICE_NAMESPACE }
  if (r.component === IOS_COMPONENT) {
    values['service.instance.id'] = stringAt(r.fields, 'device_id')
    values['service.version'] = stringAt(r.fields, 'app_version')
  } else if (isTelemetryEventRecord(r)) {
    // A telemetry event names the install, build, and host that recorded it,
    // which is not always the process shipping it.
    values['service.instance.id'] = stringAt(r, 'install_id') || hostInstallId()
    values['host.name'] = (stringAt(r, 'host') || resourceHostName()).replace(/\.local$/, '')
    values['service.version'] = stringAt(r, 'version') || egressServiceVersion()
  } else {
    values['service.instance.id'] = hostInstallId()
    values['host.name'] = resourceHostName()
    values['service.version'] = egressServiceVersion()
  }
  Object.assign(values, configured ?? {})
  values['service.name'] = serviceNameForComponent(r.component)
  return Object.keys(values)
    .filter((k) => values[k])
    .sort()
    .map((key) => ({ key, value: { stringValue: values[key] } }))
}

/** Identifies a resource for grouping: its sorted, string-valued attributes joined. */
export function resourceKey(attrs: OtlpLogAttr[]): string {
  return attrs.map((a) => `${a.key}=${a.value.stringValue ?? ''}`).join('\n')
}

/** Reads service.name back out of a built resource. */
export function resourceServiceName(attrs: OtlpLogAttr[]): string {
  return attrs.find((a) => a.key === 'service.name')?.value.stringValue ?? ''
}

/**
 * The OTLP LogRecord traceId and spanId for `r`. The trace is the record's
 * trace_id. The span is the one the record is about: a span record's own
 * span_id, otherwise the span a telemetry event was emitted under
 * (context.parent_span_id). Invalid ids are dropped, and a span id is never
 * set without a trace id.
 */
export function logRecordTraceIds(r: EgressRecord): { traceId?: string; spanId?: string } {
  if (!isValidTraceId(r.trace_id)) return {}
  const own = stringAt(isTelemetryEventRecord(r) ? r.payload : r.fields, 'span_id')
  if (isValidSpanId(own)) return { traceId: r.trace_id, spanId: own }
  const parent = stringAt(r.context, 'parent_span_id')
  if (isValidSpanId(parent)) return { traceId: r.trace_id, spanId: parent }
  return { traceId: r.trace_id }
}
