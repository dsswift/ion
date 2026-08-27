import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import { Brain } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { CopyButton } from './CopyButton'
import { InlineMessageImages, deriveMessageImages } from './InlineMessageImages'
import { stripAttachmentMarkers, structuredAnswerDisplayText } from './message-text'
import { resolveSlashPill } from './slash-pill'
import { UserMarkdown } from './UserMarkdown'
import { CollapsibleUserBody } from './CollapsibleUserBody'
import { StructuredAnswerFrame } from './StructuredAnswerFrame'
import type { Message } from '../../../shared/types'

interface MessageBubbleProps {
  message: Message
  skipMotion?: boolean
  actions?: React.ReactNode
}

export function MessageBubble({ message, skipMotion, actions }: MessageBubbleProps) {
  const colors = useColors()
  const isBashCmd = !!message.userExecuted

  const structuredAnswer = message.injectionKind === 'structured_answer'
  const displayContent = structuredAnswer
    ? structuredAnswerDisplayText(stripAttachmentMarkers(message.content || ''))
    : stripAttachmentMarkers(message.content || '').trim()
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

  // Guided Questions submission. This IS the operator's own input — they read
  // the questions, chose the options, typed the text and attached the images —
  // so it renders in full rather than being hidden. But they did not compose
  // the rendered prose at the prompt, so it is wrapped in explicit chrome
  // (StructuredAnswerFrame: labelled rules top and bottom, tinted panel
  // grouping the answers WITH their attachments). A small corner tag was the
  // first attempt and was not enough — at a glance the bubble still read as an
  // ordinary message, which is the false impression the frame removes.

  const inner = (
    <div
      className={
        structuredAnswer
          // Inside the frame the content sizes to itself: the panel hugs it,
          // so stretching here would push the panel out to the full row and
          // reproduce the empty-box look the frame is meant to avoid. The
          // frame owns the width cap.
          ? 'group/msg relative inline-flex flex-col items-stretch min-w-0'
          : 'group/msg relative inline-flex flex-col items-end max-w-[85%] min-w-0'
      }
    >
      {steerTag}
      {hasInlineImages && <InlineMessageImages content={message.content || ''} attachments={message.attachments} />}
      {displayContent.trim() && (
        <CollapsibleUserBody text={displayContent}>
          <div
            className="leading-[1.5] px-3 py-1.5 max-w-full min-w-0"
            style={{
              fontSize: 'var(--ion-data-font-size, 13px)',
              background: colors.userBubble,
              color: colors.userBubbleText,
              // Inside the frame the bubble is a panel member, not a
              // free-floating message: the frame owns the border and tint, so
              // a second border here would read as a bubble sitting in a box.
              border: isBashCmd
                ? `2px solid ${colors.bashModeRing}`
                : structuredAnswer
                  ? 'none'
                  : `1px solid ${colors.userBubbleBorder}`,
              borderRadius: structuredAnswer ? '8px' : '14px 14px 4px 14px',
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
        <div
          className={`absolute right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100 ${
            // Inside the frame the row is followed by the closing rule, and
            // the default -bottom-5 lands the hover actions on top of it.
            // Drop them clear of the rule instead of overlapping it.
            structuredAnswer ? '-bottom-8' : '-bottom-5'
          }`}
        >
          {actions || defaultActions}
        </div>
      )}
    </div>
  )

  // The frame spans the transcript rather than the 85% bubble column: the
  // whole point is separation from the neighbouring turns, and a right-aligned
  // block would still read as "a message the operator sent".
  const content = structuredAnswer
    ? <StructuredAnswerFrame>{inner}</StructuredAnswerFrame>
    : inner

  // A framed submission stretches across the transcript; an ordinary bubble
  // stays right-aligned in its 85% column.
  const rowClass = structuredAnswer
    // Extra bottom padding reserves the band the hover actions drop into
    // below the closing rule, so they never crowd the following turn.
    ? 'flex items-stretch pt-2.5 pb-5'
    : 'flex justify-end py-1.5'

  if (skipMotion) {
    return (
      <div
        className={rowClass}
        data-message-id={message.id}
        data-message-role="user"
        data-structured-answer={structuredAnswer ? 'true' : undefined}
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
      className={rowClass}
      data-message-id={message.id}
      data-message-role="user"
      data-structured-answer={structuredAnswer ? 'true' : undefined}
    >
      {content}
    </motion.div>
  )
}
