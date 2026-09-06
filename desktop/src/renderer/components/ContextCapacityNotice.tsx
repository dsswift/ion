import React from 'react'
import { motion } from 'framer-motion'
import type { ColorPalette } from '../theme'

/**
 * Capacity warning shown when the conversation has filled its context window.
 *
 * The copy is backend-aware because the two backends do genuinely different
 * things at this point, and stating the wrong one sends the user to a remedy
 * that will not fire.
 *
 * On an engine-served conversation the engine owns prompt admission and
 * automatic compaction, so "the engine will compact before the next request"
 * is true.
 *
 * On a delegated-CLI conversation it is not. The engine holds the transcript,
 * but the live context belongs to the CLI subprocess, which runs its own
 * compaction on its own threshold. The engine's automatic compaction never
 * looks at that conversation, so promising it is a promise nothing keeps.
 */
export function ContextCapacityNotice({
  state,
  colors,
  servedByCli,
  onNewConversation,
}: {
  state: 'normal' | 'warning' | 'full'
  colors: ColorPalette
  /** True when this conversation's model routes to a delegated CLI backend. */
  servedByCli: boolean
  onNewConversation: () => void
}): React.JSX.Element | null {
  if (state !== 'full') return null
  const newConversationButton = (
    <button
      onClick={onNewConversation}
      style={{ border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: 0 }}
    >
      start a new conversation
    </button>
  )
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      style={{ overflow: 'hidden', fontSize: 10, color: colors.dangerFg, padding: '4px 6px 0' }}
      data-testid="context-capacity-notice"
    >
      {servedByCli ? (
        <>
          Context is full. The assistant compacts its own context on this backend. You can also send /compact
          or /clear, or {newConversationButton}.
        </>
      ) : (
        <>
          Context is full. The engine will compact before the next request when automatic compaction is
          enabled. You can also send /compact or /clear, or {newConversationButton}.
        </>
      )}
    </motion.div>
  )
}
