import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import type { ResourceItem } from '../../shared/types-engine'

let resourceBootstrap: Promise<void> | null = null

export function bootstrapResources(): Promise<void> {
  if (resourceBootstrap) return resourceBootstrap
  resourceBootstrap = Promise.allSettled([
    window.ion.getReadResourceIds(),
    window.ion.getPersistedResources() as Promise<ResourceItem[]>,
  ]).then(([readResult, resourcesResult]) => {
    const readIds = readResult.status === 'fulfilled' ? readResult.value : []
    const items = resourcesResult.status === 'fulfilled' ? resourcesResult.value : []
    const byKind: Record<string, ResourceItem[]> = {}
    const itemReadIds: string[] = []
    for (const item of items) {
      ;(byKind[item.kind] ??= []).push(item)
      if (item.read) itemReadIds.push(item.id)
    }
    useSessionStore.setState((state) => {
      const resources = { ...state.resources }
      for (const [kind, kindItems] of Object.entries(byKind)) {
        if (!resources[kind] || resources[kind].length === 0) resources[kind] = kindItems
      }
      return { resources, readResourceIds: new Set([...state.readResourceIds, ...readIds, ...itemReadIds]) }
    })
  })
  return resourceBootstrap
}

export function useResourceBootstrap(): void {
  useEffect(() => {
    void bootstrapResources()
  }, [])
}
