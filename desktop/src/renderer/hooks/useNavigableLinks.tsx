import React, { useState, useMemo, useCallback, useSyncExternalStore } from 'react'
import { useColors } from '../theme'
import { useSessionStore } from '../stores/sessionStore'
import { getFileIcon } from '../components/FileExplorerIcons'
import { rDebug, rWarn } from '../rendererLogger'
import { openClickedLink } from '../lib/open-link'
import { surfaceRouter } from '../lib/file-open-router'
import { fileOpenIntent, isRenderableHtml, type FileClickModifiers } from '../lib/open-file-intent'
import { segmentText, EDITABLE_EXTS, type TextSegment } from './link-segments'
import { readNavigableKind } from './remarkNavigableLinks'

// The pure pieces live in their own modules so the remark plugin stays loadable
// without React, the theme, or the session store (this file imports all three,
// and the theme touches `document` at import time). Re-exported here because
// every existing consumer imports them from this path.
export { segmentText, LINK_RE, EDITABLE_EXTS, type TextSegment } from './link-segments'
export { remarkNavigableLinks, readNavigableKind, NAVIGABLE_DATA_ATTR } from './remarkNavigableLinks'

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

// ─── LinkSegment — interactive span for detected file/url when CMD held ───

export const LinkSegment = React.memo(function LinkSegment({
  segment,
  onOpenFile,
  onOpenUrl,
  asChip,
}: {
  segment: TextSegment
  /** Receives the click so ⇧ (source) and ⌥ (native) can be honoured. */
  onOpenFile: (path: string, event?: FileClickModifiers) => void
  /** Receives the click so ⌥ can escape to the operator's own browser. */
  onOpenUrl: (url: string, event?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => void
  /** File segments render as an always-visible chip (icon + monospace pill)
   * instead of plain text that only reveals itself on CMD. URLs and plain
   * segments are unaffected. */
  asChip?: boolean
}) {
  const colors = useColors()
  const cmdHeld = useCmdHeld()
  const [hovered, setHovered] = useState(false)

  if (segment.type === 'plain') return <>{segment.value}</>

  const isUrl = segment.type === 'url'

  if (asChip && !isUrl) {
    const baseName = segment.value.split('/').pop() ?? segment.value
    const iconInfo = getFileIcon(baseName.split(':')[0])
    const ChipIcon = iconInfo.icon
    return (
      <span
        role="link"
        tabIndex={-1}
        className="inline-flex items-center gap-1 px-1 py-px rounded align-baseline"
        style={{
          background: colors.inlineCodeBg,
          border: `1px solid ${colors.containerBorder}`,
          fontFamily: 'ui-monospace, monospace',
          fontSize: '0.9em',
          color: cmdHeld ? colors.accent : colors.textPrimary,
          textDecoration: cmdHeld ? 'underline' : undefined,
          textUnderlineOffset: 2,
          cursor: cmdHeld ? 'pointer' : undefined,
        }}
        onClick={(e) => {
          if (!e.metaKey) return
          e.preventDefault()
          e.stopPropagation()
          onOpenFile(segment.value, e)
        }}
      >
        <ChipIcon size={11} color={colors[iconInfo.colorKey]} aria-hidden="true" />
        {segment.value}
      </span>
    )
  }

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
        if (isUrl) onOpenUrl(segment.value, e)
        else onOpenFile(segment.value, e)
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

/** Hand a file to the operating system's default application for its type. */
async function openNatively(resolved: string): Promise<void> {
  rDebug('navigable-links', 'opening file in native application', { resolved })
  try {
    const result = await window.ion.fsOpenNative(resolved)
    if (!result.ok) {
      rWarn('navigable-links', 'native file open rejected', { resolved, error: result.error ?? 'unknown error' })
      return
    }
    rDebug('navigable-links', 'native file open succeeded', { resolved })
  } catch (err) {
    rWarn('navigable-links', 'native file open failed', { resolved, error: String(err) })
  }
}

export function useNavigableText() {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const workingDir = useSessionStore((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId)
    return tab?.workingDirectory || '~'
  })

  const onOpenFile = useCallback(async (path: string, event?: FileClickModifiers) => {
    const homeDir = useSessionStore.getState().staticInfo?.homePath || '/Users/' + (process.env.USER || 'user')
    const expanded = path.startsWith('~/') ? homeDir + path.slice(1) : path
    const resolved = expanded.startsWith('/') ? expanded : workingDir + '/' + expanded
    rDebug('navigable-links', 'checking file target', { raw_path: path, resolved })
    let exists = false
    try {
      const result = await window.ion.fsExists(resolved)
      exists = result.exists
    } catch (err) {
      rWarn('navigable-links', 'file existence check failed', { raw_path: path, resolved, error: String(err) })
      return
    }
    if (!exists) {
      rDebug('navigable-links', 'file does not exist, ignoring cmd-click', { raw_path: path, resolved })
      return
    }
    rDebug('navigable-links', 'file target exists', { raw_path: path, resolved })
    const ext = resolved.includes('.') ? '.' + resolved.split('.').pop()!.toLowerCase() : ''
    const intent = fileOpenIntent(event)

    // ⌥⌘ hands the file to the operating system, whatever it is. Same meaning
    // as ⌥⌘ on a web link: "not in Ion, in my own application."
    if (intent === 'native') {
      await openNatively(resolved)
      return
    }

    // ⌘ on an HTML file RENDERS it, matching what the file explorer has always
    // done. Before this the same file opened as source here and as a page
    // there, which is the inconsistency this resolves. ⇧⌘ still reads source.
    if (intent === 'view' && isRenderableHtml(resolved)) {
      const router = surfaceRouter()
      if (router) {
        rDebug('navigable-links', 'opening html preview in Studio surface', { resolved })
        router.openHtml(resolved)
        return
      }
      // The Overlay has no browser surface, so source is the honest fallback
      // rather than silently doing nothing.
      rDebug('navigable-links', 'no surface router; opening html as source', { resolved })
    }

    if (EDITABLE_EXTS.has(ext) && activeTabId) {
      const router = surfaceRouter()
      if (router) {
        rDebug('navigable-links', 'opening text file in Studio surface', { tab_id: activeTabId, working_directory: workingDir, resolved })
        try {
          router.openTextFile(workingDir, activeTabId, resolved)
        } catch (err) {
          rWarn('navigable-links', 'Studio surface file open failed', { tab_id: activeTabId, working_directory: workingDir, resolved, error: String(err) })
        }
        return
      }
      rDebug('navigable-links', 'opening text file in overlay editor', { tab_id: activeTabId, working_directory: workingDir, resolved })
      useSessionStore.getState().openFileInEditor(workingDir, activeTabId, resolved)
      return
    }

    await openNatively(resolved)
  }, [activeTabId, workingDir])

  const onOpenUrl = useCallback((url: string, event?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => {
    // The real click is forwarded rather than a synthesized { metaKey: true }.
    // Callers are already behind a ⌘ gate, but ⌥ has to stay visible here or
    // the escape-to-the-default-browser gesture would be silently swallowed.
    openClickedLink(url, event ?? { metaKey: true }, 'navigable-links')
  }, [])

  return { onOpenFile, onOpenUrl }
}

/**
 * Markdown `a` component. Handles both link kinds in one place:
 *
 *   - a link `remarkNavigableLinks` synthesized from a bare path/URL —
 *     cmd-gated, styled only while CMD is held, matching LinkSegment's
 *     affordance so detected paths read as plain text until they are actionable;
 *   - a real markdown link — always clickable, opens externally.
 *
 * Every markdown surface that wants navigable links uses this, so the gating
 * rule and the hover affordance cannot drift between the transcript, the plan
 * viewer, and the resource viewer.
 */
export const NavigableLink = React.memo(function NavigableLink({
  node,
  href,
  children,
  color,
  onOpenFile,
  onOpenUrl,
  chipFiles,
}: {
  node?: unknown
  href?: string
  children?: React.ReactNode
  /** Link color for a real markdown link (per-surface accent). */
  color: string
  /** Receives the click so ⇧ (source) and ⌥ (native) can be honoured. */
  onOpenFile: (path: string, event?: FileClickModifiers) => void
  onOpenUrl: (url: string, event?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => void
  /** Render a detected file path as an always-visible chip (see LinkSegment)
   * instead of plain text that only reveals itself on CMD. URLs are
   * unaffected — they keep the cmd-gated span treatment either way. */
  chipFiles?: boolean
}) {
  const colors = useColors()
  const cmdHeld = useCmdHeld()
  const [hovered, setHovered] = useState(false)
  const navigableKind = readNavigableKind(node)

  // Detected bare path / URL: text-like until CMD is held (or an
  // always-visible chip for a file path when chipFiles is set).
  if (navigableKind) {
    const label = typeof children === 'string' ? children : String(href || '')
    const target = extractLinkText(children) || label

    if (chipFiles && navigableKind === 'file') {
      return <LinkSegment segment={{ type: 'file', value: target }} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} asChip />
    }

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
          if (navigableKind === 'url') onOpenUrl(target, e)
          else onOpenFile(target, e)
        }}
      >
        {children}
        {navigableKind === 'url' && cmdHeld && hovered && (
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
            {target}
          </span>
        )}
      </span>
    )
  }

  // Real markdown link.
  return (
    <button
      type="button"
      className="underline decoration-dotted underline-offset-2 cursor-pointer"
      style={{ color }}
      onClick={(event) => {
        if (href) openClickedLink(String(href), event, 'navigable-links')
      }}
    >
      {children}
    </button>
  )
})

