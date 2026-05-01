import type { Message } from '../../../shared/types'

/**
 * Serialize conversation messages into compact text context, filtering out
 * plan-mode artifacts. Used to prime a fresh session with prior context.
 */
export function serializeConversation(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.toolName === 'ExitPlanMode' || msg.toolName === 'EnterPlanMode') continue
    if (msg.role === 'user') {
      lines.push(`User: ${msg.content}`)
    } else if (msg.role === 'assistant' && msg.content && !msg.toolName) {
      lines.push(`Assistant: ${msg.content}`)
    }
  }
  return lines.join('\n\n')
}
