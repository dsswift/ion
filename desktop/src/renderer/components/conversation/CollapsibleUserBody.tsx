import React, { useState } from 'react'
import { useColors } from '../../theme'

/** t3code-parity thresholds (MessagesTimeline.tsx): a user message longer
 * than 600 chars or 8 lines collapses by default. */
export const MAX_COLLAPSED_USER_MESSAGE_LENGTH = 600
export const MAX_COLLAPSED_USER_MESSAGE_LINES = 8

/** Exported for the test — jsdom's CSSOM drops mask-image, so the fade is
 * pinned via this constant + the data-user-message-fade attribute. */
export const FADE_MASK = 'linear-gradient(to bottom, black calc(100% - 1.75rem), transparent)'

export function shouldCollapseUserMessage(text: string): boolean {
  if (text.trim().length === 0) return false
  return (
    text.length > MAX_COLLAPSED_USER_MESSAGE_LENGTH ||
    text.split('\n').length > MAX_COLLAPSED_USER_MESSAGE_LINES
  )
}

/**
 * Collapsible wrapper for long user-message bodies. Collapsed state is
 * component-local (no persistence, no store action — ATV parity is free by
 * construction), height-capped with a bottom fade mask rather than a hard
 * clip, and toggled by a ghost footer button. The hover CopyButton on the
 * bubble is unaffected: it copies the full text regardless of collapse.
 */
export function CollapsibleUserBody({
  text,
  children,
}: {
  /** The full message text — drives the collapse decision only. */
  text: string
  children: React.ReactNode
}) {
  const colors = useColors()
  const [expanded, setExpanded] = useState(false)
  const canCollapse = shouldCollapseUserMessage(text)
  const isCollapsed = canCollapse && !expanded

  if (!canCollapse) return <>{children}</>

  return (
    // max-w-full on this wrapper AND the body div: both live in column-flex
    // layouts (items-end), where a child's width is its fit-content width and
    // can silently overflow the bubble column's max-w-[85%] cap. A wide code
    // block inside the bubble must be clamped at every link of the chain for
    // the <pre>'s overflow-x scrolling to engage (see MessageBubble.test).
    <div className="flex flex-col items-end min-w-0 max-w-full">
      <div
        className="max-w-full min-w-0"
        data-user-message-collapsed={isCollapsed ? 'true' : 'false'}
        data-user-message-fade={isCollapsed ? 'true' : 'false'}
        style={
          isCollapsed
            ? {
              maxHeight: '11rem',
              overflow: 'hidden',
              WebkitMaskImage: FADE_MASK,
              maskImage: FADE_MASK,
            }
            : undefined
        }
      >
        {children}
      </div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 px-1.5 py-0.5 rounded-md text-[11px] cursor-pointer self-end"
        style={{ color: colors.textTertiary, background: 'transparent', border: 'none' }}
      >
        {expanded ? 'Show less' : 'Show full message'}
      </button>
    </div>
  )
}
