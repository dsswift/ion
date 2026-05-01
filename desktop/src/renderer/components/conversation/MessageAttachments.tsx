import React, { useState } from 'react'
import {
  FileText, Image, FileCode, File, ListChecks,
} from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { PlanViewer } from '../PlanViewer'
import type { Attachment } from '../../../shared/types'

const FILE_ICONS: Record<string, React.ReactNode> = {
  'image/png': <Image size={12} />,
  'image/jpeg': <Image size={12} />,
  'image/gif': <Image size={12} />,
  'image/webp': <Image size={12} />,
  'image/svg+xml': <Image size={12} />,
  'text/plain': <FileText size={12} />,
  'text/markdown': <FileText size={12} />,
  'application/json': <FileCode size={12} />,
  'text/yaml': <FileCode size={12} />,
  'text/toml': <FileCode size={12} />,
}

const EDITABLE_EXTS = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', '.toml', '.py', '.rs', '.go', '.css', '.html'])

/** Pill list of message attachments — files open in editor, plans open viewer. */
export function MessageAttachments({ attachments }: { attachments: Attachment[] }) {
  const colors = useColors()
  const [planData, setPlanData] = useState<{ content: string; fileName: string } | null>(null)
  const { openFileInEditor } = useSessionStore.getState()
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workingDir = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.workingDirectory || '~'
  })

  const handleClick = async (a: Attachment) => {
    if (a.type === 'plan') {
      const result = await window.ion.readPlan(a.path)
      if (result.content && result.fileName) {
        setPlanData({ content: result.content, fileName: result.fileName })
      }
      return
    }
    // File attachment
    const ext = a.name.includes('.') ? '.' + a.name.split('.').pop()!.toLowerCase() : ''
    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      openFileInEditor(workingDir, activeTabId, a.path)
    } else {
      const result = await window.ion.fsOpenNative(a.path)
      if (!result.ok) {
        console.warn('Failed to open file:', result.error)
      }
    }
  }

  return (
    <>
      <div className="flex gap-1 flex-wrap mt-1" style={{ maxWidth: '100%' }}>
        {attachments.map((a) => (
          <button
            key={a.id}
            onClick={() => handleClick(a)}
            className="flex items-center gap-1 cursor-pointer transition-opacity hover:opacity-80"
            style={{
              background: a.type === 'plan' ? 'rgba(34, 197, 94, 0.1)' : colors.surfacePrimary,
              border: `1px solid ${a.type === 'plan' ? 'rgba(34, 197, 94, 0.3)' : colors.surfaceSecondary}`,
              borderRadius: 10,
              padding: '2px 7px',
              maxWidth: 180,
            }}
          >
            <span className="flex-shrink-0" style={{ color: a.type === 'plan' ? 'rgba(34, 197, 94, 0.85)' : colors.textTertiary }}>
              {a.type === 'plan'
                ? <ListChecks size={12} />
                : FILE_ICONS[(a as any).mimeType || ''] || <File size={12} />}
            </span>
            <span
              className="text-[10px] font-medium truncate"
              style={{ color: a.type === 'plan' ? 'rgba(34, 197, 94, 0.85)' : colors.textSecondary }}
            >
              {a.name}
            </span>
          </button>
        ))}
      </div>
      {planData && (
        <PlanViewer
          content={planData.content}
          fileName={planData.fileName}
          onClose={() => setPlanData(null)}
        />
      )}
    </>
  )
}
