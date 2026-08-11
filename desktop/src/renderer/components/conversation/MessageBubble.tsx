import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Brain } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import { InlineMessageImages, deriveMessageImages } from './InlineMessageImages'
import { stripAttachmentMarkers } from './message-text'
import { resolveSlashPill } from './slash-pill'
import { UserMarkdown } from './UserMarkdown'
import { CollapsibleUserBody } from './CollapsibleUserBody'
import type { Message } from '../../../shared/types'

interface MessageBubbleProps {
  message: Message
  skipMotion?: boolean
  actions?: React.ReactNode
}

export function MessageBubble({ message, skipMotion, actions }: MessageBubbleProps) {
  const colors = useColors()
  const isBashCmd = !!message.userExecuted

  const displayContent = stripAttachmentMarkers(message.content || '').trim()
  const slashPill = useMemo(() => resolveSlashPill(message, displayContent), [message, displayContent])

  const inlineImages = deriveMessageImages(message.content || '', message.attachments)
  const hasInlineImages = inlineImages.length > 0

  const defaultActions = <CopyButton text={displayContent} />

  // Mid-turn steer affordance. Three states, all driven by UI-only flags set
  // by the send path and the steer_injected / error / session_dead arms of
  // event-slice.ts:
  //   steerPending — buffered in the engine runloop, not yet drained.
  //   steerFailed  — engine died before the steer was drained.
  //   steerApplied — drained; this bubble has been relocated to sit directly
  //                  under its "Steer applied" divider (see tool-helpers.ts).
  // The label distinguishes a steer from a normal turn-opening prompt, which
  // matters most for the relocated case: the bubble no longer sits where the
  // user typed it.
  const steerLabel = message.steerFailed
    ? 'Steer not delivered'
    : message.steerPending
      ? 'Steer queued'
      : message.steerApplied
        ? 'Steer'
        : null

  const steerTag = steerLabel && (
    <div
      className="text-[10px] leading-none pb-1 pr-0.5 select-none"
      style={{ color: message.steerFailed ? colors.statusError : colors.textTertiary }}
    >
      {steerLabel}
    </div>
  )

  const content = (
    <div className="group/msg relative inline-flex flex-col items-end max-w-[85%] min-w-0">
      {steerTag}
      {hasInlineImages && <InlineMessageImages content={message.content || ''} attachments={message.attachments} />}
      {displayContent.trim() && (
        <CollapsibleUserBody text={displayContent}>
          <div
            className="leading-[1.5] px-3 py-1.5 max-w-full min-w-0"
            style={{
              fontSize: 'var(--ion-conv-font-size, 13px)',
              background: colors.userBubble,
              color: colors.userBubbleText,
              border: isBashCmd ? `2px solid ${colors.bashModeRing}` : `1px solid ${colors.userBubbleBorder}`,
              borderRadius: '14px 14px 4px 14px',
            }}
          >
            {slashPill ? (
              <div className="flex flex-col items-start gap-1">
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
                  }}
                >
                  {slashPill.command}
                </span>
                {slashPill.modelDisplay && (
                  <span
                    data-slash-model-pill
                    className="inline-flex items-center gap-1"
                    style={{
                      background: colors.surfacePrimary,
                      border: `1px solid ${colors.surfaceSecondary}`,
                      borderRadius: 10,
                      padding: '2px 7px',
                      maxWidth: '100%',
                      fontSize: 10,
                      color: colors.textSecondary,
                      fontWeight: 500,
                    }}
                  >
                    <Brain size={12} className="flex-shrink-0" style={{ color: colors.textTertiary }} />
                    <span className="truncate">{slashPill.modelDisplay}</span>
                  </span>
                )}
                {slashPill.args && <UserMarkdown content={slashPill.args} />}
              </div>
            ) : (
              <UserMarkdown content={displayContent} />
            )}
          </div>
        </CollapsibleUserBody>
      )}
      {displayContent.trim() && (
        <div className="absolute -bottom-5 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          {actions || defaultActions}
        </div>
      )}
    </div>
  )

  if (skipMotion) {
    return (
      <div
        className="flex justify-end py-1.5"
        data-message-id={message.id}
        data-message-role="user"
      >
        {content}
      </div>
    )
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5"
      data-message-id={message.id}
      data-message-role="user"
    >
      {content}
    </motion.div>
  )
}
