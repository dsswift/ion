/**
 * placement — where this device opens a new conversation when it is left to
 * choose. The mode and the per-server weights are this device's own view
 * preferences, kept in localStorage like the picker's sort and grouping.
 * The choice itself is `pickPlacement` over each server's `fleet.report`.
 */
import { useEffect, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { PLACEMENT_REPORT_MAX_AGE_MS, PLACEMENT_WEIGHTS, pickPlacement, type Placement, type PlacementCandidate, type PlacementWeight } from '@ion/shared/fleet-placement'
import { heldFleetReport, readFleetReport } from './fleet-reports'
import { registry } from './registry'
import { rInfo, rWarn } from '../../rendererLogger'

/** `manual`: this machine when it has the project, else the first that does. `auto`: the server with the most room. */
export type PlacementMode = 'manual' | 'auto'

const MODE_KEY = 'ion.placement.mode'
const WEIGHTS_KEY = 'ion.placement.weights'

export function savedPlacementMode(): PlacementMode {
  return localStorage.getItem(MODE_KEY) === 'auto' ? 'auto' : 'manual'
}

export function savePlacementMode(mode: PlacementMode): void {
  localStorage.setItem(MODE_KEY, mode)
  rInfo('placement', 'placement mode changed', { mode })
}

export function placementWeights(): Record<string, PlacementWeight> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(WEIGHTS_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, PlacementWeight> = {}
    for (const [id, weight] of Object.entries(parsed)) {
      if (PLACEMENT_WEIGHTS.includes(weight as PlacementWeight)) out[id] = weight as PlacementWeight
    }
    return out
  } catch (error) {
    rWarn('placement', 'placement weights unreadable, every server is normal', { error: String(error) })
    return {}
  }
}

export function setPlacementWeight(environmentId: string, weight: PlacementWeight): void {
  const next = { ...placementWeights() }
  if (weight === 'normal') delete next[environmentId]
  else next[environmentId] = weight
  localStorage.setItem(WEIGHTS_KEY, JSON.stringify(next))
  rInfo('placement', 'placement weight changed', { environment_id: environmentId, weight })
}

function isOnline(environmentId: string): boolean {
  return environmentId === LOCAL_ENVIRONMENT_ID || registry.phaseStates().get(environmentId)?.phase === 'connected'
}

/**
 * Scores the servers that hold a project. `holders` come in the caller's
 * default order, which a tie keeps.
 */
export function placeAmong(holders: ReadonlyArray<{ environmentId: string; label: string }>, now: number = Date.now()): Placement {
  const weights = placementWeights()
  const candidates = holders.map((holder): PlacementCandidate => {
    const held = heldFleetReport(holder.environmentId)
    return { id: holder.environmentId, label: holder.label, online: isOnline(holder.environmentId), weight: weights[holder.environmentId], report: held?.report ?? null, readAt: held?.readAt }
  })
  return pickPlacement(candidates, now)
}

/**
 * Keeps the reports placement scores fresh while `enabled`: reads each
 * server that has none or a stale one. Returns a counter that changes when
 * a read lands, so a caller's memo recomputes.
 */
export function usePlacementReports(environmentIds: readonly string[], enabled: boolean): number {
  const [version, setVersion] = useState(0)
  const key = environmentIds.join('|')
  useEffect(() => {
    if (!enabled || !key) return
    let cancelled = false
    const stale = key.split('|').filter((id) => {
      const held = heldFleetReport(id)
      return isOnline(id) && (!held || Date.now() - held.readAt > PLACEMENT_REPORT_MAX_AGE_MS / 2)
    })
    if (stale.length === 0) return
    void Promise.all(stale.map(readFleetReport)).then(() => {
      if (cancelled) return
      rInfo('placement', 'fleet reports read for placement', { servers: stale.length })
      setVersion((v) => v + 1)
    })
    return () => { cancelled = true }
  }, [enabled, key])
  return version
}
