/**
 * Agent-linked browser tab logic for the Studio Surface.
 *
 * Every conversation exposes exactly ONE browser tab to the agent's browser
 * tools. The operator may keep as many browser tabs as they like — the link is
 * a single pointer (`agentBrowserInstanceId`) on the conversation, so "two tabs
 * are both the agent's" is unrepresentable rather than merely discouraged.
 *
 * This module holds the transitions that pointer can make. It lives outside
 * `surface-store.ts` because that file is at its size cap; the store keeps the
 * Zustand wiring and delegates the decisions here, which also makes the rules
 * testable without standing up the whole store.
 *
 * The rule that matters most is what does NOT happen: when the linked tab
 * closes, no other tab is adopted. A page the operator prepared for themselves
 * — signed in, mid-flow — must never silently become an agent target because a
 * different tab happened to close. The pointer goes null and the next agent
 * call creates a fresh tab.
 */
import { browserTabId, isBrowserTab, type BrowserSessionMode, type SurfaceConversationPersisted, type SurfaceTab } from '../../../shared/studio-surface-types'
import type { BrowserEmulationState, StudioBrowserTabInfo } from '../../../shared/studio-browser-types'

/** Find one conversation's linked browser descriptor, when it still exists. */
export function linkedBrowserTab(conversation: SurfaceConversationPersisted): Extract<SurfaceTab, { kind: 'browser' }> | null {
  const target = conversation.agentBrowserInstanceId
  if (!target) return null
  return conversation.tabs.find((tab): tab is Extract<SurfaceTab, { kind: 'browser' }> => isBrowserTab(tab) && tab.instanceId === target) ?? null
}

/** Project a browser descriptor into the shape the main process consumes. */
export function browserTabInfo(tab: Extract<SurfaceTab, { kind: 'browser' }>, agentLinked: boolean): StudioBrowserTabInfo {
  return {
    instanceId: tab.instanceId,
    url: tab.url,
    title: tab.title,
    mode: tab.mode,
    sessionMode: tab.sessionMode,
    agentLinked,
    emulation: tab.emulation ?? null,
  }
}

/**
 * Decide the pointer for a conversation that just gained a browser tab.
 *
 * The FIRST browser tab in a conversation links automatically, so the common
 * case — operator opens a browser, then asks the agent to look at it — needs no
 * ceremony at all. Once a link exists it is left alone: additional tabs are the
 * operator's own, and silently stealing the link would move the agent off the
 * page it was working on.
 */
export function pointerAfterOpen(conversation: SurfaceConversationPersisted, openedInstanceId: string): string | null {
  return linkedBrowserTab(conversation) ? conversation.agentBrowserInstanceId : openedInstanceId
}

/** Move the link to an existing browser tab in this conversation. */
export function withLinkedBrowser(conversation: SurfaceConversationPersisted, instanceId: string): SurfaceConversationPersisted {
  const exists = conversation.tabs.some((tab) => isBrowserTab(tab) && tab.instanceId === instanceId)
  if (!exists) return conversation
  return { ...conversation, agentBrowserInstanceId: instanceId, activeTabId: browserTabId(instanceId) }
}

/** Record (or clear, with null) a browser tab's device emulation state. */
export function withBrowserEmulation(
  conversation: SurfaceConversationPersisted,
  instanceId: string,
  emulation: BrowserEmulationState | null,
): SurfaceConversationPersisted {
  return {
    ...conversation,
    tabs: conversation.tabs.map((tab) => {
      if (!isBrowserTab(tab) || tab.instanceId !== instanceId) return tab
      // Strip the key entirely on reset instead of storing an explicit null:
      // absent means "responsive", which is what the descriptor shape and the
      // persistence parser both already treat as the default.
      const { emulation: _previous, ...rest } = tab
      return emulation ? { ...rest, emulation } : rest
    }),
  }
}

/** A newly created browse tab, used when the agent needs a linked tab. */
export function newBrowserTab(url: string, sessionMode: BrowserSessionMode = 'shared'): Extract<SurfaceTab, { kind: 'browser' }> {
  const instanceId = crypto.randomUUID()
  return { kind: 'browser', id: browserTabId(instanceId), instanceId, url, title: url, mode: 'browse', sessionMode }
}

/**
 * The store-facing agent-browser actions.
 *
 * Built as a factory over the store's own primitives so `surface-store.ts`
 * stays thin wiring and these decisions stay testable and readable on their
 * own. `deps` is exactly what these four actions need from the store — no
 * more, so this module cannot quietly grow into a second store.
 */
export interface AgentBrowserDeps {
  /** Current conversation, falling back to the live session target. */
  conversationId(): string | null
  conversation(conversationId: string): SurfaceConversationPersisted | undefined
  /**
   * Apply an update to a NAMED conversation.
   *
   * Addressed rather than implicit so an agent working in a background
   * conversation drives its own browser tab. Using "the current conversation"
   * here would make an agent's tab depend on what the operator is looking at.
   */
  updateConversation(conversationId: string, update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted): void
  /** Reveal the panel. Only meaningful for the on-screen conversation. */
  setVisible(): void
  /** Navigate one browser tab in a named conversation. */
  navigate(conversationId: string, tabId: string, url: string): void
  activate(tabId: string): void
  normalize(tabs: readonly SurfaceTab[], agentBrowserInstanceId: string | null): SurfaceTab[]
  info(message: string, fields: Record<string, string>): void
  debug(message: string, fields: Record<string, string | boolean>): void
}

