import React, { useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { rDebug, rWarn } from '../rendererLogger'

// ─── CMD key tracking (singleton — one listener pair for all components) ───

let _cmdHeld = false
const _cmdListeners = new Set<() => void>()

function _notifyCmdListeners() {
  for (const fn of _cmdListeners) fn()
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { if (e.key === 'Meta') { _cmdHeld = true; _notifyCmdListeners() } })
  window.addEventListener('keyup', (e) => { if (e.key === 'Meta') { _cmdHeld = false; _notifyCmdListeners() } })
  window.addEventListener('blur', () => { _cmdHeld = false; _notifyCmdListeners() })
}

export function useCmdHeld(): boolean {
  return useSyncExternalStore(
    (cb) => { _cmdListeners.add(cb); return () => { _cmdListeners.delete(cb) } },
    () => _cmdHeld,
  )
}

/** Non-React getter for CMD key state (use in non-component code like xterm link providers) */
export function isCmdHeld(): boolean {
  return _cmdHeld
}

// ─── Text segmentation — detect file paths and URLs in plain text ───

type TextSegment = { type: 'plain' | 'file' | 'url'; value: string }

// Matches: URLs (https://...), absolute paths (/foo/bar), home-relative paths (~/foo/bar), and relative paths (src/foo/bar.ext)
// Relative paths require a file extension to avoid false positives on plain text with slashes
export const LINK_RE = /(https?:\/\/[^\s<>"')\]]+|~\/(?:[a-zA-Z0-9._~-]+\/)*[a-zA-Z0-9._~-]+|\/(?:[a-zA-Z0-9._~-]+\/)+[a-zA-Z0-9._~-]+|[a-zA-Z0-9._~-]+(?:\/[a-zA-Z0-9._~-]+)+\.[a-zA-Z0-9]+)/g

// Exported for the memoization regression test in useNavigableLinks.test.tsx,
// which spies on this to prove it is not re-run for unchanged text.
export function segmentText(text: string): TextSegment[] {
  const segments: TextSegment[] = []
  let last = 0
  for (const match of text.matchAll(LINK_RE)) {
    const start = match.index!
    if (start > last) segments.push({ type: 'plain', value: text.slice(last, start) })
    const raw = match[0]
    // Trim trailing punctuation that's likely not part of the path/url
    const trimmed = raw.replace(/[.,;:!?)]+$/, '')
    const isUrl = trimmed.startsWith('http')
    segments.push({ type: isUrl ? 'url' : 'file', value: trimmed })
    // Anything we trimmed off goes back as plain text
    if (trimmed.length < raw.length) {
      segments.push({ type: 'plain', value: raw.slice(trimmed.length) })
    }
    last = start + raw.length
  }
  if (last < text.length) segments.push({ type: 'plain', value: text.slice(last) })
  return segments
}

// ─── LinkSegment — interactive span for detected file/url when CMD held ───

export const EDITABLE_EXTS = new Set(['.md', '.txt', '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', '.toml', '.py', '.rs', '.go', '.css', '.html'])

export const LinkSegment = React.memo(function LinkSegment({
  segment,
  onOpenFile,
  onOpenUrl,
}: {
  segment: TextSegment
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
}) {
  const colors = useColors()
  const cmdHeld = useCmdHeld()
  const [hovered, setHovered] = useState(false)

  if (segment.type === 'plain') return <>{segment.value}</>

  const isUrl = segment.type === 'url'

  return (
    <span
      style={{
        color: cmdHeld ? colors.accent : undefined,
        textDecoration: cmdHeld ? 'underline' : undefined,
        textUnderlineOffset: 2,
        cursor: cmdHeld ? 'pointer' : undefined,
        position: 'relative',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        if (!e.metaKey) return
        e.preventDefault()
        e.stopPropagation()
        if (isUrl) onOpenUrl(segment.value)
        else onOpenFile(segment.value)
      }}
    >
      {segment.value}
      {isUrl && cmdHeld && hovered && (
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: '100%',
            marginTop: 4,
            background: colors.surfacePrimary,
            border: `1px solid ${colors.surfaceSecondary}`,
            borderRadius: 6,
            padding: '3px 8px',
            fontSize: 11,
            color: colors.textSecondary,
            whiteSpace: 'nowrap',
            zIndex: 999,
            pointerEvents: 'none',
            maxWidth: 500,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {segment.value}
        </span>
      )}
    </span>
  )
})

// ─── Hook: returns navigable text markdown component + file/url openers ───

export function useNavigableText() {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workingDir = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.workingDirectory || '~'
  })

  const onOpenFile = useCallback(async (path: string) => {
    const homeDir = useSessionStore.getState().staticInfo?.homePath || '/Users/' + (process.env.USER || 'user')
    const expanded = path.startsWith('~/') ? homeDir + path.slice(1) : path
    const resolved = expanded.startsWith('/') ? expanded : workingDir + '/' + expanded
    const { exists } = await window.ion.fsExists(resolved)
    if (!exists) {
      rDebug('navigable-links', 'file does not exist, ignoring cmd-click', { raw_path: path, resolved })
      return
    }
    rDebug('navigable-links', 'opening file', { resolved })
    const ext = resolved.includes('.') ? '.' + resolved.split('.').pop()!.toLowerCase() : ''
    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      useSessionStore.getState().openFileInEditor(workingDir, activeTabId, resolved)
    } else {
      window.ion.fsOpenNative(resolved).catch((err) => rWarn('navigable-links', 'fsOpenNative failed', { resolved, error: String(err) }))
    }
  }, [activeTabId, workingDir])

  const onOpenUrl = useCallback((url: string) => {
    window.ion.openExternal(url).catch((err) => rWarn('navigable-links', 'openExternal failed', { url, error: String(err) }))
  }, [])

  return { onOpenFile, onOpenUrl }
}

