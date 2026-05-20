import React, { useMemo } from 'react'
import Markdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useColors } from '../theme'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { EDITABLE_EXTS } from '../hooks/useNavigableLinks'
import { REMARK_PLUGINS } from './FileEditorShared'

interface FileEditorPreviewProps {
  dir: string
  tabId: string
  activeFile: FileEditorTab
}

/** Resolve a relative path against a base directory */
function resolveRelativePath(baseDir: string, href: string): string {
  const parts = (baseDir + '/' + href).split('/')
  const resolved: string[] = []
  for (const p of parts) {
    if (p === '..') resolved.pop()
    else if (p && p !== '.') resolved.push(p)
  }
  return '/' + resolved.join('/')
}

/**
 * Markdown preview pane. Resolves relative links against the active file's
 * directory and routes editable files back into the editor; everything else
 * opens in the OS default handler.
 */
export function FileEditorPreview({ dir, tabId, activeFile }: FileEditorPreviewProps) {
  const colors = useColors()

  const baseDir = useMemo(() => {
    return activeFile?.filePath
      ? activeFile.filePath.replace(/\/[^/]+$/, '')
      : dir
  }, [activeFile?.filePath, dir])

  const markdownComponents = useMemo(() => ({
    a: ({ href, children }: any) => (
      <button
        type="button"
        className="underline decoration-dotted underline-offset-2 cursor-pointer"
        style={{ color: colors.accent }}
        onClick={() => {
          if (!href) return
          const h = String(href)
          if (h.startsWith('http://') || h.startsWith('https://')) {
            window.ion.openExternal(h)
            return
          }
          const fullPath = resolveRelativePath(baseDir, h)
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
    code: ({ className, children, ...props }: any) => {
      const match = /language-(\w+)/.exec(className || '')
      const code = String(children).replace(/\n$/, '')
      if (match) {
        return (
          <SyntaxHighlighter
            style={oneDark}
            language={match[1]}
            PreTag="div"
            customStyle={{
              margin: 0,
              padding: '0.75em 1em',
              borderRadius: 10,
              fontSize: 12,
              border: `1px solid ${colors.containerBorder}`,
            }}
          >
            {code}
          </SyntaxHighlighter>
        )
      }
      return <code className={className} {...props}>{children}</code>
    },
    img: ({ src, alt, ...props }: any) => {
      let resolvedSrc = src || ''
      if (resolvedSrc && !resolvedSrc.startsWith('http://') && !resolvedSrc.startsWith('https://') && !resolvedSrc.startsWith('data:')) {
        const fullPath = resolveRelativePath(baseDir, resolvedSrc)
        resolvedSrc = `file://${fullPath}`
      }
      return (
        <img
          src={resolvedSrc}
          alt={alt || ''}
          style={{ maxWidth: '100%', borderRadius: 8, margin: '8px 0' }}
          {...props}
        />
      )
    },
  }), [colors, baseDir, dir, tabId])

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
