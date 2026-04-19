import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react'
import { motion } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Globe, Image as ImageIcon } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../../hooks/useNavigableLinks'
import { CopyButton } from './CopyButton'
import type { Message } from '../../../shared/types'

const REMARK_PLUGINS = [remarkGfm]
const TASK_NOTIFICATION_RE = /<task-notification>[\s\S]*?<\/task-notification>\s*(?:Read the output file to retrieve the result:[^\n]*)?\n?/g

// ─── Table scroll wrapper with fade edges ───

export function TableScrollWrapper({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const [fade, setFade] = useState<string | undefined>(undefined)
  const prevFade = useRef<string | undefined>(undefined)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const { scrollLeft, scrollWidth, clientWidth } = el
    let next: string | undefined
    if (scrollWidth <= clientWidth + 1) {
      next = undefined
    } else {
      const l = scrollLeft > 1
      const r = scrollLeft + clientWidth < scrollWidth - 1
      next = l && r
        ? 'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)'
        : l
          ? 'linear-gradient(to right, transparent, black 24px)'
          : r
            ? 'linear-gradient(to right, black calc(100% - 24px), transparent)'
            : undefined
    }
    if (next !== prevFade.current) {
      prevFade.current = next
      setFade(next)
    }
  }, [])

  useEffect(() => {
    update()
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    const table = el.querySelector('table')
    if (table) ro.observe(table)
    return () => ro.disconnect()
  }, [update])

  return (
    <div
      ref={ref}
      onScroll={update}
      style={{
        overflowX: 'auto',
        scrollbarWidth: 'thin',
        maskImage: fade,
        WebkitMaskImage: fade,
      }}
    >
      <table>{children}</table>
    </div>
  )
}

// ─── Image card with graceful fallback ───

export function ImageCard({ src, alt, colors }: { src?: string; alt?: string; colors: ReturnType<typeof useColors> }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => { setFailed(false) }, [src])
  const label = alt || 'Image'
  const open = () => { if (src) window.ion.openExternal(String(src)) }

  if (failed || !src) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1.5 my-1 px-2.5 py-1.5 rounded-md text-[12px] cursor-pointer"
        style={{ background: colors.surfacePrimary, color: colors.accent, border: `1px solid ${colors.toolBorder}` }}
        onClick={open}
        title={src}
      >
        <Globe size={12} />
        Image unavailable{alt ? ` — ${alt}` : ''}
      </button>
    )
  }

  return (
    <button
      type="button"
      className="block my-2 rounded-lg overflow-hidden border text-left cursor-pointer"
      style={{ borderColor: colors.toolBorder, background: colors.surfacePrimary }}
      onClick={open}
      title={src}
    >
      <img
        src={src}
        alt={label}
        className="block w-full max-h-[260px] object-cover"
        loading="lazy"
        onError={() => setFailed(true)}
      />
      {alt && (
        <div className="px-2 py-1 text-[11px]" style={{ color: colors.textTertiary }}>
          {alt}
        </div>
      )}
    </button>
  )
}

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
    img: ({ src, alt }: any) => <ImageCard src={src} alt={alt} colors={colors} />,
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFile, onOpenUrl])

  const displayContent = useMemo(() => message.content.replace(TASK_NOTIFICATION_RE, '').trim(), [message.content])

  if (!displayContent) return null

  const defaultActions = <CopyButton text={displayContent} />

  const inner = (
    <div className="group/msg relative">
      <div className="text-[13px] leading-[1.6] prose-cloud min-w-0 max-w-[92%] overflow-hidden">
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {displayContent}
        </Markdown>
      </div>
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
}, (prev, next) => prev.message.content === next.message.content && prev.skipMotion === next.skipMotion)
