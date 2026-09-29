/**
 * WorkspaceSearchPanel — the sidebar's Search view: literal text across every
 * workspace folder of the conversation on screen, grouped by file.
 *
 * Each file group folds on its header. Clicking a line opens the file in the
 * canvas with that match selected. The search runs on the conversation's
 * server, over the same roots the Explorer lists.
 */
import React, { useEffect, useMemo, useRef } from 'react'
import { ArrowsInLineVertical, ArrowsOutLineVertical, MagnifyingGlass } from '@phosphor-icons/react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import type { TextSearchFileResult, TextSearchLineMatch } from '@ion/shared/text-search'
import { pathSegments } from '@ion/shared/paths'
import { useColors } from '../../theme'
import { Chevron } from '../../components/Chevron'
import { getFileIcon } from '../../components/FileExplorerIcons'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { useWorkspaceRoots } from '../../hooks/useWorkspaceRoots'
import { contentRouter } from '../../lib/file-open-router'
import { rWarn } from '../../rendererLogger'
import { Tooltip } from '../../components/git/Tooltip'
import { useWorkspaceSearchStore } from './workspace-search-store'

/** Typing pause before a search is sent, so a fast typist sends one search. */
const SEARCH_DELAY_MS = 250

/** Remembered across remounts so a focus request is honoured exactly once. */
let handledFocusRequest = 0

type Colors = ReturnType<typeof useColors>

export function WorkspaceSearchPanel(): React.JSX.Element {
  const colors = useColors()
  const { allRoots } = useWorkspaceRoots()
  const query = useWorkspaceSearchStore((s) => s.query)
  const caseSensitive = useWorkspaceSearchStore((s) => s.caseSensitive)
  const wholeWord = useWorkspaceSearchStore((s) => s.wholeWord)
  const status = useWorkspaceSearchStore((s) => s.status)
  const result = useWorkspaceSearchStore((s) => s.result)
  const collapsed = useWorkspaceSearchStore((s) => s.collapsed)
  const focusRequest = useWorkspaceSearchStore((s) => s.focusRequest)
  const actions = useWorkspaceSearchStore.getState()
  const inputRef = useRef<HTMLInputElement>(null)

  const rootsKey = allRoots.join('\0')
  useEffect(() => {
    const timer = setTimeout(() => { void useWorkspaceSearchStore.getState().run(rootsKey ? rootsKey.split('\0') : []) }, SEARCH_DELAY_MS)
    return () => clearTimeout(timer)
  }, [query, caseSensitive, wholeWord, rootsKey])

  useEffect(() => {
    if (focusRequest === handledFocusRequest) return
    handledFocusRequest = focusRequest
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const multiRoot = allRoots.length > 1
  const allCollapsed = !!result && result.files.length > 0 && result.files.every((f) => collapsed.has(f.path))

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ padding: '8px 10px 6px', display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            border: `1px solid ${result?.error ? colors.statusError : colors.containerBorder}`,
            borderRadius: 6,
            padding: '3px 4px 3px 8px',
            background: colors.surfacePrimary,
          }}
        >
          <MagnifyingGlass size={13} color={colors.textTertiary} />
          <input
            ref={inputRef}
            data-workspace-search-input
            type="text"
            placeholder="Search"
            value={query}
            onChange={(e) => actions.setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void actions.run(allRoots)
              if (e.key === 'Escape') actions.setQuery('')
            }}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: colors.textPrimary, fontSize: 12 }}
          />
          <OptionToggle label="Aa" tooltip="Match Case" active={caseSensitive} onClick={actions.toggleCaseSensitive} colors={colors} />
          <OptionToggle label="ab" tooltip="Match Whole Word" active={wholeWord} onClick={actions.toggleWholeWord} colors={colors} underline />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 16, fontSize: 11, color: result?.error ? colors.statusError : colors.textTertiary }}>
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {summaryText(status, result, allRoots.length)}
          </span>
          {result && result.files.length > 0 && (
            <Tooltip text={allCollapsed ? 'Expand All' : 'Collapse All'}>
              <button
                onClick={() => actions.setAllCollapsed(!allCollapsed)}
                style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: colors.textTertiary, display: 'flex', padding: 2 }}
              >
                {allCollapsed ? <ArrowsOutLineVertical size={13} /> : <ArrowsInLineVertical size={13} />}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      <div role="tree" style={{ flex: 1, minHeight: 0, overflowY: 'auto', paddingBottom: 8 }}>
        {result?.files.map((file) => (
          <FileGroup
            key={file.path}
            file={file}
            label={groupLabel(file, multiRoot)}
            open={!collapsed.has(file.path)}
            onToggle={() => actions.toggleCollapsed(file.path)}
            colors={colors}
          />
        ))}
      </div>
    </div>
  )
}

function summaryText(status: string, result: { files: unknown[]; totalMatches: number; truncated: boolean; error?: string } | null, roots: number): string {
  if (roots === 0) return 'No workspace folder for this conversation.'
  if (status === 'searching' && !result) return 'Searching…'
  if (!result) return ''
  if (result.error) return result.error
  if (result.totalMatches === 0) return 'No results.'
  const lines = `${result.totalMatches} ${result.totalMatches === 1 ? 'result' : 'results'}`
  const files = `${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}`
  return `${lines} in ${files}${result.truncated ? ' (showing the first matches only)' : ''}`
}

