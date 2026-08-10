import React from 'react'
import { motion } from 'framer-motion'
import { PencilSimple } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { parseSlashCommand } from './slash-pill'
import { UserMarkdown } from './UserMarkdown'

/** Queued user message (waiting for previous turn to finish). */
export const QueuedMessage = React.memo(function QueuedMessage({ content, onEdit }: { content: string; onEdit?: () => void }) {
  const colors = useColors()

  // Pill rendering is NOT gated on enableClaudeCompat (slash commands are an
  // engine-owned concept). Queued messages have only raw text (no engine
  // metadata yet), so the fallback content parse is the only source here.
  const slashParsed = parseSlashCommand(content)

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5 items-start gap-1"
    >
      {onEdit && (
        <button
          onClick={onEdit}
          className="flex items-center justify-center shrink-0 mt-1"
          style={{ opacity: 0.5, cursor: 'pointer', background: 'none', border: 'none', padding: 2 }}
          title="Edit queued message"
        >
          <PencilSimple size={14} color={colors.userBubbleText} />
        </button>
      )}
      <div
        className="leading-[1.5] px-3 py-1.5 max-w-[85%]"
        style={{
          fontSize: 'var(--ion-conv-font-size, 13px)',
          background: colors.userBubble,
          color: colors.userBubbleText,
          border: `1px dashed ${colors.userBubbleBorder}`,
          borderRadius: '14px 14px 4px 14px',
          opacity: 0.6,
        }}
      >
        {slashParsed ? (
          <span>
            <span
              style={{
                display: 'inline-block',
                background: colors.accentSoft,
                color: colors.accent,
                borderRadius: 6,
                padding: '1px 7px',
                fontSize: 12,
                fontFamily: 'monospace',
                fontWeight: 500,
                marginRight: slashParsed.args ? 6 : 0,
              }}
            >
              {slashParsed.command}
            </span>
            {slashParsed.args}
          </span>
        ) : (
          // Through the same renderer the sent bubble uses. Rendering raw
          // `content` here made a queued message's formatting change the moment
          // the turn flushed: newlines and indentation collapsed on the way in,
          // then the identical string came back through markdown.
          <UserMarkdown content={content} />
        )}
      </div>
    </motion.div>
  )
})
