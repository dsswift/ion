/**
 * engine-history — an engine instance's message list, shaped for the Studio
 * mirror's history replace after a rewind restart.
 *
 * A thin client needs nothing from here: the rewind's shortened list reaches
 * it as a transcript patch, like any other store change.
 */

import { useSessionStore } from '../../store/sessionStore'

/** One message of a Studio mirror history replace. */
export interface EngineHistoryMessage {
  id: string
  role: string
  content: string
  toolName?: string
  toolId?: string
  toolStatus?: string
  timestamp: number
  dedupKey?: string
  dedupMode?: 'relocate'
  implementationPhase?: boolean
  /** How the turn was authored (engine InjectionKind wire value).
   *  'structured_answer' marks a Guided Questions submission, which the
   *  Studio mirror renders with its own transcript chrome rather than as an
   *  ordinary user bubble. */
  injectionKind?: string
  /** Plan path on plan-lifecycle divider system messages, so the slug stays
   * clickable after a history replace. Omitted on non-divider messages. */
  planFilePath?: string
  /** Image/file references carried through on a rewind history replay.
   * Omitted when the message has no attachments. */
  attachments?: Array<{ id: string; type: string; name: string; path: string; contentHash?: string }>
}

/**
 * Read an engine instance's message list out of the store. Resolves the
 * active instance when `instanceId` is null (matching the load-conversation
 * default). Read by the rewind's Studio history replace.
 *
 * Returns the resolved `instanceId` and the wire-shaped `messages`.
 */
export function readEngineHistoryFromStore(
  tabId: string,
  instanceId: string | null,
): { instanceId: string | null; messages: EngineHistoryMessage[] } {
  const pane = useSessionStore.getState().conversationPanes.get(tabId)
  if (!pane) return { instanceId, messages: [] }
  // Resolve the target instance:
  //   1. If a specific instanceId was passed in, find it directly.
  //   2. Otherwise (bare-key, post-#256 path) use the pane's activeInstanceId,
  //      falling back to the first instance (always 'main' after #256).
  const inst = instanceId
    ? pane.instances.find((i) => i.id === instanceId)
    : (pane.instances.find((i) => i.id === pane.activeInstanceId) ?? pane.instances[0] ?? null)
  const resolvedId = inst?.id ?? null
  const msgs = inst?.messages ?? []
  const mapped: EngineHistoryMessage[] = msgs.map((m) => {
    let content = m.content ?? ''
    if (m.role === 'tool' && content.length > 2048) content = content.substring(0, 2048) + '\n... [truncated]'
    const mm = m as unknown as {
      id: string; role: string; toolName?: string; toolId?: string; toolStatus?: string; timestamp: number
      dedupKey?: string; dedupMode?: 'relocate'; implementationPhase?: boolean; injectionKind?: string; planFilePath?: string
      attachments?: Array<{ id: string; type: string; name: string; path: string; contentHash?: string }>
    }
    const out: EngineHistoryMessage = { id: mm.id, role: mm.role, content, toolName: mm.toolName, toolId: mm.toolId, toolStatus: mm.toolStatus, timestamp: mm.timestamp }
    // Carry dedupKey through so the mirror's rebuilt rows keep it.
    if (mm.dedupKey) out.dedupKey = mm.dedupKey
    if (mm.dedupMode) out.dedupMode = mm.dedupMode
    if (mm.implementationPhase) out.implementationPhase = true
    // Carry the authorship classification so a Guided Questions submission
    // keeps its transcript chrome after a reload on the Studio mirror, which
    // rebuilds each Message from this projection.
    if (mm.injectionKind) out.injectionKind = mm.injectionKind
    // Carry planFilePath through so plan-lifecycle divider system messages
    // (Plan created / Plan updated / Implementing plan) stay clickable after
    // a history replace.
    if (mm.planFilePath) out.planFilePath = mm.planFilePath
    // Carry image/file attachments through so engine-conversation images
    // survive a rewind history replay. Without this, images are dropped
    // after rewind.
    if (mm.attachments && mm.attachments.length > 0) {
      out.attachments = mm.attachments.map((a) => ({ id: a.id, type: a.type, name: a.name, path: a.path, ...(a.contentHash ? { contentHash: a.contentHash } : {}) }))
    }
    return out
  })
  return { instanceId: resolvedId, messages: mapped }
}
