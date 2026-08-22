/**
 * Unified diff pane with side-by-side toggle, word-diff highlights, per-hunk
 * and partial-line staging. Binary files render an explicit unsupported-content
 * notice rather than passing content to a diff table.
 *
 * Rendering tables live in `DiffTable.tsx` (unified) and `DiffSideBySide.tsx`
 * (split). Staging math sits in `diffParse.ts`. View mode is persisted to
 * localStorage so it survives across tabs.
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react'
import { rError } from '../../rendererLogger'
import { X, Rows, Columns } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { parseDiffWithHunks, buildHunkPatch, buildPartialLinePatch } from './diffParse'
import type { ParsedDiff, DiffLine } from './diffParse'
import { DiffTable } from './DiffTable'
import { DiffSideBySide } from './DiffSideBySide'
import { UnsupportedDiffNotice } from './UnsupportedDiffNotice'

const VIEW_MODE_KEY = 'ion:diff-view-mode'
const EMPTY_PARSED_DIFF: ParsedDiff = { fileHeader: [], hunks: [], lines: [] }

interface DiffPaneProps {
  diff: string
  fileName: string
  filePath: string
  isBinary: boolean
  staged: boolean
  directory: string
  onClose: () => void
  onRefresh: () => void
}


export function DiffPane({ diff, fileName, filePath, isBinary, staged, directory, onClose, onRefresh }: DiffPaneProps) {
  const colors = useColors()
  const parsed = useMemo<ParsedDiff>(
    () => isBinary ? EMPTY_PARSED_DIFF : parseDiffWithHunks(diff),
    [diff, isBinary],
  )
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'unified' | 'split'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_MODE_KEY) === 'split') ? 'split' : 'unified')

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  const insertions = parsed.lines.filter((l) => l.type === 'add').length
  const deletions = parsed.lines.filter((l) => l.type === 'remove').length

  const clearSelection = (): void => { setSelected(new Set()); setAnchor(null) }

  const handleLineClick = useCallback((line: DiffLine, ev: React.MouseEvent) => {
    if (line.type !== 'add' && line.type !== 'remove') return
    if (ev.shiftKey && anchor !== null) {
      const hunkLines = parsed.lines.filter((l) => l.hunkIndex === line.hunkIndex && (l.type === 'add' || l.type === 'remove'))
      const ai = hunkLines.findIndex((l) => l.rawIndex === anchor)
      const bi = hunkLines.findIndex((l) => l.rawIndex === line.rawIndex)
      if (ai >= 0 && bi >= 0) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
        setSelected(new Set(hunkLines.slice(lo, hi + 1).map((l) => l.rawIndex)))
      }
    } else if (ev.metaKey || ev.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(line.rawIndex)) next.delete(line.rawIndex)
        else next.add(line.rawIndex)
        return next
      })
      setAnchor(line.rawIndex)
    } else {
      setSelected(new Set([line.rawIndex]))
      setAnchor(line.rawIndex)
    }
  }, [parsed.lines, anchor])

  const stageOrUnstageHunk = useCallback(async (hunkIdx: number) => {
    setError(null)
    const selectedInHunk = new Set([...selected].filter((idx) => parsed.lines.find((l) => l.rawIndex === idx)?.hunkIndex === hunkIdx))
    const patch = selectedInHunk.size > 0
      ? buildPartialLinePatch(parsed, hunkIdx, selectedInHunk)
      : buildHunkPatch(parsed, hunkIdx)
    if (!patch) return
    const result = await window.ion.gitApplyPatch(directory, patch, { cached: true, reverse: staged })
    if (!result.ok) { setError(result.error ?? 'Apply failed'); return }
    clearSelection()
    onRefresh()
  }, [parsed, selected, directory, staged, onRefresh])

  const discardHunk = useCallback(async (hunkIdx: number) => {
    if (staged) return
    setError(null)
    const patch = buildHunkPatch(parsed, hunkIdx)
    if (!patch) return
    const result = await window.ion.gitApplyPatch(directory, patch, { cached: false, reverse: true })
    if (!result.ok) { setError(result.error ?? 'Discard failed'); return }
    clearSelection()
    onRefresh()
  }, [parsed, directory, staged, onRefresh])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 's') {
      const hunk = parsed.lines.find((l) => selected.has(l.rawIndex))?.hunkIndex
      if (typeof hunk === 'number') void stageOrUnstageHunk(hunk).catch((err) => rError('git', 'stage hunk failed', { error: String(err) }))
    }
  }, [parsed.lines, selected, stageOrUnstageHunk])

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', height: '100%', borderTop: `1px solid ${colors.containerBorder}` }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div
        className="flex items-center justify-between px-2"
        style={{ height: 24, flexShrink: 0, borderBottom: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary }}
      >
        <div className="flex items-center gap-1.5 text-[10px] truncate" style={{ color: colors.textSecondary }}>
          <span className="truncate font-medium">{fileName}</span>
          <span style={{ color: colors.textMuted, fontSize: 9 }}>{filePath}</span>
          {!isBinary && (insertions > 0 || deletions > 0) && (
            <span style={{ color: colors.textTertiary }}>
              <span style={{ color: colors.successFg }}>+{insertions}</span>{' '}
              <span style={{ color: colors.dangerFg }}>−{deletions}</span>
            </span>
          )}
          {selected.size > 0 && (
            <span style={{ color: colors.accent, fontSize: 9 }}>{selected.size} line{selected.size === 1 ? '' : 's'} selected</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!isBinary && (
            <button
              onClick={() => setViewMode((m) => m === 'unified' ? 'split' : 'unified')}
              className="p-0.5 rounded"
              style={{ color: colors.textTertiary }}
              title={viewMode === 'unified' ? 'Switch to side-by-side' : 'Switch to unified'}
            >
              {viewMode === 'unified' ? <Columns size={11} /> : <Rows size={11} />}
            </button>
          )}
          <button onClick={onClose} className="p-0.5 rounded" style={{ color: colors.textTertiary }} title="Close diff">
            <X size={10} />
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', minHeight: 0 }}>
        {isBinary ? (
          <UnsupportedDiffNotice />
        ) : parsed.lines.length === 0 ? (
          <div className="p-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>No changes</div>
        ) : viewMode === 'split' ? (
          <DiffSideBySide parsed={parsed} />
        ) : (
          <DiffTable
            parsed={parsed}
            selected={selected}
            staged={staged}
            onLineClick={handleLineClick}
            onHunkAction={(hunkIdx) => { void stageOrUnstageHunk(hunkIdx).catch((err) => rError('git', 'stage hunk failed', { error: String(err) })) }}
            onHunkDiscard={(hunkIdx) => { void discardHunk(hunkIdx).catch((err) => rError('git', 'discard hunk failed', { error: String(err) })) }}
          />
        )}
      </div>

      {error && (
        <div className="px-2 py-1.5 text-[10px]" style={{ color: colors.dangerFg, borderTop: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary }}>
          {error}
        </div>
      )}
    </div>
  )
}
