import React, { useMemo, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { useNavigableText, NavigableText, NavigableCode } from '../hooks/useNavigableLinks'

const REMARK_PLUGINS = [remarkGfm]

interface PlanViewerProps {
  content: string
  fileName: string
  onClose: () => void
}

export function PlanViewer({ content, fileName, onClose }: PlanViewerProps) {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const planGeometry = useSessionStore((s) => s.planGeometry)
  const setPlanGeometry = useSessionStore((s) => s.setPlanGeometry)
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setPlanGeometry(geo),
    [setPlanGeometry],
  )

  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (href) window.coda.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    text: ({ children }: any) => <NavigableText onOpenFile={onOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, onOpenFile, onOpenUrl])

  return (
    <FloatingPanel
      title={fileName}
      onClose={onClose}
      defaultWidth={720}
      defaultHeight={420}
      initialPos={{ x: planGeometry.x, y: planGeometry.y }}
      initialSize={{ w: planGeometry.w, h: planGeometry.h }}
      onGeometryChange={handleGeometryChange}
    >
      <div
        style={{
          overflowY: 'auto',
          overflowX: 'auto',
          flex: 1,
          padding: '12px 16px',
        }}
      >
        <div className="text-[13px] leading-[1.6] prose-cloud" style={{ color: colors.textSecondary }}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      </div>
    </FloatingPanel>
  )
}
