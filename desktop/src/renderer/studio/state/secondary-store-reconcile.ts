/**
 * secondary-store-reconcile — reconciliation helpers for forwarded mirror
 * actions, split out of secondary-store.ts to stay under the file-size cap.
 * Attachment reconciliation predicts the owner's optimistic tab mutation
 * locally; rewind reconciliation restores the Studio-local composer after
 * the owner accepts a forwarded rewind.
 */
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { FileAttachment } from '@ion/shared/types'
import type { RewindResult } from '@ion/server/store/session-store-types'
import type { CloseIntent } from '@ion/server/store/session-store-aux-types'
import { rInfo, rWarn } from '../../rendererLogger'

export function reconcileAttachmentTabs(
  tabs: ReturnType<typeof useSessionStore.getState>['tabs'],
  activeTabId: string | null,
  action: string,
  args: unknown[],
): ReturnType<typeof useSessionStore.getState>['tabs'] {
  if (!activeTabId || !['addAttachments', 'removeAttachment', 'clearAttachments'].includes(action)) return tabs

  return tabs.map((tab) => {
    if (tab.id !== activeTabId) return tab
    if (action === 'addAttachments' && Array.isArray(args[0])) {
      return { ...tab, attachments: [...tab.attachments, ...(args[0] as FileAttachment[])] }
    }
    if (action === 'removeAttachment' && typeof args[0] === 'string') {
      return { ...tab, attachments: tab.attachments.filter((attachment) => attachment.id !== args[0]) }
    }
    if (action === 'clearAttachments') return { ...tab, attachments: [] }
    return tab
  })
}

export function reconcileForwardedAttachments(action: string, args: unknown[]): void {
  useSessionStore.setState((state) => ({
    tabs: reconcileAttachmentTabs(state.tabs, state.activeTabId, action, args),
  }))
}

/**
 * Restore the rewound turn in the Studio-local composer after the owner accepts
 * a forwarded rewind. History replacement and composer restoration are separate
 * state changes: the former removes the stale transcript tail, while this result
 * carries the user text and resendable attachments that no longer exist in that
 * transcript.
 */
export function reconcileForwardedRewind(action: string, args: unknown[], value: unknown): boolean {
  if (action !== 'rewindEngineInstance') return false
  const result = value as RewindResult | undefined
  if (!result?.ok) return false
  const tabId = args[0]
  const instanceId = args[1]
  const prefill = result.prefill
  if (
    typeof tabId !== 'string' || typeof instanceId !== 'string' ||
    typeof prefill?.text !== 'string' || !Array.isArray(prefill.attachments)
  ) {
    rWarn('studio.mirror', 'rewind prefill result malformed, ignored', {
      tab_id: typeof tabId === 'string' ? tabId : '',
      instance_id: typeof instanceId === 'string' ? instanceId : '',
    })
    return false
  }

  const current = useSessionStore.getState()
  const pane = current.conversationPanes.get(tabId)
  const instanceIndex = pane?.instances.findIndex((instance) => instance.id === instanceId) ?? -1
  if (!pane || instanceIndex < 0 || !current.tabs.some((tab) => tab.id === tabId)) {
    rWarn('studio.mirror', 'rewind prefill target missing, ignored', {
      tab_id: tabId,
      instance_id: instanceId,
    })
    return false
  }

  const instances = pane.instances.slice()
  instances[instanceIndex] = { ...instances[instanceIndex], draftInput: prefill.text }
  const conversationPanes = new Map(current.conversationPanes)
  conversationPanes.set(tabId, { ...pane, instances })
  useSessionStore.setState({
    conversationPanes,
    tabs: current.tabs.map((tab) => tab.id === tabId
      ? { ...tab, pendingInput: prefill.text, attachments: prefill.attachments }
      : tab),
  })
  rInfo('studio.mirror', 'rewind prefill restored', {
    tab_id: tabId,
    instance_id: instanceId,
    text_length: prefill.text.length,
    attachment_count: prefill.attachments.length,
  })
  return true
}

/**
 * Apply the owner's raised close intent locally after a forwarded
 * `requestCloseTab`. The close dialog is per-window (the operator who clicked
 * X is the one who must answer), so the owner's `set()` alone — which only
 * updates the OWNER's own `closeIntent` — would never surface the dialog in
 * the window that actually asked. The action's return value carries the
 * resolved intent (or null when the owner refused/no-op'd) so this window can
 * mirror it onto its own `closeIntent` without a broadcast that would pop the
 * dialog in every connected window instead of just this one.
 */
export function reconcileForwardedCloseIntent(action: string, value: unknown): boolean {
  if (action !== 'requestCloseTab') return false
  const intent = value as CloseIntent | null | undefined
  useSessionStore.setState({ closeIntent: intent ?? null })
  return true
}

/**
 * Apply a forwarded `setDraftInput` to the mirror's own pane immediately,
 * before the wire round trip resolves.
 *
 * The draft is owner-durable (the server persists it), but it is also the text
 * under the operator's cursor, and the composer reads it back out of the mirror
 * the instant they switch tabs. Waiting for the server's tabs-sync to carry the
 * value home leaves a window in which switching away and straight back reads
 * the PREVIOUS draft and paints it over what was just typed. Same reasoning as
 * the optimistic `selectTab` in the forwarder, with one difference: a failed
 * round trip does NOT roll this back. The rolled-back value would be the
 * operator's own words, and dropping them because a socket was busy is the
 * exact loss this whole path exists to prevent.
 */
export function applyOptimisticDraft(action: string, args: unknown[]): boolean {
  if (action !== 'setDraftInput') return false
  const [tabId, text] = args
  if (typeof tabId !== 'string' || typeof text !== 'string') return false
  const current = useSessionStore.getState()
  const pane = current.conversationPanes.get(tabId)
  if (!pane) return false
  const index = pane.instances.findIndex((instance) => instance.id === pane.activeInstanceId)
  const target = index >= 0 ? index : 0
  if (!pane.instances[target] || pane.instances[target].draftInput === text) return false
  const instances = pane.instances.slice()
  instances[target] = { ...instances[target], draftInput: text }
  const conversationPanes = new Map(current.conversationPanes)
  conversationPanes.set(tabId, { ...pane, instances })
  useSessionStore.setState({ conversationPanes })
  return true
}
