import React, { useMemo, useCallback } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { useNavigableText, remarkNavigableLinks } from '../../hooks/useNavigableLinks'
import { makeMarkdownComponents } from './markdownRenderers'
import { CopyButton } from './CopyButton'
import { InlineMessageImages, deriveMessageImages } from './InlineMessageImages'
import type { Message } from '../../../shared/types'
import { rWarn } from '../../rendererLogger'

const REMARK_PLUGINS = [remarkGfm, remarkNavigableLinks]
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g

// ─── AssistantMessage ───

interface AssistantMessageProps {
  message: Message
  skipMotion?: boolean
  actions?: React.ReactNode
}

export const AssistantMessage = React.memo(function AssistantMessage({
  message,
  skipMotion,
  actions,
}: AssistantMessageProps) {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const onOpenFileVoid = useCallback((path: string) => { void onOpenFile(path).catch((err) => rWarn('conversation', 'open file failed', { error: String(err) })) }, [onOpenFile])

  const markdownComponents = useMemo(
    () => makeMarkdownComponents({ colors, onOpenFile: onOpenFileVoid, onOpenUrl, variant: 'assistant' }),
    [colors, onOpenFileVoid, onOpenUrl],
  )

  const displayContent = useMemo(() => (message.content || '').replace(TASK_NOTIFICATION_RE, '').trim(), [message.content])

  const inlineImages = deriveMessageImages(message.content || '', message.attachments)
  const hasInlineImages = inlineImages.length > 0

  // Render nothing only when there is neither text nor an image to show. A
  // provider-generated image can arrive on an otherwise-empty assistant turn.
  if (!displayContent && !hasInlineImages) return null

  const defaultActions = <CopyButton text={displayContent} />

  const inner = (
    <div className="group/msg relative">
      {hasInlineImages && (
        <div className="mb-1 flex flex-col items-start">
          <InlineMessageImages content={message.content || ''} attachments={message.attachments} align="start" />
        </div>
      )}
      {displayContent && (
        <div
          className="leading-[1.6] prose-cloud min-w-0 max-w-[92%] overflow-hidden"
          style={{ fontSize: 'var(--ion-conv-font-size, 13px)' }}
        >
          <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
            {displayContent}
          </Markdown>
        </div>
      )}
      {displayContent && (
        <div className="absolute bottom-0 right-0 opacity-0 group-hover/msg:opacity-100 transition-opacity duration-100">
          {actions || defaultActions}
        </div>
      )}
    </div>
  )

  if (skipMotion) {
    return <div className="py-1">{inner}</div>
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.15 }}
      className="py-1"
    >
      {inner}
    </motion.div>
  )
}, (prev, next) =>
  prev.message.content === next.message.content &&
  prev.skipMotion === next.skipMotion &&
  prev.message.attachments === next.message.attachments)
