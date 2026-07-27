import React, { useMemo, useCallback } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../../hooks/useNavigableLinks'
import { CopyButton } from './CopyButton'
import { InlineMessageImages, deriveMessageImages } from './InlineMessageImages'
import type { Message } from '../../../shared/types'
import { rWarn } from '../../rendererLogger'

const REMARK_PLUGINS = [remarkGfm]

interface MessageBubbleProps {
  message: Message
  skipMotion?: boolean
  actions?: React.ReactNode
}

export function MessageBubble({ message, skipMotion, actions }: MessageBubbleProps) {
  const colors = useColors()
  const isBashCmd = !!message.userExecuted
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const onOpenFileVoid = useCallback((path: string) => { void onOpenFile(path).catch((err) => rWarn('conversation', 'open file failed', { error: String(err) })) }, [onOpenFile])

  const displayContent = (message.content || '')
    .replace(/^\[Attached (?:image|file): [^\]]+\]\n*/gm, '')
    .replace(/^\[Attachment: [^\]]+ \(content attached\)\]\n*/gm, '')
    .trim()

  const inlineImages = deriveMessageImages(message.content || '', message.attachments)
  const hasInlineImages = inlineImages.length > 0

  const userMarkdownComponents = useMemo(() => ({
    table: ({ children }: any) => <div className="overflow-x-auto max-w-full">{children}</div>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => { if (href) void window.ion.openExternal(String(href)).catch((err) => rWarn('conversation', 'open link failed', { error: String(err) })) }}
      >
        {children}
      </button>
    ),
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFileVoid} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFileVoid} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFileVoid, onOpenUrl])

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
        <div
          className="leading-[1.5] px-3 py-1.5"
          style={{
            fontSize: 'var(--ion-conv-font-size, 13px)',
            background: colors.userBubble,
            color: colors.userBubbleText,
            border: isBashCmd ? `2px solid ${colors.bashModeRing}` : `1px solid ${colors.userBubbleBorder}`,
            borderRadius: '14px 14px 4px 14px',
          }}
        >
          <div className="prose-cloud prose-cloud-user min-w-0 overflow-hidden">
            <Markdown remarkPlugins={REMARK_PLUGINS} components={userMarkdownComponents}>
              {displayContent}
            </Markdown>
          </div>
        </div>
      )}
      {displayContent.trim() && (
        <div className="absolute -bottom-5 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          {actions || defaultActions}
        </div>
      )}
    </div>
  )

  if (skipMotion) {
    return <div className="flex justify-end py-1.5">{content}</div>
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="flex justify-end py-1.5"
    >
      {content}
    </motion.div>
  )
}
