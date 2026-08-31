export interface TranscriptMessage {
  role: string
  content?: string | null
}

/** Format the canonical human-readable conversation transcript. */
export function formatConversationTranscript(messages: readonly TranscriptMessage[]): string {
  return messages
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && (message.content?.trim().length ?? 0) > 0)
    .map((message) => `[${message.role}]: ${message.content ?? ''}`)
    .join('\n\n')
}
