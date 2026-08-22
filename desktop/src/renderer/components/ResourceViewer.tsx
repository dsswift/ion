import React from 'react'
import { FloatingPanel } from './FloatingPanel'
import { ResourceContent } from './ResourceContent'

interface ResourceViewerProps {
  title: string
  content: string
  onClose: () => void
}

export function ResourceViewer({ title, content, onClose }: ResourceViewerProps) {
  return <FloatingPanel title={title} onClose={onClose} defaultWidth={720} defaultHeight={420}><ResourceContent content={content} /></FloatingPanel>
}
