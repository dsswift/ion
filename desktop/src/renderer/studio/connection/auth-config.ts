/**
 * auth-config — the add-environment flow's probe: `GET <url>/auth/config`
 * (manifest C6), 5-second timeout, falling back to Advanced manual fields
 * on failure (spec 13). This is a plain `fetch` from the renderer (the
 * endpoint is unauthenticated by design), not a host round trip — the
 * renderer already makes outbound fetches for other Advanced-settings
 * probes and no credential is involved here.
 */
import { rWarn } from '../../rendererLogger'

const PROBE_TIMEOUT_MS = 5000

export interface AuthConfigProbeResult {
  oidc: { issuer: string; audience: string; scope: string; clientId?: string } | null
  transports: readonly string[]
  environmentId: string
  label: string
  protocolVersion: number
  serverVersion: string
}

/** Probes `<url>/auth/config`. Returns null on timeout, network failure, or a malformed body — the caller falls back to Advanced manual fields. */
export async function probeAuthConfig(url: string): Promise<AuthConfigProbeResult | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const base = url.replace(/\/$/, '')
    const res = await fetch(`${base}/auth/config`, { signal: controller.signal })
    if (!res.ok) {
      rWarn('studio.auth-config', 'probe returned non-2xx', { url, status: res.status })
      return null
    }
    const body = (await res.json()) as Partial<AuthConfigProbeResult>
    if (typeof body.environmentId !== 'string' || typeof body.label !== 'string') {
      rWarn('studio.auth-config', 'probe response missing required fields', { url })
      return null
    }
    return {
      oidc: body.oidc ?? null,
      transports: Array.isArray(body.transports) ? body.transports : [],
      environmentId: body.environmentId,
      label: body.label,
      protocolVersion: typeof body.protocolVersion === 'number' ? body.protocolVersion : 0,
      serverVersion: typeof body.serverVersion === 'string' ? body.serverVersion : '',
    }
  } catch (err) {
    rWarn('studio.auth-config', 'probe failed; falling back to Advanced fields', { url, error: err instanceof Error ? err.message : String(err) })
    return null
  } finally {
    clearTimeout(timeout)
  }
}