/** The file's directory, prefixed with its workspace folder's name when there are several. */
function groupLabel(file: TextSearchFileResult, multiRoot: boolean): { name: string; dir: string } {
  const segments = file.relativePath.split('/')
  const name = segments.pop() ?? file.relativePath
  const dir = [multiRoot ? pathSegments(file.root).pop() : '', ...segments].filter(Boolean).join('/')
  return { name, dir }
}

function OptionToggle({ label, tooltip, active, onClick, colors, underline }: {
  label: string
  tooltip: string
  active: boolean
  onClick: () => void
  colors: Colors
  underline?: boolean
}): React.JSX.Element {
  return (
    <Tooltip text={tooltip}>
      <button
        aria-label={tooltip}
        aria-pressed={active}
        onClick={onClick}
        style={{
          border: `1px solid ${active ? colors.accent : 'transparent'}`,
          borderRadius: 4,
          background: active ? colors.accentSoft : 'transparent',
          color: active ? colors.textPrimary : colors.textTertiary,
          cursor: 'pointer',
          fontSize: 11,
          lineHeight: '14px',
          padding: '0 4px',
          textDecoration: underline ? 'underline' : undefined,
        }}
      >
        {label}
      </button>
    </Tooltip>
  )
}

function FileGroup({ file, label, open, onToggle, colors }: {
  file: TextSearchFileResult
  label: { name: string; dir: string }
  open: boolean
  onToggle: () => void
  colors: Colors
}): React.JSX.Element {
  const header = useInteractiveState()
  const icon = getFileIcon(label.name)
  return (
    <div role="treeitem" aria-expanded={open}>
      <div
        onClick={onToggle}
        {...header.handlers}
        style={{
          height: 22,
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          padding: '0 10px 0 6px',
          cursor: 'pointer',
          userSelect: 'none',
          background: interactiveBg(colors, { hover: header.hover, pressed: header.pressed }),
          fontSize: 12,
        }}
      >
        <Chevron open={open} size={10} color={colors.textTertiary} />
        <icon.icon size={14} color={colors[icon.colorKey]} />
        <span style={{ color: colors.textPrimary, whiteSpace: 'nowrap' }}>{label.name}</span>
        <span style={{ flex: 1, minWidth: 0, color: colors.textTertiary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label.dir}
        </span>
        <span style={{ fontSize: 10, color: colors.textSecondary, background: colors.surfacePrimary, borderRadius: 8, padding: '0 6px', flexShrink: 0 }}>
          {file.matches.length}
        </span>
      </div>
      {open && file.matches.map((match) => (
        <MatchRow key={match.line} file={file} match={match} colors={colors} />
      ))}
    </div>
  )
}

function openMatch(file: TextSearchFileResult, match: TextSearchLineMatch): void {
  const tabId = useSessionStore.getState().activeTabId
  const router = contentRouter()
  if (!router?.openTextFileAt || !tabId) {
    rWarn('workspace-search', 'cannot open a result: no canvas router or active conversation', { path: file.path, has_tab: !!tabId })
    return
  }
  router.openTextFileAt(file.root, tabId, file.path, { line: match.line, column: match.column, length: match.length })
}

function MatchRow({ file, match, colors }: { file: TextSearchFileResult; match: TextSearchLineMatch; colors: Colors }): React.JSX.Element {
  const row = useInteractiveState()
  const parts = useMemo(() => previewParts(match), [match])
  return (
    <div
      role="treeitem"
      onClick={() => openMatch(file, match)}
      {...row.handlers}
      style={{
        height: 22,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px 0 38px',
        cursor: 'pointer',
        background: interactiveBg(colors, { hover: row.hover, pressed: row.pressed }),
        fontSize: 12,
        color: colors.textSecondary,
        whiteSpace: 'pre',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {parts.map((part, i) => part.hit ? (
        <span key={i} style={{ background: colors.accentSoft, color: colors.textPrimary, borderRadius: 2, outline: `1px solid ${colors.accent}` }}>{part.text}</span>
      ) : (
        <span key={i}>{part.text}</span>
      ))}
    </div>
  )
}

/**
 * Split a preview into plain and matched runs, dropping leading indentation
 * so the match, not the whitespace, is what fits in the sidebar.
 */
export function previewParts(match: TextSearchLineMatch): Array<{ text: string; hit: boolean }> {
  const indent = match.preview.length - match.preview.trimStart().length
  const lead = Math.min(indent, match.ranges[0]?.[0] ?? indent)
  const parts: Array<{ text: string; hit: boolean }> = []
  let at = lead
  for (const [start, end] of match.ranges) {
    if (start > at) parts.push({ text: match.preview.slice(at, start), hit: false })
    parts.push({ text: match.preview.slice(Math.max(start, at), end), hit: true })
    at = Math.max(at, end)
  }
  if (at < match.preview.length) parts.push({ text: match.preview.slice(at), hit: false })
  return parts
}
