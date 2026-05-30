import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { TableScrollWrapper } from './AssistantMessage'
import type { Message } from '../../../shared/types'

// Harness messages are markdown-formatted by convention. Extensions like
// ion-meta emit multi-paragraph welcome/help content with headers,
// bullets, and inline code; plain-text content (e.g. one-line clear
// dividers from other paths) also renders correctly as markdown because
// it is a strict superset. Render with the same remark/gfm pipeline the
// AssistantMessage uses so styling stays consistent.
const REMARK_PLUGINS = [remarkGfm]

interface HarnessMessageProps {
  message: Message
  skipMotion?: boolean
  bootstrapCollapsedCount?: number
}

export function HarnessMessage({ message, skipMotion, bootstrapCollapsedCount }: HarnessMessageProps) {
  const colors = useColors()
  const showBadge = bootstrapCollapsedCount !== undefined && bootstrapCollapsedCount > 0

  // Components map mirrors AssistantMessage's setup so links open
  // externally (rather than navigating the renderer) and tables get the
  // same overflow treatment. We intentionally do NOT inherit the
  // NavigableText/NavigableCode hooks here — harness messages are
  // engine-authored and not expected to embed file paths the user might
  // ⌘-click; this keeps the surface area minimal.
  const markdownComponents = useMemo(() => ({
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
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
  }), [colors])

  const content = (message.content || '').trim()

  const inner = (
    <div
      className="text-[12px] leading-[1.55] px-3 py-2 rounded-lg inline-block max-w-[92%] prose-cloud"
      style={{
        background: colors.surfaceHover,
        color: colors.textSecondary,
        borderLeft: `2px solid ${colors.accent}`,
      }}
    >
      {showBadge && (
        <span
          className="shrink-0 text-[10px] font-semibold px-1 py-0.5 rounded-full leading-none mr-1.5 align-baseline"
          style={{
            background: colors.surfaceHover,
            color: colors.textSecondary,
            outline: `1px solid ${colors.containerBorder}`,
          }}
        >
          ×{bootstrapCollapsedCount! + 1}
        </span>
      )}
      <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {content}
      </Markdown>
    </div>
  )

  if (skipMotion) return <div className="py-0.5">{inner}</div>

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="py-0.5"
    >
      {inner}
    </motion.div>
  )
}

