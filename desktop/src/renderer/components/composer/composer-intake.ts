/**
 * Pure rules for content arriving in the composer by paste or drop.
 */

/** Pasted text longer than this becomes an attachment instead of prompt text. */
export const LARGE_PASTE_BYTES = 32 * 1024

export type PasteDecision =
  | { kind: 'inline' }
  | { kind: 'fold'; bytes: number }

/**
 * A paste past the threshold is folded into a text attachment: it keeps the
 * prompt readable and the editor responsive, and the model still receives all
 * of it. `raw` is the operator's explicit "paste it as typed" override.
 */
export function decideTextPaste(text: string, raw: boolean): PasteDecision {
  if (raw) return { kind: 'inline' }
  const bytes = new TextEncoder().encode(text).length
  return bytes > LARGE_PASTE_BYTES ? { kind: 'fold', bytes } : { kind: 'inline' }
}

/** Standard base64 of `bytes`, chunked so a large buffer never overflows the call stack. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function textToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text))
}

/** True for the raw-paste chord: the platform modifier + Shift + V. */
export function isRawPasteChord(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'metaKey' | 'ctrlKey'>): boolean {
  return event.shiftKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v'
}
