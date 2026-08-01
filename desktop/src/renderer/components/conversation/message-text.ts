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
