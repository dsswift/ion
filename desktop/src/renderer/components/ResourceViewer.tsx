import React, { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'
import { useNavigableText, NavigableText, NavigableCode } from '../hooks/useNavigableLinks'

const REMARK_PLUGINS = [remarkGfm]

interface ResourceViewerProps {
  title: string
  content: string
  onClose: () => void
}

export function ResourceViewer({ title, content, onClose }: ResourceViewerProps) {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()

  const markdownComponents = useMemo(() => ({
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
    text: ({ children }: any) => (
      <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>
    ),
    code: ({ children, className, ...props }: any) => (
      <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>
        {children}
      </NavigableCode>
    ),
  }), [colors, onOpenFile, onOpenUrl])

  return (
    <FloatingPanel title={title} onClose={onClose} defaultWidth={720} defaultHeight={420}>
      <div style={{ overflowY: 'auto', overflowX: 'auto', flex: 1, padding: '12px 16px' }}>
        <div
          className="text-[13px] leading-[1.6] prose-cloud min-w-0 overflow-hidden"
          style={{ color: colors.textSecondary, maxWidth: '100%' }}
        >
          <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      </div>
    </FloatingPanel>
  )
}
