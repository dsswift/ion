import { activeAssistantMessages, engineBridge } from './state'
import { log as _log } from './logger'
import { mapSessionHistory } from '../shared/session-message-mapper'
import { formatConversationTranscript } from '../shared/conversation-transcript'
import { resolveTabSessionChain } from './remote/handlers/tabs-session-chain'

/** Load one complete canonical transcript without depending on renderer hydration. */
export async function loadConversationTranscript(tabId: string): Promise<string> {
  _log('main', 'conversation_transcript: requested', { tab_id: tabId })
  try {
    const chain = await resolveTabSessionChain(tabId)
    if (!chain) throw new Error('conversation session chain not found')
    _log('main', 'conversation_transcript: source resolved', {
      tab_id: tabId, source: chain.source, session_count: chain.sessionIds.length,
    })
    const history = await engineBridge.loadChainHistory(chain.sessionIds)
    let fallbackSeq = 0
    const messages = mapSessionHistory(history, () => `transcript-${tabId}-${fallbackSeq++}`)
    const tail = activeAssistantMessages.get(tabId)
    if (tail?.content && (chain.tabStatus === 'running' || chain.tabStatus === 'connecting')) {
      messages.push({ id: tail.id, role: 'assistant', content: tail.content, timestamp: Date.now() })
    }
    const transcript = formatConversationTranscript(messages)
    if (!transcript) _log('main', 'conversation_transcript: empty', { tab_id: tabId, source: chain.source, session_count: chain.sessionIds.length })
    else _log('main', 'conversation_transcript: loaded', { tab_id: tabId, source: chain.source, session_count: chain.sessionIds.length, chars: transcript.length })
    return transcript
  } catch (error) {
    _log('main', 'conversation_transcript: failed', { tab_id: tabId, error: String(error) })
    throw error
  }
}
