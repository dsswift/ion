import React, { useMemo } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useColors } from '../../theme'
import { TableScrollWrapper } from './AssistantMessage'
import type { Message } from '../../../shared/types'

// Intercept banners are emitted by the engine_intercept event. They render
// inline in the conversation scrollback so the user sees that an extension
// intercepted the run, what it said, and whether the conversation was
// redirected. Visual weight varies by level:
//
//   "redirect" — amber/urgent: same amber as the permission card, bold left
//                border, slightly elevated background. The title will already
//                carry a "Conversation redirected:" prefix inserted by the
//                event handler.
//   "banner"   — lighter informational style: amber border only, no
//                background fill elevation. The alert icon still flags it
//                as extension-sourced.

const REMARK_PLUGINS = [remarkGfm]

interface InterceptBannerProps {
  message: Message
  skipMotion?: boolean
}

export function InterceptBanner({ message, skipMotion }: InterceptBannerProps) {
  const colors = useColors()

  const isRedirect = message.interceptLevel === 'redirect'

  // Amber palette — mirrors the permission card amber so intercepts feel
  // visually related to "action required" surfaces without being identical.
  const borderColor = 'rgba(245, 158, 11, 0.55)'
  const bgColor = isRedirect ? 'rgba(245, 158, 11, 0.07)' : colors.surfaceHover
  const textColor = colors.textSecondary

  const markdownComponents = useMemo(() => ({
    table: ({ children }: any) => <TableScrollWrapper>{children}</TableScrollWrapper>,
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: 'rgba(245, 158, 11, 0.9)' }}
        onClick={() => { if (href) window.ion.openExternal(String(href)) }}
      >
        {children}
      </button>
    ),
  }), [])

  const content = (message.content || '').trim()

  const inner = (
    <div
      className="text-[12px] leading-[1.55] px-3 py-2 rounded-lg inline-block max-w-[92%] prose-cloud"
      style={{
        background: bgColor,
        color: textColor,
        borderLeft: `2px solid ${borderColor}`,
      }}
    >
      <span className="mr-1.5 select-none" aria-hidden="true">⚠️</span>
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
