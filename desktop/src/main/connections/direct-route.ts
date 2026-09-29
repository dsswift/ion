/**
 * direct-route -- which address reaches a paired server directly, right now.
 *
 * A LAN pairing stores one address: the one the server had when it paired.
 * That address is only right on the network the server was on then. Carry a
 * laptop from home to the office and the stored address answers nothing,
 * even when the laptop sits on the same Wi-Fi as this desktop.
 *
 * Every welcome also reports where the server can be reached
 * (`studio_welcome.directAddresses`): its current literal addresses, then its
 * own `.local` name, which follows the machine to any network. The stored
 * address and every reported one are probed together, and the first that
 * answers AS THIS SERVER wins. An address that answers with a different
 * environment id is someone else's server on a reused address, and is skipped.
 */
import { serverHttpBase } from './transport-tcp'
import { log as _log } from '../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('direct-route', msg, fields)
}

export const LAN_PROBE_TIMEOUT_MS = 3000

/**
 * The environment id a server reports at `url`: its id, '' when it answers
 * but reports none, or null when nothing answers.
 */
export async function probeServer(url: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LAN_PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(`${serverHttpBase(url)}/auth/config`, { signal: controller.signal })
    if (!res.ok) return null
    const body = (await res.json().catch(() => ({}))) as { environmentId?: unknown }
    return typeof body.environmentId === 'string' ? body.environmentId : ''
  } catch {
    // silent-ok: an unreachable address is the case this probe exists to detect; findDirectUrl logs the outcome
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** The stored address first, then each reported one not already listed. */
export function directCandidates(primary: string, learned: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const url of [primary, ...learned]) {
    let key: string
    try {
      key = serverHttpBase(url)
    } catch (err) {
      log('an address is not a server url; skipped', { url, error: String(err) })
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
}

/**
 * The first address that answers as `environmentId`, or null when none does.
 *
 * The stored address is also accepted when the server reports no id at all,
 * which is what a server older than the id field looks like; a reported
 * address never is, since only a server new enough to report addresses
 * reports its id too.
 */
export async function findDirectUrl(environmentId: string, primary: string, learned: readonly string[]): Promise<string | null> {
  const candidates = directCandidates(primary, learned)
  if (candidates.length === 0) return null
  const found = await new Promise<string | null>((resolve) => {
    let pending = candidates.length
    const settle = (): void => {
      pending -= 1
      if (pending === 0) resolve(null)
    }
    for (const url of candidates) {
      void probeServer(url).then((reported) => {
        if (reported === null) return settle()
        const matches = reported === environmentId || (reported === '' && url === primary)
        if (!matches) {
          log('an address answers as a different server; skipped', { environment_id: environmentId, url, reported_environment_id: reported })
          return settle()
        }
        resolve(url)
        settle()
      })
    }
  })
  if (found) {
    log('direct address answers', { environment_id: environmentId, url: found, saved: found === primary, candidates: candidates.length })
  } else {
    log('no direct address answers', { environment_id: environmentId, candidates: candidates.join(',') })
  }
  return found
}
