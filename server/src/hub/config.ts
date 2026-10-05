/**
 * `hub.json` in the data directory: how a Fleet Hub listens, who may sign
 * in to it, and which enrollment tokens let a server join. Every field has
 * a default; a malformed one falls back to it with a WARN.
 */
import { existsSync, readFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'
import type { HubViews } from '@ion/shared/fleet-hub'
import { parseOidc, type ServerOidcConfig } from '../config/server-config'
import { resolveSecretRef } from '../config/secret-ref'
import { log as _log, warn as _warn } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('hub.config', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('hub.config', msg, fields)
}

export const DEFAULT_HUB_PORT = 7400

export interface HubConfig {
  /** The hub's name, shown on its page and on each server that reports to it. */
  label: string
  listen: { port: number; host?: string }
  /**
   * The sign-in in front of every page and action. Null means no sign-in:
   * anyone who can reach the hub can manage the Fleet, which is only for a
   * hub that never leaves a trusted network.
   */
  oidc: ServerOidcConfig | null
  /** Tokens that let a server enroll, resolved past any `secretstore:` reference. */
  enrollmentTokens: string[]
  /** Where the portal's files are, for an install that keeps them somewhere other than beside the bundle. */
  webDir?: string
  /** The views the page shows. Each is on unless `hub.json` turns it off. */
  views: HubViews
}

export function loadHubConfig(dir: string): HubConfig {
  const path = join(dir, 'hub.json')
  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
      else warn('hub.json is not an object; using defaults', { path })
    } catch (err) {
      warn('hub.json unreadable or malformed; using defaults', { path, error: String(err) })
    }
  } else {
    log('no hub.json; using defaults', { path })
  }
  const listen = raw.listen && typeof raw.listen === 'object' ? (raw.listen as Record<string, unknown>) : {}
  const port = typeof listen.port === 'number' && Number.isInteger(listen.port) && listen.port > 0 && listen.port < 65536 ? listen.port : DEFAULT_HUB_PORT
  if (listen.port !== undefined && port !== listen.port) warn('hub.json listen.port ignored: expected a port number', { value: listen.port })
  const enrollment = raw.enrollment && typeof raw.enrollment === 'object' ? (raw.enrollment as Record<string, unknown>) : {}
  const tokens = (Array.isArray(enrollment.tokens) ? enrollment.tokens : [])
    .filter((t): t is string => typeof t === 'string' && t.length > 0)
    .map((t) => resolveSecretRef(t, dir))
    .filter((t) => t.length > 0)
  const oidc = parseOidc(raw.oidc, dir)
  const views = raw.views && typeof raw.views === 'object' ? (raw.views as Record<string, unknown>) : {}
  if (views.quota !== undefined && typeof views.quota !== 'boolean') warn('hub.json views.quota ignored: expected true or false', { value: views.quota })
  const config: HubConfig = {
    label: typeof raw.label === 'string' && raw.label ? raw.label : `${hostname()} hub`,
    listen: { port, host: typeof listen.host === 'string' && listen.host ? listen.host : undefined },
    oidc,
    enrollmentTokens: [...new Set(tokens)],
    webDir: typeof raw.webDir === 'string' && raw.webDir ? raw.webDir : undefined,
    views: { quota: views.quota !== false },
  }
  log('hub config loaded', { label: config.label, port, has_oidc: oidc !== null, enrollment_token_count: config.enrollmentTokens.length, quota_view: config.views.quota })
  return config
}
