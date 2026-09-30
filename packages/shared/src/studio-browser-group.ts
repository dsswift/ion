/**
 * The Browser slot: how a conversation's browser descriptors collapse into one
 * Surface tab.
 *
 * Every browser document is still its own descriptor with its own instanceId
 * (that is what the view map, the agent pointer, and persistence key on). What
 * this module decides is presentation: the Surface tab bar shows ONE slot for
 * all of them, and a strip inside the slot lists and switches the documents.
 *
 * Both the tab bar and the strip read the same result, so they cannot disagree
 * about which document is shown or where the slot sits.
 */
import { isBrowserTab, type BrowserTab, type SurfaceTab } from './studio-surface-types'

export interface BrowserGroup {
  /** Every browser descriptor in the conversation, the Agent-linked one first. */
  documents: BrowserTab[]
  /** The document the slot shows, or null when the conversation has none. */
  shown: BrowserTab | null
  /** Index in `tabs` of the first browser descriptor: where the slot sits. -1 when none. */
  slotIndex: number
}

export function isBrowserTabId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('browser:')
}

/**
 * Which document the Browser slot shows.
 *
 * The active tab wins when it is a browser: that is the document on screen.
 * Otherwise the remembered document is used when it still exists, so coming
 * back from a file or terminal lands where the operator left. A stale or
 * absent memory falls back to the first browser, then to null. None of those
 * fallbacks can do anything the operator would object to, which is why the
 * field needs no persistence version bump (contrast the agent pointer, where
 * absent and null had to differ so an unlinked tab was not re-linked).
 */
export function resolveActiveBrowserInstance(
  tabs: readonly SurfaceTab[],
  activeTabId: string | null,
  activeBrowserInstanceId: string | null | undefined,
): string | null {
  const browsers = tabs.filter(isBrowserTab)
  if (browsers.length === 0) return null
  const active = activeTabId ? browsers.find((tab) => tab.id === activeTabId) : undefined
  if (active) return active.instanceId
  if (activeBrowserInstanceId && browsers.some((tab) => tab.instanceId === activeBrowserInstanceId)) return activeBrowserInstanceId
  return browsers[0]!.instanceId
}

export function browserGroup(
  tabs: readonly SurfaceTab[],
  activeTabId: string | null,
  activeBrowserInstanceId: string | null | undefined,
  agentBrowserInstanceId: string | null | undefined,
): BrowserGroup {
  const slotIndex = tabs.findIndex(isBrowserTab)
  if (slotIndex === -1) return { documents: [], shown: null, slotIndex }
  const browsers = tabs.filter(isBrowserTab)
  // `normalizeTabs` already puts the linked document first among browsers;
  // this keeps the promise for a caller that hands over an unnormalized list.
  const linked = agentBrowserInstanceId ? browsers.find((tab) => tab.instanceId === agentBrowserInstanceId) : undefined
  const documents = linked ? [linked, ...browsers.filter((tab) => tab !== linked)] : browsers
  const shownId = resolveActiveBrowserInstance(tabs, activeTabId, activeBrowserInstanceId)
  const shown = documents.find((tab) => tab.instanceId === shownId) ?? null
  return { documents, shown, slotIndex }
}
