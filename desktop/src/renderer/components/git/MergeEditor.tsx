/**
 * MergeEditor — the 3-way merge view (JetBrains merge-window shape) for one
 * conflicted file.
 *
 * Three panes: OURS left, RESULT center, THEIRS right. The model
 * (merge-model.ts) auto-applies every non-contested chunk the way `git merge`
 * itself would; the operator's work is the contested chunks.
 *
 * ── Per-side controls, like Rider ───────────────────────────────────────────
 * Every changed chunk carries its own gutter controls on the side that owns
 * the change: `»` / `«` accepts that side's change into the result, `×`
 * excludes it. A conflict needs BOTH sides decided (accept one, accept both —
 * ours-then-theirs — or exclude both, which keeps the base). Decisions are
 * reversible: clicking the other control flips the side. The result pane
 * recomposes live as decisions land.
 *
 * ── Provenance coloring ─────────────────────────────────────────────────────
 * The result pane colors every line by where it came from: accent-tinted for
 * ours, add-tinted (green) for theirs, plain for base. The side panes tint
 * their own changed chunks the same way, and undecided conflicts are
 * remove-tinted (red) on both sides. The coloring IS the answer to "what is
 * unchanged, what came from the left, what came from the right".
 *
 * All text uses explicit theme colors — the panes render inside FloatingPanel
 * on the dark overlay, where inherited/default text color is unreadable.
 *
 * ── Save ────────────────────────────────────────────────────────────────────
 * Save writes the composed result and stages it via GIT_RESOLVE_CONFLICT. An
 * "edit result" toggle exposes the composed text for manual touch-up first.
 * An empty result on a delete-conflict means the deletion won, and save maps
 * it to accepting the deletion (GIT_CONFLICT_ACCEPT → `git rm`) rather than
 * staging an empty file the deleting side never wrote.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, PencilSimple, Warning, X } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { ColorPalette } from '../../theme-tokens'
import { FloatingPanel } from '../FloatingPanel'
import { Tooltip } from './Tooltip'
import { rError, rInfo, rWarn } from '../../rendererLogger'
import {
  buildMergeModel, setSideDecision, unresolvedCount, composeResult, composeChunk, isUnresolved,
  type MergeModel, type MergeChunk,
} from './merge-model'

interface Stages {
  base: string | null
  ours: string | null
  theirs: string | null
  oursLabel: string
  theirsLabel: string
}

/** Chunk tint per pane. The vocabulary the operator reads at a glance. */
function chunkTint(colors: ColorPalette, c: MergeChunk, pane: 'ours' | 'theirs'): string {
  if (isUnresolved(c)) return colors.diffRemoveBg
  if (c.kind === 'same') return 'transparent'
  const sideChanged = pane === 'ours'
    ? c.kind === 'ours' || c.kind === 'conflict'
    : c.kind === 'theirs' || c.kind === 'conflict'
  if (!sideChanged) return 'transparent'
  return pane === 'ours' ? colors.accentLight : colors.diffAddBg
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

  const decide = useCallback((index: number, side: 'ours' | 'theirs', decision: 'accepted' | 'excluded') => {
    setModel((m) => (m ? setSideDecision(m, index, side, decision) : m))
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

  /**
   * Gutter controls for one side of one chunk: accept (»/«) and exclude (×).
   * The active decision renders solid so the current state is always visible;
   * clicking the other control flips it — decisions are reversible.
   */
  const sideControls = (chunkIndex: number, c: MergeChunk, side: 'ours' | 'theirs'): React.JSX.Element | null => {
    const changed = c.kind === 'conflict' || c.kind === side
    if (!changed) return null
    const decision = side === 'ours' ? c.oursDecision : c.theirsDecision
    const AcceptIcon = side === 'ours' ? ArrowRight : ArrowLeft
    return (
      <span style={{ display: 'inline-flex', gap: 1, flexShrink: 0, alignItems: 'flex-start', paddingTop: 1 }}>
        <Tooltip text={`Include ${side === 'ours' ? stages?.oursLabel ?? 'left' : stages?.theirsLabel ?? 'right'} in the result`}>
          <button
            data-testid={`merge-accept-${side}-${chunkIndex}`}
            onClick={() => decide(chunkIndex, side, 'accepted')}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 1, borderRadius: 2,
              background: decision === 'accepted' ? colors.accent : 'transparent',
              border: 'none', cursor: 'pointer',
              color: decision === 'accepted' ? colors.textPrimary : colors.accent,
            }}
          >
            <AcceptIcon size={11} weight="bold" />
          </button>
        </Tooltip>
        <Tooltip text="Exclude this change from the result">
          <button
            data-testid={`merge-exclude-${side}-${chunkIndex}`}
            onClick={() => decide(chunkIndex, side, 'excluded')}
            style={{
              display: 'inline-flex', alignItems: 'center', padding: 1, borderRadius: 2,
              background: decision === 'excluded' ? colors.textTertiary : 'transparent',
              border: 'none', cursor: 'pointer',
              color: decision === 'excluded' ? colors.textPrimary : colors.textTertiary,
            }}
          >
            <X size={11} weight="bold" />
          </button>
        </Tooltip>
      </span>
    )
  }

  const paneStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, overflow: 'auto', fontFamily: 'monospace', fontSize: 10,
    lineHeight: 1.5, whiteSpace: 'pre', padding: '4px 6px',
    color: colors.textPrimary,
  }
  const paneHeader: React.CSSProperties = {
    fontSize: 9, color: colors.textSecondary, position: 'sticky', top: 0,
    background: colors.containerBg, zIndex: 1, paddingBottom: 2,
  }

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

        {/* Header: what remains contested, the legend, and the bulk verbs. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${colors.containerBorder}` }}>
          <span style={{ fontSize: 10, color: remaining > 0 ? colors.warningFg : colors.worktreeGreen }}>
            {remaining > 0 ? `${remaining} conflict${remaining === 1 ? '' : 's'} to resolve` : 'All conflicts resolved'}
          </span>
          {model?.degradedNoBase && (
            <span style={{ fontSize: 9, color: colors.textTertiary }}>
              (both sides added this file — no common ancestor)
            </span>
          )}
          {/* Legend: the tints are the vocabulary; name them once. */}
          <span style={{ display: 'inline-flex', gap: 8, fontSize: 9, color: colors.textSecondary }}>
            <span><span style={{ background: colors.accentLight, padding: '0 4px', borderRadius: 2 }}>{stages?.oursLabel ?? 'left'}</span></span>
            <span><span style={{ background: colors.diffAddBg, padding: '0 4px', borderRadius: 2 }}>{stages?.theirsLabel ?? 'right'}</span></span>
            <span><span style={{ background: colors.diffRemoveBg, padding: '0 4px', borderRadius: 2 }}>unresolved</span></span>
          </span>
          <span style={{ flex: 1 }} />
          <button
            data-testid="merge-take-all-ours"
            onClick={() => setModel((m) => {
              if (!m) return m
              let next = m
              m.chunks.forEach((c, i) => {
                if (isUnresolved(c)) {
                  next = setSideDecision(next, i, 'ours', 'accepted')
                  next = setSideDecision(next, i, 'theirs', 'excluded')
                }
              })
              return next
            })}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary }}
          >
            All {stages?.oursLabel ?? 'left'}
          </button>
          <button
            data-testid="merge-take-all-theirs"
            onClick={() => setModel((m) => {
              if (!m) return m
              let next = m
              m.chunks.forEach((c, i) => {
                if (isUnresolved(c)) {
                  next = setSideDecision(next, i, 'ours', 'excluded')
                  next = setSideDecision(next, i, 'theirs', 'accepted')
                }
              })
              return next
            })}
            style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textPrimary }}
          >
            All {stages?.theirsLabel ?? 'right'}
          </button>
        </div>

        {/* The three panes. */}
        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* OURS — controls on the right edge, pointing at the result. */}
          <div style={{ ...paneStyle, borderRight: `1px solid ${colors.containerBorder}` }}>
            <div style={paneHeader}>{stages?.oursLabel ?? 'yours'}</div>
            {model?.chunks.map((c, i) => (
              <div key={i} style={{ background: chunkTint(colors, c, 'ours'), display: 'flex', alignItems: 'flex-start', borderRadius: 2 }}>
                <div style={{ flex: 1, minWidth: 0 }}>{c.ours.join('\n') || '\u00A0'}</div>
                {sideControls(i, c, 'ours')}
              </div>
            ))}
          </div>

          {/* RESULT — provenance-colored composition, live as decisions land. */}
          <div style={{ ...paneStyle, borderRight: `1px solid ${colors.containerBorder}` }}>
            <div style={{ ...paneHeader, display: 'flex', alignItems: 'center', gap: 6 }}>
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
              model?.chunks.map((c, i) => {
                const composed = composeChunk(c)
                if (composed === null) {
                  // Undecided conflict: hold the space with an unmissable marker.
                  return (
                    <div key={i} data-testid={`merge-result-pending-${i}`} style={{ background: colors.diffRemoveBg, color: colors.diffRemoveText, borderRadius: 2 }}>
                      {'<?> resolve this conflict'}
                    </div>
                  )
                }
                return (
                  <div key={i}>
                    {composed.map((line, j) => (
                      <div
                        key={j}
                        style={{
                          background: line.source === 'ours' ? colors.accentLight
                            : line.source === 'theirs' ? colors.diffAddBg : 'transparent',
                          borderRadius: 2,
                        }}
                      >
                        {line.text || '\u00A0'}
                      </div>
                    ))}
                    {composed.length === 0 && <div style={{ color: colors.textTertiary }}>{'\u00A0'}</div>}
                  </div>
                )
              })
            )}
          </div>

          {/* THEIRS — controls on the left edge, pointing at the result. */}
          <div style={paneStyle}>
            <div style={paneHeader}>{stages?.theirsLabel ?? 'incoming'}</div>
            {model?.chunks.map((c, i) => (
              <div key={i} style={{ background: chunkTint(colors, c, 'theirs'), display: 'flex', alignItems: 'flex-start', borderRadius: 2 }}>
                {sideControls(i, c, 'theirs')}
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
