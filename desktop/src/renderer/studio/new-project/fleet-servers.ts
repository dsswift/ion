/**
 * fleet-servers — the servers a project can be cloned onto: every catalog
 * environment a conversation can open on, with whether it is connected now.
 */
import { useEffect, useMemo, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry, type EnvironmentPhaseState } from '@ion/shared/types-environments'
import { onCatalogChange, readConversationCatalog } from '../connection/catalog'
import { registry } from '../connection/registry'
import { rError } from '../../rendererLogger'

export interface FleetServerChoice {
  id: string
  label: string
  online: boolean
}

export function useFleetServers(): FleetServerChoice[] {
  const [catalog, setCatalog] = useState<EnvironmentCatalogEntry[]>([])
  const [states, setStates] = useState<Map<string, EnvironmentPhaseState>>(() => registry.phaseStates())
  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      void readConversationCatalog().then((entries) => { if (!cancelled) setCatalog(entries) }).catch((err: unknown) => rError('new-project.servers', 'catalog read failed', { error: String(err) }))
    }
    read()
    const off = onCatalogChange(read)
    return () => { cancelled = true; off() }
  }, [])
  useEffect(() => registry.subscribe((next) => setStates(new Map(next))), [])
  return useMemo(() => catalog.map((entry) => ({
    id: entry.id,
    label: entry.label,
    online: entry.id === LOCAL_ENVIRONMENT_ID || states.get(entry.id)?.phase === 'connected',
  })), [catalog, states])
}
