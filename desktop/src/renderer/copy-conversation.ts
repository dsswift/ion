import type { TabState } from '../shared/types'
import { orderedSessionIds } from '../shared/tab-predicates'
import { rError, rInfo, rWarn } from './rendererLogger'

interface CopyTargetInstance {
  conversationIds?: readonly string[]
  statusFields?: { sessionId?: string | null } | null
}

export async function copyConversationTranscript(tabId: string): Promise<boolean> {
  try {
    const transcript = await window.ion.loadConversationTranscript(tabId)
    if (!transcript) {
      rWarn('conversation-copy', 'transcript copy skipped because transcript is empty', { tab_id: tabId.slice(0, 8) })
      return false
    }
    await navigator.clipboard.writeText(transcript)
    rInfo('conversation-copy', 'transcript copied', { tab_id: tabId.slice(0, 8), chars: transcript.length })
    return true
  } catch (error) {
    rError('conversation-copy', 'transcript copy failed', { tab_id: tabId.slice(0, 8), error: String(error) })
    return false
  }
}

export async function copyConversationSessionIds(tab: TabState, instance?: CopyTargetInstance | null): Promise<boolean> {
  const ids = orderedSessionIds(tab, instance)
  if (ids.length === 0) {
    rWarn('conversation-copy', 'session id copy skipped because identity is absent', { tab_id: tab.id.slice(0, 8) })
    return false
  }
  try {
    await navigator.clipboard.writeText(ids.join('\n'))
    rInfo('conversation-copy', 'session id copied', { tab_id: tab.id.slice(0, 8), session_count: ids.length })
    return true
  } catch (error) {
    rError('conversation-copy', 'session id copy failed', { tab_id: tab.id.slice(0, 8), error: String(error) })
    return false
  }
}
