/**
 * GraphViewsMenu — list, save, load, rename, delete saved views. Project
 * views and user views with the same name both appear, disambiguated by
 * source; only user views carry rename/delete actions — a project view's
 * actions are ABSENT (not disabled), with a tooltip stating it ships with
 * the corpus.
 */

import React, { useState } from 'react'
import { useColors } from '../../../theme'
import { Tooltip } from '../../../components/git/Tooltip'
import { useGraphStore } from '../graph-store'

export function GraphViewsMenu(): React.JSX.Element {
  const colors = useColors()
  const config = useGraphStore((s) => s.config)
  const saveUserView = useGraphStore((s) => s.saveUserView)
  const loadView = useGraphStore((s) => s.loadView)
  const deleteUserView = useGraphStore((s) => s.deleteUserView)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const views = config?.savedViews ?? []

  async function handleSave(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = views.find((v) => v.source === 'user' && v.name === trimmed)
    if (existing && !window.confirm(`Replace the existing view "${trimmed}"?`)) return
    const result = await saveUserView(trimmed)
    if (!result.ok) {
      setError(result.error ?? 'Save failed')
      return
    }
    setError(null)
    setName('')
  }

  return (
    <div style={{ padding: '4px 12px 12px', fontFamily: 'system-ui, sans-serif', fontSize: 11 }}>
      <div style={{ fontWeight: 600, color: colors.textSecondary, marginBottom: 6 }}>Saved views</div>
      {views.map((view) => (
        <div key={`${view.source}:${view.name}`} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0' }}>
          <button
            onClick={() => loadView(view)}
            style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: colors.textPrimary, cursor: 'pointer', padding: 0 }}
          >
            {view.name}
          </button>
          <span style={{ color: colors.textTertiary, fontSize: 10 }}>{view.source}</span>
          {view.source === 'user' ? (
            <button onClick={() => void deleteUserView(view.name)} style={{ background: 'none', border: 'none', color: colors.textTertiary, cursor: 'pointer' }}>
              Delete
            </button>
          ) : (
            <Tooltip text="Ships with the corpus">
              <span style={{ color: colors.textTertiary, fontSize: 10 }}>read-only</span>
            </Tooltip>
          )}
        </div>
      ))}
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="View name"
          style={{ flex: 1, fontSize: 11, background: colors.surfaceSecondary, color: colors.textPrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '3px 6px' }}
        />
        <button
          onClick={() => void handleSave()}
          disabled={!name.trim()}
          style={{ fontSize: 11, background: colors.surfaceSecondary, color: colors.textSecondary, border: `1px solid ${colors.containerBorder}`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer' }}
        >
          Save current
        </button>
      </div>
      {error && <div style={{ color: colors.statusError, marginTop: 4 }}>{error}</div>}
    </div>
  )
}
