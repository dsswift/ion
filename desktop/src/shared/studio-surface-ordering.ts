import { SINGLETON_ORDER, type PinnableSingletonId, type SurfaceTab } from './studio-surface-types'

/** Restore singleton ordering while retaining dynamic insertion order. */
export function normalizeTabs(tabs: readonly SurfaceTab[]): SurfaceTab[] {
  const seen = new Set<string>()
  const deduped = tabs.filter((tab) => {
    if (seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
  const singletons = SINGLETON_ORDER.flatMap((id) => deduped.filter((tab) => tab.kind === 'singleton' && tab.id === id))
  return [...singletons, ...deduped.filter((tab) => tab.kind !== 'singleton')]
}

/** Compose global core pins with the current conversation's local descriptors. */
export function composeTabs(pinnedTabs: readonly PinnableSingletonId[], localTabs: readonly SurfaceTab[]): SurfaceTab[] {
  const pins: SurfaceTab[] = pinnedTabs.map((id) => ({ kind: 'singleton', id }))
  const locals = normalizeTabs(localTabs.filter((tab) => !(tab.kind === 'singleton' && pinnedTabs.includes(tab.id as PinnableSingletonId))))
  // Global pins own the left-most strip positions. Local singleton ordering is
  // retained after them, followed by dynamic conversation tabs.
  return [...pins, ...locals]
}

export function nextActiveAfterClose(tabs: readonly SurfaceTab[], closedId: string): string | null {
  const idx = tabs.findIndex((tab) => tab.id === closedId)
  if (idx === -1) return null
  return tabs[idx + 1]?.id ?? tabs[idx - 1]?.id ?? null
}

/** Close all non-global-pinned tabs except the requested tab. */
export function closeOthersTargets(tabs: readonly SurfaceTab[], keepId: string, pinnedIds: readonly string[] = []): SurfaceTab[] {
  const pins = new Set(pinnedIds)
  return tabs.filter((tab) => !pins.has(tab.id) && tab.id !== keepId)
}

/** Close non-global-pinned tabs to the right of the requested tab. */
export function closeToRightTargets(tabs: readonly SurfaceTab[], fromId: string, pinnedIds: readonly string[] = []): SurfaceTab[] {
  const idx = tabs.findIndex((tab) => tab.id === fromId)
  if (idx === -1) return []
  const pins = new Set(pinnedIds)
  return tabs.slice(idx + 1).filter((tab) => !pins.has(tab.id))
}

export function nextTerminalTitle(tabs: readonly SurfaceTab[]): string {
  let max = 0
  for (const tab of tabs) {
    if (tab.kind !== 'terminal') continue
    const match = /^Terminal (\d+)$/.exec(tab.title)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `Terminal ${max + 1}`
}
