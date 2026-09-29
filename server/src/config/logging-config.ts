/**
 * `server.json.logging` -- whether this server ships its own log lines
 * anywhere, and which of the files beside it it carries.
 *
 * The server writes `server.jsonl` and, before this, nothing ever collected
 * it: the shipping code was present and never configured, so every server and
 * web line reached a forwarder with no destination and was dropped. The
 * desktop reads its own equivalent from `engine.json`/`settings.json`
 * (`app-lifecycle-egress.ts`); a headless server has neither, so its
 * assignment lives in its own config.
 *
 * Absent block means ship nothing, matching the engine's own default. A
 * server only ships because an operator asked it to.
 */
import { warn as _warn } from '../logger'
import type { EgressConfig, EgressOtelConfig } from '@ion/shared/log-egress-types'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('server-config', msg, fields)
}

/** The sources a server's own forwarder can be assigned. */
export const EGRESS_SOURCES = ['server', 'engine', 'ios', 'telemetry'] as const
export type EgressSourceName = (typeof EGRESS_SOURCES)[number]

export interface ServerLoggingConfig {
  /** The egress config handed to `configureEgress`. Null means ship nothing. */
  egress: EgressConfig | null
  /**
   * This surface's entry in the shipping-responsibility matrix: which log
   * sources this server's forwarder carries. `server` is its own records
   * (in-process, never tailed); the rest are files beside it in the data
   * directory. Defaults to `["server"]` -- its own lines and nothing else,
   * so turning shipping on never silently claims a file the desktop or the
   * engine is already carrying.
   */
  shipSources: EgressSourceName[]
  /**
   * OIDC scope to mint an egress bearer token for, through the engine
   * (`oidc_token`). Empty keeps whatever static `egressHeaders` carry.
   */
  tokenScope: string
}

export function defaultLoggingConfig(): ServerLoggingConfig {
  return { egress: null, shipSources: ['server'], tokenScope: '' }
}

function asStringRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function parseSources(raw: unknown): EgressSourceName[] {
  if (raw === undefined) return ['server']
  if (!Array.isArray(raw)) {
    warn('server.json.logging.egressShipSources ignored: expected an array', { type: typeof raw })
    return ['server']
  }
  const known: string[] = [...EGRESS_SOURCES]
  const kept = raw.filter((s): s is EgressSourceName => typeof s === 'string' && known.includes(s))
  const dropped = raw.filter((s) => !(typeof s === 'string' && known.includes(s)))
  if (dropped.length > 0) {
    warn('server.json.logging.egressShipSources: unknown sources ignored', { dropped, known })
  }
  // An explicit empty list is a real assignment -- "another surface ships on
  // my behalf" -- and is preserved rather than defaulted back.
  return kept
}

/**
 * Parse the block. Anything malformed is reported and replaced by the
 * default, because refusing to boot over a logging preference would be worse
 * than shipping nothing.
 */
export function parseLogging(raw: unknown): ServerLoggingConfig {
  const defaults = defaultLoggingConfig()
  if (raw === undefined || raw === null) return defaults
  if (typeof raw !== 'object') {
    warn('server.json.logging ignored: expected an object', { type: typeof raw })
    return defaults
  }
  const obj = raw as Record<string, unknown>

  const targets = Array.isArray(obj.egressTargets)
    ? obj.egressTargets.filter((t): t is string => typeof t === 'string')
    : []
  if (targets.length === 0) {
    if (obj.egressTargets !== undefined) {
      warn('server.json.logging.egressTargets is empty or not a string array; this server ships nothing')
    }
    return { ...defaults, shipSources: parseSources(obj.egressShipSources) }
  }

  const egress: EgressConfig = { egressTargets: targets }
  if (typeof obj.egressEndpoint === 'string') egress.egressEndpoint = obj.egressEndpoint
  const headers = asStringRecord(obj.egressHeaders)
  if (headers) egress.egressHeaders = headers
  if (typeof obj.egressBatchSize === 'number') egress.egressBatchSize = obj.egressBatchSize
  if (typeof obj.egressFlushIntervalMs === 'number') egress.egressFlushIntervalMs = obj.egressFlushIntervalMs
  if (typeof obj.egressSpoolMaxBytes === 'number') egress.egressSpoolMaxBytes = obj.egressSpoolMaxBytes
  if (obj.egressOtel && typeof obj.egressOtel === 'object') {
    egress.egressOtel = obj.egressOtel as EgressOtelConfig
  }
  if (targets.includes('otel') && !egress.egressOtel) {
    warn('server.json.logging names the otel target with no egressOtel block; those records have nowhere to go')
  }
  if (targets.includes('http') && !egress.egressEndpoint) {
    warn('server.json.logging names the http target with no egressEndpoint; those records have nowhere to go')
  }

  return {
    egress,
    shipSources: parseSources(obj.egressShipSources),
    tokenScope: typeof obj.egressTokenScope === 'string' ? obj.egressTokenScope : defaults.tokenScope,
  }
}
