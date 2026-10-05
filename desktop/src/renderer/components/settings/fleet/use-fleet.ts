/**
 * use-fleet — the Fleet as this device sees it: every server in its catalog,
 * each with the report that server gives of itself (`fleet.report`).
 *
 * Reports are held in `fleet-reports`, shared with placement. They are read
 * from each connected server when the page opens, every
 * minute while it stays open, and on Refresh, which first has each server
 * re-read its provider CLIs. A server that goes offline keeps its last
 * report; the page says how old it is.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry, type EnvironmentPhaseState } from '@ion/shared/types-environments'
import type { FleetServer } from '@ion/shared/fleet-view'
import { action } from '../../../host/host-instance'
import { registry } from '../../../studio/connection/registry'
import { rInfo, rWarn } from '../../../rendererLogger'
import { _resetFleetReportsForTest, fleetReportFailure, heldFleetReport, readFleetReport } from '../../../studio/connection/fleet-reports'

export const FLEET_REFRESH_MS = 60_000

/** TEST ONLY. */
export function _resetFleetForTest(): void {
  _resetFleetReportsForTest()
}

export interface Fleet {
  servers: FleetServer[]
  /** Unix ms each server's report was read. */
  readAt: Record<string, number>
  /** Why a connected server gave no report (an older server has none to give). */
  errors: Record<string, string>
  /** No connected server has answered yet. */
  loading: boolean
  refreshing: boolean
  /** Has every connected server re-read its provider CLIs, then reads every report. */
  refresh(): void
}

function isOnline(id: string, states: Map<string, EnvironmentPhaseState>): boolean {
  return id === LOCAL_ENVIRONMENT_ID || states.get(id)?.phase === 'connected'
}

export function useFleet(entries: readonly EnvironmentCatalogEntry[]): Fleet {
  const [states, setStates] = useState<Map<string, EnvironmentPhaseState>>(() => registry.phaseStates())
  const [version, setVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [settled, setSettled] = useState(false)
  useEffect(() => registry.subscribe((next) => setStates(new Map(next))), [])

  const onlineIds = useMemo(() => entries.filter((e) => isOnline(e.id, states)).map((e) => e.id), [entries, states])
  const onlineKey = onlineIds.join('|')
  const onlineRef = useRef(onlineIds)
  onlineRef.current = onlineIds

  const readAll = useCallback(async (reprobe: boolean): Promise<void> => {
    const ids = onlineRef.current
    if (reprobe) {
      await Promise.all(ids.map((id) => action(id, 'fleet.refreshAccounts', []).catch((err: unknown) => {
        rWarn('settings.fleet', 'account refresh failed', { environment_id: id, error: String(err) })
      })))
    }
    await Promise.all(ids.map(readFleetReport))
    rInfo('settings.fleet', 'fleet reports read', { servers: ids.length, failed: ids.filter((id) => fleetReportFailure(id) !== undefined).length, reprobe })
    setSettled(true)
    setVersion((v) => v + 1)
  }, [])

  // Read when the page opens and whenever the set of connected servers changes, then every minute.
  useEffect(() => {
    void readAll(false)
    const timer = setInterval(() => { void readAll(false) }, FLEET_REFRESH_MS)
    return () => clearInterval(timer)
  }, [readAll, onlineKey])

  const refresh = useCallback(() => {
    setRefreshing(true)
    void readAll(true).finally(() => setRefreshing(false))
  }, [readAll])

  return useMemo(() => {
    const servers = entries.map((e): FleetServer => ({ id: e.id, label: e.label, online: isOnline(e.id, states), report: heldFleetReport(e.id)?.report ?? null }))
    const readAt: Record<string, number> = {}
    for (const e of entries) { const h = heldFleetReport(e.id); if (h) readAt[e.id] = h.readAt }
    const errors: Record<string, string> = {}
    for (const e of entries) { const f = fleetReportFailure(e.id); if (f) errors[e.id] = f }
    const loading = !settled && servers.some((s) => s.online && !s.report && !errors[s.id])
    return { servers, readAt, errors, loading, refreshing, refresh }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the cache key for the module-level report maps
  }, [entries, states, version, settled, refreshing, refresh])
}
