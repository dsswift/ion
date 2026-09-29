/**
 * use-engine-profiles-store — where one server's engine profiles live and
 * how they change. The local server's are in the preferences store; another
 * server's are in its own settings.json, read and written over the wire.
 */
import { useCallback, useEffect, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import type { EngineProfile } from '@ion/shared/types'
import { withTargetEnvironment } from '../../../../studio/connection/tab-environment'
import { host } from '../../../../host/host-instance'
import { usePreferencesStore } from '../../../../preferences'
import { rInfo, rWarn } from '../../../../rendererLogger'

export interface EngineProfilesStore {
  profiles: EngineProfile[]
  add(profile: EngineProfile): void
  update(id: string, profile: EngineProfile): void
  remove(id: string): void
  loading: boolean
  error: string | null
}

export function useEngineProfilesStore(environmentId: string): EngineProfilesStore {
  const localProfiles = usePreferencesStore((s) => s.engineProfiles)
  const addLocal = usePreferencesStore((s) => s.addEngineProfile)
  const updateLocal = usePreferencesStore((s) => s.updateEngineProfile)
  const removeLocal = usePreferencesStore((s) => s.removeEngineProfile)
  const isLocal = environmentId === LOCAL_ENVIRONMENT_ID
  const [remote, setRemote] = useState<EngineProfile[]>([])
  const [loading, setLoading] = useState(!isLocal)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (isLocal) return
    let cancelled = false
    setLoading(true)
    withTargetEnvironment(environmentId, () => host.shell.loadSettings()).then((settings) => {
      if (cancelled) return
      const list = Array.isArray(settings.engineProfiles) ? (settings.engineProfiles as EngineProfile[]) : []
      setRemote(list)
      setError(null)
      rInfo('engine-config', 'remote engine profiles loaded', { environment_id: environmentId, count: list.length })
    }).catch((err: unknown) => {
      if (cancelled) return
      rWarn('engine-config', 'remote engine profiles load failed', { environment_id: environmentId, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [environmentId, isLocal])

  const persistRemote = useCallback((next: EngineProfile[]) => {
    setRemote(next)
    withTargetEnvironment(environmentId, () => host.shell.saveSettings({ engineProfiles: next })).then(() => {
      rInfo('engine-config', 'remote engine profiles saved', { environment_id: environmentId, count: next.length })
    }).catch((err: unknown) => {
      rWarn('engine-config', 'remote engine profiles save failed', { environment_id: environmentId, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    })
  }, [environmentId])

  if (isLocal) return { profiles: localProfiles, add: addLocal, update: updateLocal, remove: removeLocal, loading: false, error: null }
  return {
    profiles: remote,
    add: (profile) => persistRemote([...remote, profile]),
    update: (id, profile) => persistRemote(remote.map((p) => (p.id === id ? profile : p))),
    remove: (id) => persistRemote(remote.filter((p) => p.id !== id)),
    loading,
    error,
  }
}