export interface AgentBrowserActions {
  /** Operator action: hand the agent link to a tab in the visible conversation. */
  linkAgentBrowser(instanceId: string): void
  /**
   * The agent-linked tab for one conversation, created when absent.
   *
   * `conversationId` is REQUIRED and is never chosen by a caller in the tool
   * path: the tool-gate responder derives it from the engine session key and
   * main forwards it on the command. Making it required is what stops an agent
   * from omitting it and silently landing on whatever conversation is on
   * screen, or naming another conversation's browser.
   */
  ensureAgentBrowser(conversationId: string, url?: string): StudioBrowserTabInfo | null
  agentBrowser(conversationId: string): StudioBrowserTabInfo | null
  setBrowserEmulation(conversationId: string, instanceId: string, emulation: BrowserEmulationState | null): void
}

/**
 * Bind the agent-browser actions to a store.
 *
 * Kept here rather than inline in `surface-store.ts` so the wiring lives beside
 * the rules it serves, and so the store file stays under its size cap.
 */
export function bindAgentBrowserActions(io: {
  get: () => { currentConversationId: string | null; conversations: Record<string, SurfaceConversationPersisted>; activateTab(tabId: string): void }
  set: (partial: { visible: boolean }) => void
  fallbackConversationId: () => string | null
  updateConversation: (conversationId: string, update: (current: SurfaceConversationPersisted) => SurfaceConversationPersisted) => void
  normalize: (tabs: readonly SurfaceTab[], agentBrowserInstanceId: string | null) => SurfaceTab[]
  info: (message: string, fields: Record<string, string>) => void
  debug: (message: string, fields: Record<string, string | boolean>) => void
}): AgentBrowserActions {
  return createAgentBrowserActions({
    // The live session target is only a fallback for the operator-driven link
    // verb; the tool path always names its own conversation.
    conversationId: () => io.get().currentConversationId ?? io.fallbackConversationId(),
    conversation: (conversationId) => io.get().conversations[conversationId],
    updateConversation: io.updateConversation,
    setVisible: () => io.set({ visible: true }),
    navigate: (conversationId, tabId, url) => io.updateConversation(conversationId, (current) => ({
      ...current,
      tabs: current.tabs.map((tab) => (tab.id === tabId && tab.kind === 'browser' ? { ...tab, url, title: url } : tab)),
    })),
    activate: (tabId) => io.get().activateTab(tabId),
    normalize: io.normalize,
    info: io.info,
    debug: io.debug,
  })
}

function createAgentBrowserActions(deps: AgentBrowserDeps): AgentBrowserActions {
  return {
    linkAgentBrowser(instanceId) {
      // Operator-driven, so this one IS about the visible conversation.
      const conversationId = deps.conversationId()
      if (!conversationId) return
      const current = deps.conversation(conversationId)
      // `withLinkedBrowser` refuses an instance that is not in this
      // conversation, so a cross-conversation id is a no-op rather than a
      // pointer to a tab the agent could never reach.
      if (!current || current.agentBrowserInstanceId === instanceId) return
      deps.updateConversation(conversationId, (conversation) => withLinkedBrowser(conversation, instanceId))
      deps.setVisible()
      deps.info('agent browser link moved', { tab_id: conversationId, instance_id: instanceId })
    },

    ensureAgentBrowser(conversationId, url) {
      if (!conversationId) return null
      // Only reveal and focus when the tab belongs to what is on screen. A
      // background agent must not steal the operator's view.
      const onScreen = conversationId === deps.conversationId()
      const linked = (() => {
        const existing = deps.conversation(conversationId)
        return existing ? linkedBrowserTab(existing) : null
      })()
      if (linked) {
        // Reuse the linked tab. A url navigates it; it never spawns a second
        // tab, because the agent is limited to one browser per conversation.
        if (url && url !== linked.url) deps.navigate(conversationId, linked.id, url)
        if (onScreen) {
          deps.activate(linked.id)
          deps.setVisible()
        }
        const refreshed = deps.conversation(conversationId)
        const current = refreshed ? linkedBrowserTab(refreshed) : null
        return browserTabInfo(current ?? linked, true)
      }
      const tab = newBrowserTab(url ?? 'about:blank')
      deps.updateConversation(conversationId, (conversation) => ({
        ...conversation,
        tabs: deps.normalize([...conversation.tabs, tab], tab.instanceId),
        // Selecting the new tab is only correct for the conversation the
        // operator is in; a background conversation keeps whatever it had.
        activeTabId: onScreen ? tab.id : conversation.activeTabId,
        agentBrowserInstanceId: tab.instanceId,
      }))
      if (onScreen) deps.setVisible()
      deps.info('agent browser tab created', { tab_id: conversationId, instance_id: tab.instanceId })
      return browserTabInfo(tab, true)
    },

    agentBrowser(conversationId) {
      const current = conversationId ? deps.conversation(conversationId) : undefined
      const linked = current ? linkedBrowserTab(current) : null
      return linked ? browserTabInfo(linked, true) : null
    },

    setBrowserEmulation(conversationId, instanceId, emulation) {
      if (!conversationId) return
      deps.updateConversation(conversationId, (current) => withBrowserEmulation(current, instanceId, emulation))
      deps.debug('browser emulation state stored', { instance_id: instanceId, emulated: emulation !== null })
    },
  }
}
