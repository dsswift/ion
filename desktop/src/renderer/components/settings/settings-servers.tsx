/**
 * settings-servers — the servers the Settings sidebar lists, and which one a
 * server page is about.
 *
 * The dialog owns the catalog state (`useSettingsServersState`) because the
 * sidebar, the Servers page, and every server's Overview all read and change
 * it. A server page reads its own server through `useSettingsEnvironment`.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry, type EnvironmentTarget } from '@ion/shared/types-environments'
import { readCatalog, addToCatalog, relabelCatalogEntry, removeFromCatalog, onCatalogChange } from '../../studio/connection/catalog'
import { registry } from '../../studio/connection/registry'
import { useActiveTabEnvironmentId } from '../../studio/connection/tab-environment'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { rError, rInfo } from '../../rendererLogger'
import { LOCAL_ENVIRONMENT_LABEL } from '../../studio/connection/local-label'

export interface SettingsServers {
  entries: EnvironmentCatalogEntry[]
  /** The server added most recently in this dialog; its Overview shows the finish-setup notice. */
  justAddedId: string | null
  add(target: EnvironmentTarget): Promise<EnvironmentCatalogEntry | null>
  relabel(entry: EnvironmentCatalogEntry, label: string): void
  forget(entry: EnvironmentCatalogEntry): Promise<void>
}

export function useSettingsServersState(): SettingsServers {
  const [entries, setEntries] = useState<EnvironmentCatalogEntry[]>([])
  const [justAddedId, setJustAddedId] = useState<string | null>(null)
  const refresh = useCallback(() => {
    void readCatalog().then(setEntries).catch((err) => rError('settings.servers', 'catalog read failed', { error: String(err) }))
  }, [])
  useEffect(() => { refresh(); return onCatalogChange(refresh) }, [refresh])

  // Catalog entries lead with the always-present local entry; the persisted
  // index space `catalog.ts` edits excludes it, so every call shifts by one.
  const indexOf = useCallback((entry: EnvironmentCatalogEntry) => entries.findIndex((e) => e.id === entry.id) - 1, [entries])

  const add = useCallback(async (target: EnvironmentTarget) => {
    await addToCatalog(target)
    const catalog = await readCatalog()
    setEntries(catalog)
    const added = catalog[catalog.length - 1]
    // Boot is the only other caller of connectAll: an entry added here would
    // otherwise sit unknown until the next launch.
    void registry.connectAll()
    if (!added || added.id === LOCAL_ENVIRONMENT_ID) return null
    rInfo('settings.servers', 'server added', { environment_id: added.id })
    setJustAddedId(added.id)
    return added
  }, [])

  const relabel = useCallback((entry: EnvironmentCatalogEntry, label: string) => {
    const index = indexOf(entry)
    if (index < 0) return
    void relabelCatalogEntry(index, label).then(refresh).catch((err) => rError('settings.servers', 'relabel failed', { environment_id: entry.id, error: String(err) }))
  }, [indexOf, refresh])

  const forget = useCallback(async (entry: EnvironmentCatalogEntry) => {
    const index = indexOf(entry)
    if (index < 0) return
    await removeFromCatalog(index)
    registry.forget(entry.id)
    rInfo('settings.servers', 'server forgotten', { environment_id: entry.id })
    refresh()
  }, [indexOf, refresh])

  return useMemo(() => ({ entries, justAddedId, add, relabel, forget }), [entries, justAddedId, add, relabel, forget])
}

/** The server of the conversation on screen, else local: where Settings opens. */
export function useDefaultEnvironmentId(): string {
  const hasActiveTab = useSessionStore((s) => s.activeTabId !== null)
  const active = useActiveTabEnvironmentId()
  return hasActiveTab ? active : LOCAL_ENVIRONMENT_ID
}

const ServersContext = createContext<SettingsServers | null>(null)
const EnvironmentContext = createContext<EnvironmentCatalogEntry | null>(null)

export function SettingsServersProvider({ value, children }: { value: SettingsServers; children: React.ReactNode }): React.JSX.Element {
  return <ServersContext.Provider value={value}>{children}</ServersContext.Provider>
}

export function SettingsEnvironmentProvider({ entry, children }: { entry: EnvironmentCatalogEntry; children: React.ReactNode }): React.JSX.Element {
  return <EnvironmentContext.Provider value={entry}>{children}</EnvironmentContext.Provider>
}

const LOCAL_ENTRY: EnvironmentCatalogEntry = { id: LOCAL_ENVIRONMENT_ID, label: LOCAL_ENVIRONMENT_LABEL, target: { kind: 'local' } }
const NO_SERVERS: SettingsServers = {
  entries: [LOCAL_ENTRY],
  justAddedId: null,
  add: async () => null,
  relabel: () => {},
  forget: async () => {},
}

export function useSettingsServers(): SettingsServers {
  return useContext(ServersContext) ?? NO_SERVERS
}

export interface SettingsEnvironment {
  entry: EnvironmentCatalogEntry
  id: string
  label: string
  isLocal: boolean
  justAdded: boolean
}

/** The server the page on screen is about; the local server outside a server page. */
export function useSettingsEnvironment(): SettingsEnvironment {
  const entry = useContext(EnvironmentContext) ?? LOCAL_ENTRY
  const { justAddedId } = useSettingsServers()
  return { entry, id: entry.id, label: entry.label, isLocal: entry.id === LOCAL_ENVIRONMENT_ID, justAdded: justAddedId === entry.id }
}
