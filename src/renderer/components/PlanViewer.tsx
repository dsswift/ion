import React from 'react'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'

interface PlanViewerProps {
  content: string
  fileName: string
  onClose: () => void
}

export function PlanViewer({ content, fileName, onClose }: PlanViewerProps) {
  const colors = useColors()

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
        <pre
          style={{
            margin: 0,
            whiteSpace: 'pre-wrap',
            fontFamily: 'monospace',
            fontSize: 11,
            lineHeight: 1.6,
            color: colors.textSecondary,
          }}
        >
          {content}
        </pre>
      </div>
    </FloatingPanel>
  )
}
