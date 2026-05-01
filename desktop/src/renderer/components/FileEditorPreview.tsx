import React, { useMemo } from 'react'
import Markdown from 'react-markdown'
import { useColors } from '../theme'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { EDITABLE_EXTS } from '../hooks/useNavigableLinks'
import { REMARK_PLUGINS } from './FileEditorShared'

interface FileEditorPreviewProps {
  dir: string
  tabId: string
  activeFile: FileEditorTab
}

/**
 * Markdown preview pane. Resolves relative links against the active file's
 * directory and routes editable files back into the editor; everything else
 * opens in the OS default handler.
 */
export function FileEditorPreview({ dir, tabId, activeFile }: FileEditorPreviewProps) {
  const colors = useColors()

  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (!href) return
          const h = String(href)
          // URLs open in native browser
          if (h.startsWith('http://') || h.startsWith('https://')) {
            window.ion.openExternal(h)
            return
          }
          // Resolve relative path against current file's directory
          const baseDir = activeFile?.filePath
            ? activeFile.filePath.replace(/\/[^/]+$/, '')
            : dir
          // Normalize: join baseDir + href, then collapse ../ and ./
          const parts = (baseDir + '/' + h).split('/')
          const resolved: string[] = []
          for (const p of parts) {
            if (p === '..') resolved.pop()
            else if (p && p !== '.') resolved.push(p)
          }
          const fullPath = '/' + resolved.join('/')
          const ext = fullPath.includes('.') ? '.' + fullPath.split('.').pop()!.toLowerCase() : ''
          if (EDITABLE_EXTS.has(ext)) {
            useSessionStore.getState().openFileInEditor(dir, tabId, fullPath, { insertAfterActive: true })
          } else {
            window.ion.openExternal(h)
          }
        }}
      >
        {children}
      </button>
    ),
  }), [colors, activeFile?.filePath, dir, tabId])

  return (
    <div
      style={{
        overflowY: 'auto',
        flex: 1,
        padding: '12px 16px',
      }}
    >
      <div className="text-[13px] leading-[1.6] prose-cloud" style={{ color: colors.textSecondary }}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {activeFile.content}
        </Markdown>
      </div>
    </div>
  )
}
