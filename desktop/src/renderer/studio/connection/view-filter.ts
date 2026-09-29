/**
 * view-filter — the `All | Local | <environmentId>` filter (spec 13),
 * persisted at `desktop.json.environmentViewFilter`. Kept as its own small
 * hook rather than folded into `preferences.ts` (which already tracks
 * `desktop.json`-backed device settings) because the filter is read
 * directly through the host in the connection module's own tests; a
 * `preferences.ts` round trip would require mocking the whole preferences
 * store for a one-field concern.
 */
import type { TabState } from '@ion/shared/types'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { tabEnvironmentId } from './tab-environment'
import { useCallback, useEffect, useState } from 'react'
import type { EnvironmentViewFilter } from '@ion/shared/types-environments'
import { host } from '../../host/host-instance'
import { rWarn } from '../../rendererLogger'

/** Pure: does `tab` pass the `All | Local | <environmentId>` filter? (ADR-033 union store; was `union.ts#filterUnionTabs`.) */
export function tabMatchesEnvironmentFilter(tab: Pick<TabState, 'environmentId'>, filter: EnvironmentViewFilter): boolean {
  if (filter === 'all') return true
  if (filter === 'local') return tabEnvironmentId(tab) === LOCAL_ENVIRONMENT_ID
  return tabEnvironmentId(tab) === filter
}

export function useEnvironmentViewFilter(): [EnvironmentViewFilter, (next: EnvironmentViewFilter) => void] {
  const [filter, setFilter] = useState<EnvironmentViewFilter>('all')

  useEffect(() => {
    void host.deviceSettings().then((settings) => {
      const value = settings.environmentViewFilter
      if (typeof value === 'string') setFilter(value)
    }).catch((err) => rWarn('studio.view-filter', 'read failed', { error: err instanceof Error ? err.message : String(err) }))
  }, [])

  const set = useCallback((next: EnvironmentViewFilter) => {
    setFilter(next)
    void host.setDeviceSetting('environmentViewFilter', next).catch((err) =>
      rWarn('studio.view-filter', 'write failed', { error: err instanceof Error ? err.message : String(err) }))
  }, [])

  return [filter, set]
}
