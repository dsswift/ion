import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../../hooks/useNavigableLinks'
import { CopyButton } from './CopyButton'
import type { Message, Attachment } from '../../../shared/types'

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

  const displayContent = message.content
    .replace(/^\[Attached (?:image|file): .+\]\n*/gm, '')
    .trim()

  const hasAttachments = message.attachments && message.attachments.length > 0

  const userMarkdownComponents = useMemo(() => ({
    table: ({ children }: any) => <div className="overflow-x-auto max-w-full">{children}</div>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => { if (href) window.ion.openExternal(String(href)) }}
      >
        {children}
      </button>
    ),
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFile, onOpenUrl])

  const defaultActions = <CopyButton text={displayContent} />

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
      </div>
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
