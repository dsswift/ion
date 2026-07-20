import React, { useMemo, useCallback } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { useNavigableText, NavigableText, NavigableCode } from '../hooks/useNavigableLinks'
import { rError } from '../rendererLogger'

const REMARK_PLUGINS = [remarkGfm]

interface PlanViewerProps {
  content: string
  fileName: string
  filePath?: string
  onClose: () => void
}

// Memoized: react-markdown re-parses `content` on every render, and the
// navigable-link segmentation walks every text node. Wrapping in React.memo
// means an ancestor re-render (e.g. a status-bar update) no longer forces a
// full markdown re-parse while the plan window is open. Effective only if the
// call site passes a referentially stable `onClose` (all call sites do).
export const PlanViewer = React.memo(function PlanViewer({ content, fileName, filePath, onClose }: PlanViewerProps) {
  const colors = useColors()
  const { onOpenFile, onOpenUrl } = useNavigableText()
  const handleOpenFile = useCallback((path: string) => {
    void onOpenFile(path).catch((err) => rError('plan-viewer', 'open file failed', { error: String(err) }))
  }, [onOpenFile])
  const planGeometry = useSessionStore((s) => s.planGeometry)
  const setPlanGeometry = useSessionStore((s) => s.setPlanGeometry)
  const workingDir = useSessionStore((s) => { const tab = s.tabs.find(t => t.id === s.activeTabId); return tab?.workingDirectory || '' })
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
          if (href) void window.ion.openExternal(String(href))
        }}
      >
        {children}
      </button>
    ),
    text: ({ children }: any) => <NavigableText onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl}>{children}</NavigableText>,
    code: ({ children, className, ...props }: any) => <NavigableCode className={className} onOpenFile={handleOpenFile} onOpenUrl={onOpenUrl} {...props}>{children}</NavigableCode>,
  }), [colors, handleOpenFile, onOpenUrl])

  return (
    <FloatingPanel
      title={fileName}
      filePath={filePath}
      workingDir={workingDir}
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
        <div className="leading-[1.6] prose-cloud min-w-0 overflow-hidden" style={{ color: colors.textSecondary, maxWidth: '100%', fontSize: 'var(--ion-conv-font-size, 13px)' }}>
          <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
            {content}
          </Markdown>
        </div>
      </div>
    </FloatingPanel>
  )
})
