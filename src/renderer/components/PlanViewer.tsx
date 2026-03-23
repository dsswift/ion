import React, { useMemo } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'

const REMARK_PLUGINS = [remarkGfm]

interface PlanViewerProps {
  content: string
  fileName: string
  onClose: () => void
}

export function PlanViewer({ content, fileName, onClose }: PlanViewerProps) {
  const colors = useColors()

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
  }), [colors])

  return (
    <FloatingPanel title={fileName} onClose={onClose} defaultWidth={720} defaultHeight={420}>
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
