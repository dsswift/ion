/**
 * Speech-bubble state: which bubble floats above a character and for how
 * long. Each kind is a distinct live-state signal (waiting, permission,
 * error, dispatch-mail).
 */
import type { StudioBubbleKind } from '../../../../shared/types-studio'

export interface BubbleState {
  kind: StudioBubbleKind
  /** Remaining seconds; Infinity = until explicitly cleared. */
  ttl: number
}

/** Default display seconds per bubble kind. */
export const BUBBLE_TTL: Record<StudioBubbleKind, number> = {
  waiting: 4,
  permission: Infinity,
  error: Infinity,
  dispatch: 3,
  // Attention bubbles persist until the user acts (plan approved / question
  // answered — cleared by the next running status).
  plan: Infinity,
  question: Infinity,
}

export function showBubble(kind: StudioBubbleKind): BubbleState {
  return { kind, ttl: BUBBLE_TTL[kind] }
}

/** Advance a bubble's ttl; returns the bubble or null when expired. */
export function tickBubble(bubble: BubbleState | null, dt: number): BubbleState | null {
  if (!bubble) return null
  if (bubble.ttl === Infinity) return bubble
  bubble.ttl -= dt
  return bubble.ttl > 0 ? bubble : null
}
