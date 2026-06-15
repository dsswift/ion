import type { StoreSet } from '../session-store-types'
import { nextMsgId } from '../session-store-helpers'
import type { ConversationPane } from '../../../shared/types'
import type { Message } from '../../../shared/types-session'
import { parseSessionKey } from '../../../shared/session-key'

/**
 * Return a new conversationPanes Map with `instance.messages` replaced for the
 * instance identified by `key` (`${tabId}:${instanceId}`). No-ops silently
 * when the pane or instance is not found (event arrived before pane was
 * registered — safe to ignore).
 */
function withInstanceMessages(
  conversationPanes: Map<string, ConversationPane>,
  key: string,
  messages: Message[],
): Map<string, ConversationPane> {
  const { tabId, instanceId } = parseSessionKey(key)
  const pane = conversationPanes.get(tabId)
  if (!pane) return conversationPanes
  const idx = pane.instances.findIndex((i) => i.id === instanceId)
  if (idx === -1) return conversationPanes
  const updated = new Map(conversationPanes)
  const instances = pane.instances.slice()
  instances[idx] = { ...instances[idx], messages }
  updated.set(tabId, { ...pane, instances })
  return updated
}

/**
 * Handler for `engine_intercept` events on engine-view tabs (compound
 * `${tabId}:${instanceId}` key). Extracted from engine-event-slice.ts
 * to keep that file under the 600-line TypeScript cap.
 *
 * Renders an inline banner in the conversation scrollback so the user
 * can see that an intercept fired — which extension triggered it,
 * what it said, and whether the run was redirected. Uses role:
 * 'harness' so the groupMessages pipeline routes it through the
 * InterceptBanner component (via tool-helpers kind: 'intercept').
 * The `interceptLevel` field on the message lets InterceptBanner
 * choose visual weight: 'redirect' gets the amber/urgent style;
 * 'banner' gets a lighter informational style.
 *
 * Content format: markdown so the title renders as bold and the
 * body gets normal prose treatment. The level prefix ("Conversation
 * redirected:") is prepended for 'redirect' level so the user sees
 * the action label even if the title is terse.
 */
export function handleEngineInterceptEvent(
  set: StoreSet,
  key: string,
  event: { interceptLevel: string; interceptTitle: string; interceptMessage: string },
): void {
  const levelPrefix = event.interceptLevel === 'redirect' ? 'Conversation redirected: ' : ''
  const content = `**${levelPrefix}${event.interceptTitle}**\n\n${event.interceptMessage}`
  set((state) => {
    const { tabId, instanceId } = parseSessionKey(key)
    const pane = state.conversationPanes.get(tabId)
    const inst = pane?.instances.find((i) => i.id === instanceId)
    const msgs = [...(inst?.messages || []), {
      id: nextMsgId(),
      role: 'harness' as const,
      content,
      timestamp: Date.now(),
      interceptLevel: event.interceptLevel,
    }]
    const conversationPanes = withInstanceMessages(state.conversationPanes, key, msgs)
    return { conversationPanes }
  })
}