/** Flatten a React children tree to its text, for reading a link's label. */
function extractLinkText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (typeof children === 'number') return String(children)
  if (Array.isArray(children)) return children.map(extractLinkText).join('')
  if (React.isValidElement(children)) {
    return extractLinkText((children.props as { children?: React.ReactNode }).children)
  }
  return ''
}

/** Markdown `code` component — applies navigable links to inline code spans */
export const NavigableCode = React.memo(function NavigableCode({ children, className, onOpenFile, onOpenUrl, chipFiles, ...props }: {
  children: any
  className?: string
  /** Receives the click so ⇧ (source) and ⌥ (native) can be honoured. */
  onOpenFile: (path: string, event?: FileClickModifiers) => void
  onOpenUrl: (url: string, event?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean }) => void
  /** Render detected file paths as always-visible chips (see LinkSegment). */
  chipFiles?: boolean
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
  // A single file segment covering the entire inline-code span in chip mode:
  // render the chip bare (not nested inside the code chip styling) so the
  // path doesn't get double-boxed.
  if (chipFiles && segments.length === 1 && segments[0].type === 'file') {
    return <LinkSegment segment={segments[0]} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} asChip />
  }
  return <code {...props}>{segments.map((seg, i) => <LinkSegment key={i} segment={seg} onOpenFile={onOpenFile} onOpenUrl={onOpenUrl} asChip={chipFiles} />)}</code>
})
