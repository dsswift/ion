import React, { useCallback } from 'react'
import { FloatingPanel } from './FloatingPanel'
import { useSessionStore } from '../stores/sessionStore'
import { PlanContent } from './PlanContent'

interface PlanViewerProps {
  content: string
  fileName: string
  filePath?: string
  onClose: () => void
}

// Memoized: the markdown body (PlanContent) re-parses `content` on every
// render. Wrapping in React.memo means an ancestor re-render (e.g. a
// status-bar update) no longer forces a full markdown re-parse while the
// plan window is open. Effective only if the call site passes a
// referentially stable `onClose` (all call sites do).
export const PlanViewer = React.memo(function PlanViewer({ content, fileName, filePath, onClose }: PlanViewerProps) {
  const planGeometry = useSessionStore((s) => s.planGeometry)
  const setPlanGeometry = useSessionStore((s) => s.setPlanGeometry)
  const workingDir = useSessionStore((s) => { const tab = s.tabs.find(t => t.id === s.activeTabId); return tab?.workingDirectory || '' })
  const handleGeometryChange = useCallback(
    (geo: { x: number; y: number; w: number; h: number }) => setPlanGeometry(geo),
    [setPlanGeometry],
  )

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
      <PlanContent content={content} />
    </FloatingPanel>
  )
})
