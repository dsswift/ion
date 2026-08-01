import type { Message } from '../../../shared/types-session'
import { stripAttachmentMarkers } from './message-text'

/**
 * Pure geometry + derivation helpers for the conversation timeline minimap.
 * Ported from T3 code's MessagesTimeline.logic.ts (pingdotgg/t3code) and
 * adapted to Ion's plain-DOM transcript (no virtual list).
 */

/** Vertical space between two adjacent ticks on the rail, in px. */
export const TIMELINE_MINIMAP_ITEM_SPACING = 8
/**
 * Render whenever there is at least one chapter to point at. (T3 requires 2;
 * Ion keeps the rail persistent, so a single-message conversation still shows
 * its tick.)
 */
export const TIMELINE_MINIMAP_MIN_ITEMS = 1
/** The rail never grows past the viewport minus breathing room. */
export const TIMELINE_MINIMAP_MAX_HEIGHT_CSS = 'calc(100vh - 18rem)'
/**
 * Width of the dedicated minimap gutter, px. The gutter is reserved layout
 * space (a flex sibling of the scroll container), so the transcript can
 * never render underneath the rail. Sized to the rail inset plus the widest
 * tick (24px) plus breathing room.
 */
export const TIMELINE_MINIMAP_GUTTER_WIDTH = 36
/** Left inset of the rail/ticks inside the gutter, px. */
export const TIMELINE_MINIMAP_RAIL_INSET = 8
/**
 * While the preview tooltip is open, the interactive strip widens so the
 * pointer can travel from the rail into the preview without dropping hover.
 */
export const TIMELINE_MINIMAP_EXPANDED_STRIP_WIDTH = '22rem'
/** Scroll offset applied above the target message when jumping, px. */
export const TIMELINE_MINIMAP_JUMP_OFFSET = 24

export interface TimelineMinimapItem {
  readonly id: string
  readonly userText: string
  readonly assistantText: string | null
}

/**
 * Natural rail height distributes ticks ITEM_SPACING apart, capped so the
 * rail never exceeds the viewport.
 */
export function resolveTimelineMinimapHeightStyle(itemCount: number): string {
  const naturalHeight = Math.max(1, (itemCount - 1) * TIMELINE_MINIMAP_ITEM_SPACING)
  return `min(${naturalHeight}px, ${TIMELINE_MINIMAP_MAX_HEIGHT_CSS})`
}

/** Even distribution: index 0 at 0%, last index at 100%. */
export function resolveTimelineMinimapTopPercent(index: number, itemCount: number): number {
  if (itemCount <= 1) {
    return 0
  }
  return (Math.max(0, Math.min(index, itemCount - 1)) / (itemCount - 1)) * 100
}

/** Nearest tick index for a pointer Y position over the rail. */
export function resolveTimelineMinimapIndexFromPointer(input: {
  readonly itemCount: number
  readonly railTop: number
  readonly railHeight: number
  readonly pointerY: number
}): number | null {
  if (input.itemCount <= 0 || input.railHeight <= 0) {
    return null
  }
  if (input.itemCount === 1) {
    return 0
  }

  const progress = Math.max(0, Math.min(1, (input.pointerY - input.railTop) / input.railHeight))
  return Math.max(0, Math.min(input.itemCount - 1, Math.round(progress * (input.itemCount - 1))))
}

/**
 * The preview tooltip anchors to the active tick's top percent. At the rail's
 * ends it translates so it never overflows the rail box: first tick hangs
 * down (0%), last tick hangs up (-100%), everything else centers (-50%).
 */
export function resolveTooltipTranslate(index: number, itemCount: number): string {
  if (index <= 0) {
    return '0%'
  }
  if (index >= itemCount - 1) {
    return '-100%'
  }
  return '-50%'
}

/** Whitespace-collapsed single-line preview; null when nothing remains. */
export function compactMinimapPreview(text: string | null | undefined): string | null {
  const compact = text?.replace(/\s+/g, ' ').trim() ?? ''
  return compact.length > 0 ? compact : null
}

/**
 * One minimap item per user message ("chapter"), paired with the final
 * assistant reply of that turn (the last assistant message with content
 * before the next user message). User messages whose compact text is empty
 * (e.g. attachment-only) are skipped — a tick needs a title.
 */
export function deriveTimelineMinimapItems(
  messages: ReadonlyArray<Message>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role !== 'user') {
      continue
    }
    const userText = compactMinimapPreview(stripAttachmentMarkers(message.content || ''))
    if (userText === null) {
      continue
    }
    items.push({
      id: message.id,
      userText,
      assistantText: compactMinimapPreview(resolveFinalAssistantTextForTurn(messages, index)),
    })
  }
  return items
}

function resolveFinalAssistantTextForTurn(
  messages: ReadonlyArray<Message>,
  userIndex: number,
): string | null {
  let finalAssistantText: string | null = null
  for (let index = userIndex + 1; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.role === 'user') {
      break
    }
    if (message.role === 'assistant' && (message.content || '').trim().length > 0) {
      finalAssistantText = message.content
    }
  }
  return finalAssistantText
}
