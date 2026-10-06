/**
 * deploy-source — the checkout the Deploy panel remembers on this device.
 *
 * A folder is remembered by its path. A bench is remembered by its repository
 * and branch instead: Ion removes a bench's folder when its last worktree
 * lands, and a remembered path would then name nothing. This device's server
 * finds the bench's folder for every check (`fleet.deploy.source`), or the
 * checkout that has the branch once the bench is gone.
 */
import { parseFleetSourceQuery, type FleetCheckout, type FleetSourceQuery } from '@ion/shared/types-fleet-run'
import { environmentClient } from '../../../environment/environment-client'

export const SOURCE_KEY = 'ion.fleet.deploy-source'

/** The source remembered on this device; empty when none is. A path never starts with `{`, so a bench is stored as JSON beside paths. */
export function loadDeploySource(): FleetSourceQuery {
  const raw = localStorage.getItem(SOURCE_KEY) ?? ''
  if (!raw.startsWith('{')) return raw
  try {
    const parsed = parseFleetSourceQuery(JSON.parse(raw))
    return parsed !== null && typeof parsed !== 'string' ? parsed : ''
  } catch {
    return '' // silent-ok: an unreadable entry is no remembered source; the panel asks for one
  }
}

/** Remembers what a deploy built from: the bench it was, by its branch, or else the source as given. */
export function saveDeploySource(source: FleetSourceQuery, checkout: FleetCheckout | null): void {
  const bench = checkout?.bench ?? (typeof source === 'string' ? null : source)
  localStorage.setItem(SOURCE_KEY, bench ? JSON.stringify(bench) : typeof source === 'string' ? source.trim() : '')
}

/** The source as a log field. */
export function describeDeploySource(source: FleetSourceQuery): string {
  return typeof source === 'string' ? source.trim() : `bench ${source.branch} of ${source.repoPath}`
}

/** The checkout `source` names on `environmentId`'s machine; null for `dev` and `release`, which name none here. */
export async function findCheckout(environmentId: string, source: FleetSourceQuery): Promise<FleetCheckout | null> {
  if (source === 'dev' || source === 'release') return null
  return environmentClient.fleetDeploySource(environmentId, source)
}

/** What the panel says about a checkout that is a bench, or stands in for one; null for any other folder. */
export function benchNote(checkout: FleetCheckout | null): string | null {
  const bench = checkout?.bench
  if (!checkout || !bench) return null
  if (checkout.via === 'branch') {
    return `The ${bench.branch} bench is gone: its last worktree landed, so ${bench.branch} holds its work. This builds ${bench.branch} from ${checkout.path}.`
  }
  return `This is the ${bench.branch} integration bench. It is remembered by its branch, so a deploy still finds it after the bench is rebuilt or removed.`
}
