export const ATTACHMENT_ONLY_PROMPT = 'Analyze the attached files.'

/**
 * Give an attachment-only turn an explicit model task while preserving every
 * user-written prompt byte-for-byte. The Desktop main-process prompt pipeline
 * is the shared dispatch seam for Desktop and iOS, and the Input Bar also uses
 * this helper so its optimistic turn matches what the model receives.
 */
export function resolveAttachmentPrompt(text: string, attachmentCount: number): string {
  if (text.trim().length === 0 && attachmentCount > 0) {
    return ATTACHMENT_ONLY_PROMPT
  }
  return text
}
