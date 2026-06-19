import React, { useMemo } from 'react'
import Markdown from 'react-markdown'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
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
 * Split a markdown document into YAML frontmatter (raw, unparsed) and body.
 *
 * Frontmatter convention: the first line must be exactly `---`; scan downward
 * for the next standalone `---` line. If no closing fence is found, treat the
 * file as having no frontmatter rather than swallowing the entire document.
 *
 * Reimplemented inline rather than imported because the main and renderer
 * processes are separate bundles and the logic is small enough that
 * duplication is cheaper than restructuring the module graph. The
 * behavior is pinned to the existing helper's contract.
 *
 * Returns the *raw* frontmatter block (without the fence lines) so the
 * preview can render it verbatim — we deliberately do not parse the YAML
 * here because the goal is to show the user exactly what is in the file,
 * not a re-serialized projection of it.
 */
function splitFrontmatter(content: string): { frontmatterRaw: string | null; body: string } {
  const lines = content.split('\n')
  if (lines[0]?.trim() !== '---') return { frontmatterRaw: null, body: content }

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      const frontmatterRaw = lines.slice(1, i).join('\n')
      const body = lines.slice(i + 1).join('\n').trimStart()
      return { frontmatterRaw, body }
    }
  }

  // Unclosed fence — treat as no frontmatter so we don't accidentally
  // hide the whole document behind a collapsible section.
  return { frontmatterRaw: null, body: content }
}

/**
 * Markdown preview pane. Resolves relative links against the active file's
 * directory and routes editable files back into the editor; everything else
 * opens in the OS default handler.
 */
export function FileEditorPreview({ dir, tabId, activeFile }: FileEditorPreviewProps) {
  const colors = useColors()
  const editorFontSize = usePreferencesStore((s) => s.editorFontSize)

  const baseDir = useMemo(() => {
    return activeFile?.filePath
      ? activeFile.filePath.replace(/\/[^/]+$/, '')
      : dir
  }, [activeFile?.filePath, dir])

  // Split frontmatter off the body before handing the content to
  // react-markdown. Without this, `remark-gfm` sees the closing `---`
  // fence as a setext H2 underline, which (a) renders the first
  // frontmatter line as a giant heading, (b) consumes the fence as an
  // <hr>, and (c) corrupts parser state so the first real heading below
  // the frontmatter renders as body text. Splitting here keeps the
  // metadata visible (in its own collapsible section above the preview)
  // while letting the markdown parser see a clean document.
  const { frontmatterRaw, body } = useMemo(
    () => splitFrontmatter(activeFile.content),
    [activeFile.content],
  )

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
              fontSize: editorFontSize,
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
  }), [colors, baseDir, dir, tabId, editorFontSize])

  return (
    <div
      style={{
        overflowY: 'auto',
        flex: 1,
        padding: '12px 16px',
      }}
    >
      {frontmatterRaw !== null && (
        <details
          style={{
            marginBottom: 12,
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 8,
            background: 'transparent',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              padding: '6px 10px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.4,
              textTransform: 'uppercase',
              color: colors.textSecondary,
              userSelect: 'none',
            }}
          >
            Frontmatter
          </summary>
          <pre
            style={{
              margin: 0,
              padding: '8px 12px',
              borderTop: `1px solid ${colors.containerBorder}`,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              lineHeight: 1.5,
              color: colors.textSecondary,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {frontmatterRaw}
          </pre>
        </details>
      )}
      <div className="leading-[1.6] prose-cloud" style={{ color: colors.textSecondary, fontSize: `${editorFontSize}px` }}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {body}
        </Markdown>
      </div>
    </div>
  )
}
