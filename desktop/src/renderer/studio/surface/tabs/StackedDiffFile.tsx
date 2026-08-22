/**
 * StackedDiffFile — one file's section in the stacked Diff surface:
 * sticky header (name, +/- counts, collapse chevron, stage/unstage) +
 * DiffTable over parseDiffWithHunks (pure reuse — never DiffPane's popup
 * chrome).
 *
 * Perf: content-visibility:auto + contain-intrinsic-size keep off-screen
 * sections out of layout; the parent's IntersectionObserver triggers the
 * lazy diff fetch. Sections auto-collapse above 2,000 diff lines with a
 * "Show anyway" affordance.
 */
import React, { useMemo, useState } from 'react'
import { useColors } from '../../../theme'
import { Chevron } from '../../../components/Chevron'
import { DiffTable } from '../../../components/git/DiffTable'
import { parseDiffWithHunks } from '../../../components/git/diffParse'
import { rError } from '../../../rendererLogger'
import { UnsupportedDiffNotice } from '../../../components/git/UnsupportedDiffNotice'
import type { GitChangedFile } from '../../../../shared/types'

const AUTO_COLLAPSE_LINES = 2000

export function StackedDiffFile({
  repoDir,
  file,
  diff,
  diffState,
  isBinary,
  onRefresh,
}: {
  repoDir: string
  file: GitChangedFile
  diff: string
  diffState: 'loading' | 'ready' | 'error'
  isBinary: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const colors = useColors()
  const [collapsed, setCollapsed] = useState(false)
  const [showAnyway, setShowAnyway] = useState(false)

  const parsed = useMemo(() => (diffState === 'ready' && diff && !isBinary ? parseDiffWithHunks(diff) : null), [diffState, diff, isBinary])
  const lineCount = parsed?.lines.length ?? 0
  const adds = useMemo(() => parsed?.lines.filter((l) => l.type === 'add').length ?? 0, [parsed])
  const dels = useMemo(() => parsed?.lines.filter((l) => l.type === 'remove').length ?? 0, [parsed])
  const tooBig = lineCount > AUTO_COLLAPSE_LINES && !showAnyway

  const toggleStage = (): void => {
    const op = file.staged ? window.ion.gitUnstage(repoDir, [file.path]) : window.ion.gitStage(repoDir, [file.path])
    void op
      .then((result) => {
        if (result.ok) onRefresh()
      })
      .catch((err) => rError('studio.diff', 'stage toggle failed', { path: file.path, error: String(err) }))
  }

  return (
    <section
      data-diff-path={file.path}
      data-diff-staged={file.staged ? '1' : '0'}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: collapsed || tooBig ? '32px' : '400px',
        borderBottom: `1px solid ${colors.containerBorder}`,
      }}
    >
      <div
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 10px',
          background: colors.surfacePrimary,
          borderBottom: `1px solid ${colors.containerBorder}`,
          fontSize: 11,
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <button
          onClick={() => setCollapsed((v) => !v)}
          style={{ border: 'none', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, color: colors.textPrimary, padding: 0 }}
        >
          <Chevron open={!collapsed} size={10} weight="regular" />
          <span style={{ fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.path}</span>
        </button>
        {parsed && (
          <span style={{ display: 'flex', gap: 4, fontFamily: 'monospace', fontSize: 10 }}>
            <span style={{ color: colors.diffAddText }}>+{adds}</span>
            <span style={{ color: colors.diffRemoveText }}>−{dels}</span>
          </span>
        )}
        <div style={{ flex: 1 }} />
        <button
          onClick={toggleStage}
          style={{
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 4,
            background: 'transparent',
            color: colors.textTertiary,
            cursor: 'pointer',
            fontSize: 10,
            padding: '1px 6px',
          }}
        >
          {file.staged ? 'Unstage' : 'Stage'}
        </button>
      </div>
      {!collapsed && (
        <div>
          {diffState === 'loading' && (
            <div style={{ padding: 10, color: colors.textTertiary, fontSize: 11, fontFamily: 'system-ui, sans-serif' }}>Loading diff…</div>
          )}
          {diffState === 'error' && (
            <div style={{ padding: 10, color: colors.textTertiary, fontSize: 11, fontFamily: 'system-ui, sans-serif' }}>Diff could not be read.</div>
          )}
          {isBinary && diffState === 'ready' && <UnsupportedDiffNotice />}
          {parsed && tooBig && (
            <div style={{ padding: 10, fontSize: 11, color: colors.textTertiary, fontFamily: 'system-ui, sans-serif', display: 'flex', gap: 8, alignItems: 'center' }}>
              {lineCount.toLocaleString()} diff lines — collapsed for performance.
              <button
                onClick={() => setShowAnyway(true)}
                style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: 4, background: 'transparent', color: colors.accent, cursor: 'pointer', fontSize: 10, padding: '1px 6px' }}
              >
                Show anyway
              </button>
            </div>
          )}
          {parsed && !tooBig && (
            <DiffTable
              parsed={parsed}
              selected={EMPTY_SELECTION}
              staged={file.staged}
              onLineClick={noop}
              onHunkAction={noop}
              onHunkDiscard={noop}
            />
          )}
        </div>
      )}
    </section>
  )
}

const EMPTY_SELECTION = new Set<number>()
function noop(): void {
  // The stacked view is read+stage oriented; per-line/hunk staging stays in
  // the git panel's DiffPane (its host owns selection state).
}
