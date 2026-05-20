/**
 * Unified diff pane with side-by-side toggle, word-diff highlights, per-hunk
 * and partial-line staging, and image/binary fallbacks.
 *
 * Rendering tables live in `DiffTable.tsx` (unified) and `DiffSideBySide.tsx`
 * (split). Staging math sits in `diffParse.ts`. View mode is persisted to
 * localStorage so it survives across tabs.
 */

import React, { useMemo, useCallback, useState, useEffect } from 'react'
import { X, Rows, Columns } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { parseDiffWithHunks, buildHunkPatch, buildPartialLinePatch } from './diffParse'
import type { ParsedDiff, DiffLine } from './diffParse'
import { DiffTable } from './DiffTable'
import { DiffSideBySide } from './DiffSideBySide'

const VIEW_MODE_KEY = 'ion:diff-view-mode'

interface DiffPaneProps {
  diff: string
  fileName: string
  filePath: string
  staged: boolean
  directory: string
  onClose: () => void
  onRefresh: () => void
}

function isImageFile(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name)
}

function isBinaryDiff(raw: string): boolean {
  return /^Binary files .* differ$/m.test(raw) || /^GIT binary patch$/m.test(raw)
}

export function DiffPane({ diff, fileName, filePath, staged, directory, onClose, onRefresh }: DiffPaneProps) {
  const colors = useColors()
  const parsed: ParsedDiff = useMemo(() => parseDiffWithHunks(diff), [diff])
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [anchor, setAnchor] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'unified' | 'split'>(() => (typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_MODE_KEY) === 'split') ? 'split' : 'unified')

  useEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(VIEW_MODE_KEY, viewMode)
  }, [viewMode])

  const insertions = parsed.lines.filter((l) => l.type === 'add').length
  const deletions = parsed.lines.filter((l) => l.type === 'remove').length
  const binary = isBinaryDiff(diff)
  const image = isImageFile(fileName)

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
      if (typeof hunk === 'number') stageOrUnstageHunk(hunk)
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
          {!binary && (insertions > 0 || deletions > 0) && (
            <span style={{ color: colors.textTertiary }}>
              <span style={{ color: '#7aac8c' }}>+{insertions}</span>{' '}
              <span style={{ color: '#c47060' }}>−{deletions}</span>
            </span>
          )}
          {selected.size > 0 && (
            <span style={{ color: colors.accent, fontSize: 9 }}>{selected.size} line{selected.size === 1 ? '' : 's'} selected</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {!binary && (
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
        {image ? (
          <ImageDiff directory={directory} filePath={filePath} />
        ) : binary ? (
          <div className="p-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
            Binary file changed
          </div>
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
            onHunkAction={stageOrUnstageHunk}
            onHunkDiscard={discardHunk}
          />
        )}
      </div>

      {error && (
        <div className="px-2 py-1.5 text-[10px]" style={{ color: '#c47060', borderTop: `1px solid ${colors.containerBorder}`, background: colors.surfacePrimary }}>
          {error}
        </div>
      )}
    </div>
  )
}

function ImageDiff({ directory, filePath }: { directory: string; filePath: string }) {
  const colors = useColors()
  const [before, setBefore] = useState<string | null>(null)
  const [after, setAfter] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    window.ion.gitShowFile(directory, 'HEAD', filePath).then((r) => {
      if (cancelled) return
      if (r.ok && r.content) setBefore(`data:image/*;base64,${btoa(r.content)}`)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [directory, filePath])

  useEffect(() => {
    let cancelled = false
    window.ion.fsReadFile(`${directory}/${filePath}`).then((r) => {
      if (cancelled) return
      if (r.content) setAfter(`data:image/*;base64,${btoa(r.content)}`)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [directory, filePath])

  return (
    <div className="p-4 flex items-center justify-around gap-4" style={{ color: colors.textSecondary }}>
      <div className="flex flex-col items-center gap-2">
        <span className="text-[10px]" style={{ color: colors.textTertiary }}>Before</span>
        {before ? <img src={before} style={{ maxWidth: '40vw', maxHeight: '60vh', border: `1px solid ${colors.containerBorder}` }} /> : <div className="text-[10px]" style={{ color: colors.textMuted }}>(not in HEAD)</div>}
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="text-[10px]" style={{ color: colors.textTertiary }}>After</span>
        {after ? <img src={after} style={{ maxWidth: '40vw', maxHeight: '60vh', border: `1px solid ${colors.containerBorder}` }} /> : <div className="text-[10px]" style={{ color: colors.textMuted }}>(removed)</div>}
      </div>
    </div>
  )
}
