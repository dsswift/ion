/**
 * Pure text helpers for conversation message bodies. Neutral module —
 * shared by the transcript (MessageBubble) and the timeline minimap so the
 * preview and the rendered bubble agree on what the "text" of a message is.
 */

/** Strip Ion's inline attachment markers from a message body. */
export function stripAttachmentMarkers(text: string): string {
  return text
    .replace(/^\[Attached (?:image|file): [^\]]+\]\n*/gm, '')
    .replace(/^\[Attachment: [^\]]+ \(content attached\)\]\n*/gm, '')
}

/**
 * Remove model-facing wrapper text from legacy Guided Questions rows.
 *
 * New rows persist a separate displayText. This narrow fallback keeps cards
 * written by older builds useful after upgrade without changing ordinary turns.
 */
export function structuredAnswerDisplayText(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.startsWith('My answers to "') && lines[0].endsWith('":')) {
    lines.shift()
    if (lines[0] === '') lines.shift()
  }

  const continuation = lines.findIndex((line) =>
    line.startsWith('I want more questions on this topic. Call AskUserQuestions again with workflowId '),
  )
  if (continuation >= 0) lines.splice(continuation)

  return lines
    .join('\n')
    .replace(/^- Agent decides \(explicitly delegated to you\)$/gm, '- Agent decides')
    .trim()
}
