/**
 * MergeEditor — the 3-way merge view (Rider shape) for one conflicted file.
 *
 * Three panes: OURS left, RESULT center, THEIRS right. The model
 * (merge-model.ts) auto-applies every non-contested chunk the way `git merge`
 * itself would, so the operator only decides genuinely contested regions —
 * per-chunk `»` (take left) and `«` (take right) controls sit in the gutters,
 * with base/skip and both available per conflict.
 *
 * The center pane is a composition, not a free-text editor, until every
 * conflict is decided; a final "edit result" toggle exposes the composed text
 * for manual touch-up before save (matching what the old marker-based resolver
 * allowed). Save writes the file and stages it via GIT_RESOLVE_CONFLICT.
 *
 * Degraded shapes are first-class: add/add is one whole-file conflict, and
 * accepting a deleting side composes an empty result, which save maps to
 * accepting the deletion (GIT_CONFLICT_ACCEPT) rather than staging an empty
 * file the deleter never wrote.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, ArrowsInLineHorizontal, PencilSimple, Warning, X } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { FloatingPanel } from '../FloatingPanel'
import { Tooltip } from './Tooltip'
import { rError, rInfo, rWarn } from '../../rendererLogger'
import {
  buildMergeModel, applyChunk, unresolvedCount, composeResult,
  type MergeModel, type MergeChunk,
} from './merge-model'

interface Stages {
  base: string | null
  ours: string | null
  theirs: string | null
  oursLabel: string
  theirsLabel: string
}

export function MergeEditor({
  directory,
  path,
  onClose,
  onResolved,
}: {
  directory: string
  path: string
  onClose: () => void
  onResolved: () => void
}): React.JSX.Element {
  const colors = useColors()
  const [stages, setStages] = useState<Stages | null>(null)
  const [model, setModel] = useState<MergeModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editedText, setEditedText] = useState('')

  useEffect(() => {
    window.ion.gitConflictStages(directory, path).then((result) => {
      if (!result.ok) {
        setError(result.error ?? 'Could not read the conflict stages.')
        return
      }
      const s: Stages = {
        base: result.base ?? null,
        ours: result.ours ?? null,
        theirs: result.theirs ?? null,
        oursLabel: result.oursLabel ?? 'yours',
        theirsLabel: result.theirsLabel ?? 'incoming',
      }
      setStages(s)
      setModel(buildMergeModel(s.base, s.ours, s.theirs))
    }).catch((err) => {
      rError('git.merge', 'stages load failed', { path, error: String(err) })
      setError(String(err))
    })
  }, [directory, path])

  const remaining = model ? unresolvedCount(model) : 0
  const result = useMemo(() => (model ? composeResult(model) : null), [model])

  const resolve = useCallback((index: number, choice: 'ours' | 'theirs' | 'both' | 'skip') => {
    setModel((m) => (m ? applyChunk(m, index, choice) : m))
  }, [])

  const save = useCallback(async () => {
    if (!model) return
    const text = editing ? editedText : result
    if (text === null) return
    setSaving(true)
    try {
      if (text === '' && (stages?.ours === null || stages?.theirs === null)) {
        // An empty result on a delete-conflict means the deletion won. Stage
        // the removal rather than an empty file the deleting side never wrote.
        const side = stages?.ours === null ? 'ours' : 'theirs'
        const accepted = await window.ion.gitConflictAccept(directory, path, side)
        if (!accepted.ok) {
          rWarn('git.merge', 'delete-acceptance failed', { path, error: accepted.error ?? '' })
          setError(accepted.error ?? 'Could not accept the deletion.')
          return
        }
      } else {
        const written = await window.ion.gitResolveConflict(directory, path, text)
        if (!written.ok) {
          rWarn('git.merge', 'resolve write failed', { path, error: written.error ?? '' })
          setError(written.error ?? 'Could not write the resolution.')
          return
        }
      }
      rInfo('git.merge', 'file resolved', { path, edited: editing, chunks: model.chunks.length })
      onResolved()
    } finally {
      setSaving(false)
    }
  }, [model, editing, editedText, result, stages, directory, path, onResolved])

  /** Gutter controls for one conflict chunk. */
  const conflictControls = (chunkIndex: number, side: 'ours' | 'theirs'): React.JSX.Element => (
    <Tooltip text={side === 'ours' ? 'Take this side' : 'Take this side'}>
      <button
        data-testid={`merge-take-${side}-${chunkIndex}`}
        onClick={() => resolve(chunkIndex, side)}
        style={{
          display: 'inline-flex', alignItems: 'center', padding: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', color: colors.accent,
        }}
      >
        {side === 'ours' ? <ArrowRight size={11} /> : <ArrowLeft size={11} />}
      </button>
    </Tooltip>
  )

  const paneStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, overflow: 'auto', fontFamily: 'monospace', fontSize: 10,
    lineHeight: 1.5, whiteSpace: 'pre', padding: '4px 6px',
  }

  const chunkBg = (c: MergeChunk): string =>
    c.kind === 'conflict' && c.resolution === null ? colors.surfaceSelected
      : c.kind === 'conflict' ? colors.accentLight
        : c.kind === 'same' ? 'transparent' : colors.surfaceHover

  return (
    <FloatingPanel
      title={`Merge — ${path.split('/').pop() ?? path}`}
      onClose={onClose}
      defaultWidth={980}
      defaultHeight={560}
      workingDir={directory}
      filePath={path}
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {error && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', fontSize: 11, color: colors.dangerFg }}>
            <Warning size={12} /> {error}
          </div>
        )}

        {/* Header: what remains contested, and the whole-file verbs. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${colors.containerBorder}` }}>
          <span style={{ fontSize: 10, color: remaining > 0 ? colors.warningFg : colors.worktreeGreen }}>
            {remaining > 0 ? `${remaining} conflict${remaining === 1 ? '' : 's'} to resolve` : 'All conflicts resolved'}
          </span>
          {model?.degradedNoBase && (
            <span style={{ fontSize: 9, color: colors.textTertiary }}>
              (both sides added this file — no common ancestor)
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button
            data-testid="merge-take-all-ours"
            onClick={() => model?.chunks.forEach((c, i) => { if (c.kind === 'conflict' && c.resolution === null) resolve(i, 'ours') })}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary }}
          >
            All {stages?.oursLabel ?? 'yours'}
          </button>
          <button
            data-testid="merge-take-all-theirs"
            onClick={() => model?.chunks.forEach((c, i) => { if (c.kind === 'conflict' && c.resolution === null) resolve(i, 'theirs') })}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary }}
          >
            All {stages?.theirsLabel ?? 'theirs'}
          </button>
        </div>

        {/* The three panes. */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* OURS */}
          <div style={{ ...paneStyle, borderRight: `1px solid ${colors.containerBorder}` }}>
            <div style={{ fontSize: 9, color: colors.textSecondary, position: 'sticky', top: 0, background: colors.containerBg }}>
              {stages?.oursLabel ?? 'yours'}
            </div>
            {model?.chunks.map((c, i) => (
              <div key={i} style={{ background: chunkBg(c), display: 'flex', alignItems: 'flex-start' }}>
                <div style={{ flex: 1, minWidth: 0 }}>{c.ours.join('\n') || '\u00A0'}</div>
                {c.kind === 'conflict' && c.resolution === null && conflictControls(i, 'ours')}
              </div>
            ))}
          </div>

          {/* RESULT */}
          <div style={{ ...paneStyle, borderRight: `1px solid ${colors.containerBorder}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 9, color: colors.textSecondary, position: 'sticky', top: 0, background: colors.containerBg }}>
              result
              <Tooltip text="Edit the composed result as free text before saving">
                <button
                  data-testid="merge-edit-result"
                  disabled={remaining > 0}
                  onClick={() => {
                    setEditedText(result ?? '')
                    setEditing(true)
                  }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', padding: 1, background: 'transparent',
                    border: 'none', cursor: remaining > 0 ? 'default' : 'pointer',
                    color: remaining > 0 ? colors.textTertiary : colors.accent,
                  }}
                >
                  <PencilSimple size={10} />
                </button>
              </Tooltip>
            </div>
            {editing ? (
              <textarea
                data-testid="merge-result-textarea"
                value={editedText}
                onChange={(e) => setEditedText(e.target.value)}
                style={{
                  width: '100%', height: '90%', resize: 'none', fontFamily: 'monospace', fontSize: 10,
                  background: 'transparent', color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`,
                }}
              />
            ) : (
              model?.chunks.map((c, i) => (
                <div key={i} style={{ background: chunkBg(c), display: 'flex', alignItems: 'flex-start', gap: 4 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {c.resolution !== null
                      ? (c.resolution.join('\n') || '\u00A0')
                      : <span style={{ color: colors.dangerFg }}>{'<?>'}</span>}
                  </div>
                  {c.kind === 'conflict' && c.resolution === null && (
                    <>
                      <Tooltip text="Take both, yours first">
                        <button
                          data-testid={`merge-take-both-${i}`}
                          onClick={() => resolve(i, 'both')}
                          style={{ display: 'inline-flex', padding: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: colors.accent }}
                        >
                          <ArrowsInLineHorizontal size={11} />
                        </button>
                      </Tooltip>
                      <Tooltip text="Keep the base (drop both changes)">
                        <button
                          data-testid={`merge-skip-${i}`}
                          onClick={() => resolve(i, 'skip')}
                          style={{ display: 'inline-flex', padding: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: colors.textTertiary }}
                        >
                          <X size={11} />
                        </button>
                      </Tooltip>
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          {/* THEIRS */}
          <div style={paneStyle}>
            <div style={{ fontSize: 9, color: colors.textSecondary, position: 'sticky', top: 0, background: colors.containerBg }}>
              {stages?.theirsLabel ?? 'incoming'}
            </div>
            {model?.chunks.map((c, i) => (
              <div key={i} style={{ background: chunkBg(c), display: 'flex', alignItems: 'flex-start' }}>
                {c.kind === 'conflict' && c.resolution === null && conflictControls(i, 'theirs')}
                <div style={{ flex: 1, minWidth: 0 }}>{c.theirs.join('\n') || '\u00A0'}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderTop: `1px solid ${colors.containerBorder}` }}>
          <span style={{ flex: 1 }} />
          <button
            data-testid="merge-cancel"
            onClick={onClose}
            style={{ fontSize: 11, padding: '3px 10px', borderRadius: 4, cursor: 'pointer', border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary }}
          >
            Cancel
          </button>
          <button
            data-testid="merge-save"
            onClick={() => { void save() }}
            disabled={saving || (editing ? false : result === null)}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 4,
              cursor: result !== null || editing ? 'pointer' : 'default',
              border: `1px solid ${result !== null || editing ? colors.worktreeGreen : colors.containerBorder}`,
              background: 'transparent',
              color: result !== null || editing ? colors.worktreeGreen : colors.textTertiary,
            }}
          >
            Save resolution
          </button>
        </div>
      </div>
    </FloatingPanel>
  )
}
