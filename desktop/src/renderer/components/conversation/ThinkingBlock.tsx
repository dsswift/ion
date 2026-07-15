import React, { useState, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { CaretRight, CaretDown, Brain, LockSimple } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { Message } from '../../../shared/types'
import {
  PREVIEW_LINES,
  PREVIEW_CHAR_BUDGET,
  tailForPreview,
  buildSummary,
  isExpandable as computeExpandable,
} from './thinking-block-helpers'

/**
 * ThinkingBlock — collapsed-by-default extended-thinking affordance
 * (issue #158, Phase 3 desktop).
 *
 * Renders the model's reasoning for a turn, positioned ABOVE the tool row
 * (AgentTurnGroup hoists it into the turn header). Most turns carry no
 * thinking block at all; when one is present it stays collapsed unless the
 * user clicks to expand.
 *
 * The component is driven entirely by a synthesized `role: 'thinking'`
 * Message whose fields the engine-event-slice stamps from the engine's
 * `engine_thinking_block_start` / `engine_thinking_delta` /
 * `engine_thinking_block_end` trio. It picks one of THREE render states
 * from those fields — never promising text it does not have:
 *
 *   1. LIVE (`thinkingActive === true`): the block is streaming. A pulsing
 *      "Thinking…" indicator shows, and the collapsed view tails the last
 *      few lines of `content` as deltas arrive. If deltas are disabled the
 *      content stays empty and the live view shows just the pulse.
 *
 *   2. HISTORICAL-WITH-TEXT (`thinkingActive === false`, non-empty
 *      `content`): deltas were captured. Collapsed shows the last 2-3
 *      lines; expanding reveals the full reasoning text. The header shows
 *      the "💭 Thought for {n}s" summary when block_end provided one.
 *
 *   3. SUMMARY-ONLY (`thinkingActive === false`, empty `content`): deltas
 *      were disabled, the block was redacted, or the row was rehydrated
 *      from history without text. Renders the summary only:
 *      "🔒 redacted reasoning" when `thinkingRedacted`, otherwise
 *      "💭 Thought for {n}s" + token estimate. There is nothing to expand,
 *      so the caret/expand affordance is suppressed.
 */

interface ThinkingBlockProps {
  message: Message
  skipMotion?: boolean
}

export const ThinkingBlock = React.memo(function ThinkingBlock({
  message,
  skipMotion,
}: ThinkingBlockProps) {
  const colors = useColors()
  const [expanded, setExpanded] = useState(false)

  const isActive = !!message.thinkingActive
  const fullText = message.content || ''
  const hasText = fullText.trim().length > 0
  const isRedacted = !!message.thinkingRedacted
  const summary = useMemo(() => buildSummary(message), [message])

  // Whether the block can be expanded to reveal more than the header.
  // Summary-only (no text) has nothing to expand; live/historical with
  // text are both expandable (the user can pin the full reasoning open
  // while it streams). Single source of truth in thinking-block-helpers.
  const expandable = computeExpandable(message)

  const preview = useMemo(
    () => (hasText ? tailForPreview(fullText, PREVIEW_CHAR_BUDGET) : ''),
    [fullText, hasText],
  )

  // Header label depends on the render state.
  const headerLabel = isActive
    ? 'Thinking…'
    : isRedacted
      ? '🔒 redacted reasoning'
      : summary || (hasText ? 'Reasoning' : 'Thought')

  const header = (
    <div
      className={`flex items-center gap-1.5 py-1 select-none ${expandable ? 'cursor-pointer' : 'cursor-default'}`}
      data-ion-ui
      onClick={expandable ? () => setExpanded((v) => !v) : undefined}
    >
      {expandable ? (
        expanded ? (
          <CaretDown size={11} className="flex-shrink-0" style={{ color: colors.textMuted }} />
        ) : (
          <CaretRight size={11} className="flex-shrink-0" style={{ color: colors.textTertiary }} />
        )
      ) : (
        // Summary-only / redacted: no caret (nothing to expand). Keep the
        // icon column aligned with expandable rows by reserving the width.
        <span style={{ width: 11, display: 'inline-block' }} />
      )}
      {isRedacted ? (
        <LockSimple size={11} className="flex-shrink-0" style={{ color: colors.textTertiary }} />
      ) : (
        <Brain
          size={11}
          className={`flex-shrink-0 ${isActive ? 'animate-pulse' : ''}`}
          style={{ color: isActive ? colors.statusRunning : colors.textTertiary }}
        />
      )}
      <span
        className="text-[11px] leading-[1.4]"
        style={{ color: isActive ? colors.textSecondary : colors.textTertiary }}
      >
        {headerLabel}
      </span>
    </div>
  )

  // The collapsed/streaming preview tail — shown when there is text and the
  // block is not expanded. While active this updates live as deltas arrive.
  //
  // Outer container: clamps to exactly PREVIEW_LINES visual rows via
  // maxHeight calc, bottom-anchors content (justifyContent: 'flex-end') so
  // new streamed text pushes older text up into the clipped overflow, and
  // carries the top-fade mask.
  // Inner text div: full whitespace-pre-wrap content at content font size.
  const previewBlock =
    !expanded && hasText ? (
      <div
        style={{
          maxHeight: `calc((var(--ion-conv-font-size, 13px) - 2px) * 1.45 * ${PREVIEW_LINES})`,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'flex-end',
          maskImage: 'linear-gradient(to bottom, transparent, black 28%)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 28%)',
        }}
      >
        <div
          className="ml-1 pl-3 leading-[1.45] whitespace-pre-wrap break-words"
          style={{
            fontSize: 'calc(var(--ion-conv-font-size, 13px) - 2px)',
            color: colors.textTertiary,
            borderLeft: `1px solid ${colors.timelineLine}`,
            opacity: isActive ? 1 : 0.9,
          }}
        >
          {preview}
        </div>
      </div>
    ) : null

  const inner = (
    <div className="group/thinking relative">
      {header}
      {previewBlock}
      <AnimatePresence initial={false}>
        {expanded && hasText && (
          <motion.div
            key="thinking-full"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            style={{ overflow: 'hidden' }}
          >
            <div
              className="ml-1 pl-3 mb-1 leading-[1.5] whitespace-pre-wrap break-words"
              style={{
                fontSize: 'calc(var(--ion-conv-font-size, 13px) - 2px)',
                color: colors.textTertiary,
                borderLeft: `1px solid ${colors.timelineLine}`,
              }}
            >
              {fullText}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.12 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
})