/**
 * Markdown `text` component. Wrapped in React.memo so unrelated re-renders of
 * the markdown subtree don't re-render it, and the link-regex segmentation is
 * memoized on the input string so it never re-runs for unchanged text. Both
 * matter for large plans, where re-segmenting every text node on every render
 * caused scroll stutter.
 */
export const NavigableText = React.memo(function NavigableText({ children, onOpenFile, onOpenUrl }: {
  children: any
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
}) {
  const text = typeof children === 'string' ? children : null
  // Hook order stays unconditional; segmentText only runs when the string changes.
  const segments = useMemo(() => (text === null ? null : segmentText(text)), [text])
  if (segments === null) return <>{children}</>
  if (segments.length === 1 && segments[0].type === 'plain') return <>{children}</>
  return <>{segments.map((seg, i) => <LinkSegment key={i} segment={seg} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />)}</>
})

/** Markdown `code` component — applies navigable links to inline code spans */
export const NavigableCode = React.memo(function NavigableCode({ children, className, onOpenFile, onOpenUrl, ...props }: {
  children: any
  className?: string
  onOpenFile: (path: string) => void
  onOpenUrl: (url: string) => void
  [key: string]: any
}) {
  // For inline code (no language-* className), apply link detection to the text
  // content. Code blocks (className present) are left untouched. Compute the
  // segmentable text unconditionally so the useMemo below keeps a stable hook order.
  const text = className
    ? null
    : typeof children === 'string' ? children : Array.isArray(children) ? children.join('') : null
  const segments = useMemo(() => (text === null ? null : segmentText(text)), [text])
  if (className) return <code className={className} {...props}>{children}</code>
  if (segments === null) return <code {...props}>{children}</code>
  if (segments.length === 1 && segments[0].type === 'plain') return <code {...props}>{children}</code>
  return <code {...props}>{segments.map((seg, i) => <LinkSegment key={i} segment={seg} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} />)}</code>
})
