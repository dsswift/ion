import { SINGLETON_ORDER, type PinnableSingletonId, type SurfaceTab } from './studio-surface-types'

/**
 * Restore singleton ordering while retaining dynamic insertion order.
 *
 * `agentBrowserInstanceId` makes the conversation's Agent-linked browser tab a
 * LOCAL pinned browser: it sorts ahead of every other browser tab inside the
 * dynamic region so the tab the agent drives is always the first Globe pill in
 * the strip. It is deliberately NOT part of the global singleton pin set — it
 * belongs to one conversation, it is not pinnable, and it never appears in
 * `pinnedTabs`.
 *
 * Only browser tabs move. A file, terminal, dispatch, or preview tab keeps its
 * insertion position, so linking a browser never reshuffles unrelated work.
 */
export function normalizeTabs(tabs: readonly SurfaceTab[], agentBrowserInstanceId?: string | null): SurfaceTab[] {
  const seen = new Set<string>()
  const deduped = tabs.filter((tab) => {
    if (seen.has(tab.id)) return false
    seen.add(tab.id)
    return true
  })
  const singletons = SINGLETON_ORDER.flatMap((id) => deduped.filter((tab) => tab.kind === 'singleton' && tab.id === id))
  const dynamics = deduped.filter((tab) => tab.kind !== 'singleton')
  return [...singletons, ...orderLinkedBrowserFirst(dynamics, agentBrowserInstanceId)]
}

/**
 * Move the linked browser tab ahead of the other browser tabs, in place.
 *
 * "In place" is the whole subtlety: the linked tab takes over the position of
 * the FIRST browser tab in the list, and the remaining browsers close up behind
 * it. Non-browser tabs never shift, so a terminal that sat between two browsers
 * stays exactly where the operator left it.
 */
function orderLinkedBrowserFirst(dynamics: readonly SurfaceTab[], agentBrowserInstanceId?: string | null): SurfaceTab[] {
  if (!agentBrowserInstanceId) return [...dynamics]
  const browsers = dynamics.filter((tab) => tab.kind === 'browser')
  const linkedIndex = browsers.findIndex((tab) => tab.kind === 'browser' && tab.instanceId === agentBrowserInstanceId)
  // -1 = the pointer names no live tab here; 0 = already first. Both are no-ops.
  if (linkedIndex <= 0) return [...dynamics]
  const reordered = [browsers[linkedIndex]!, ...browsers.filter((_, index) => index !== linkedIndex)]
  let next = 0
  return dynamics.map((tab) => (tab.kind === 'browser' ? reordered[next++]! : tab))
}

/** Compose global core pins with the current conversation's local descriptors. */
export function composeTabs(
  pinnedTabs: readonly PinnableSingletonId[],
  localTabs: readonly SurfaceTab[],
  agentBrowserInstanceId?: string | null,
): SurfaceTab[] {
  const pins: SurfaceTab[] = pinnedTabs.map((id) => ({ kind: 'singleton', id }))
  const locals = normalizeTabs(
    localTabs.filter((tab) => !(tab.kind === 'singleton' && pinnedTabs.includes(tab.id as PinnableSingletonId))),
    agentBrowserInstanceId,
  )
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
