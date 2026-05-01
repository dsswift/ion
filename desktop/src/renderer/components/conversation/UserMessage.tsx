import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PencilSimple } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../../hooks/useNavigableLinks'
import { TableScrollWrapper, ImageCard } from './AssistantMessage'
import { MessageActions } from './MessageActions'
import { MessageAttachments } from './MessageAttachments'
import type { Message } from '../../../shared/types'

const REMARK_PLUGINS = [remarkGfm]

/** User message bubble (right-aligned). */
export function UserMessage({ message, skipMotion }: { message: Message; skipMotion?: boolean }) {
  const colors = useColors()
  const isBashCmd = !!message.userExecuted
  const { onOpenFile, onOpenUrl } = useNavigableText()

  // Strip attachment context lines that may be in historical messages
  const displayContent = message.content
    .replace(/^\[Attached (?:image|file): .+\]\n*/gm, '')
    .trim()

  const hasAttachments = message.attachments && message.attachments.length > 0

  const userMarkdownComponents = useMemo(() => ({
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (href) window.ion.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} />,
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFile, onOpenUrl])

  const content = (
    <div className="group/msg relative inline-flex flex-col items-end max-w-[85%]">
      <div
        className="text-[13px] leading-[1.5] px-3 py-1.5"
        style={{
          background: colors.userBubble,
          color: colors.userBubbleText,
          border: isBashCmd ? '2px solid rgba(244, 114, 182, 0.5)' : `1px solid ${colors.userBubbleBorder}`,
          borderRadius: '14px 14px 4px 14px',
        }}
      >
        <div className="prose-cloud prose-cloud-user">
          <Markdown remarkPlugins={REMARK_PLUGINS} components={userMarkdownComponents}>
            {displayContent}
          </Markdown>
        </div>
        {hasAttachments && <MessageAttachments attachments={message.attachments!} />}
      </div>
      {displayContent.trim() && (
        <div className="absolute -bottom-5 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          <MessageActions message={message} variant="user" />
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

/** Queued user message (waiting for previous turn to finish). */
export function QueuedMessage({ content, onEdit }: { content: string; onEdit?: () => void }) {
  const colors = useColors()

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
        className="text-[13px] leading-[1.5] px-3 py-1.5 max-w-[85%]"
        style={{
          background: colors.userBubble,
          color: colors.userBubbleText,
          border: `1px dashed ${colors.userBubbleBorder}`,
          borderRadius: '14px 14px 4px 14px',
          opacity: 0.6,
        }}
      >
        {content}
      </div>
    </motion.div>
  )
}
