import React, { useState, useCallback, useRef } from 'react'
import { useColors } from '../../theme'
import { FloatingPanel } from '../FloatingPanel'
import { DotsSixVertical } from '@phosphor-icons/react'

type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop'
const ACTIONS: RebaseAction[] = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop']

const ACTION_COLORS: Record<RebaseAction, string> = {
  pick: '#7aac8c',
  reword: '#6b9bd2',
  edit: '#d4a843',
  squash: '#b08fd8',
  fixup: '#8bb5e0',
  drop: '#c47060',
}

export interface RebaseCommit {
  hash: string
  subject: string
  action: RebaseAction
}

interface RebaseEditorProps {
  directory: string
  onto: string
  initialCommits: RebaseCommit[]
  onClose: () => void
  onComplete: () => void
}

export function RebaseEditor({ directory, onto, initialCommits, onClose, onComplete }: RebaseEditorProps) {
  const colors = useColors()
  const [commits, setCommits] = useState<RebaseCommit[]>(initialCommits)
  const [error, setError] = useState<string | null>(null)
  const [executing, setExecuting] = useState(false)
  const dragItem = useRef<number | null>(null)
  const dragOverItem = useRef<number | null>(null)

  const handleActionChange = useCallback((index: number, action: RebaseAction) => {
    setCommits(prev => prev.map((c, i) => i === index ? { ...c, action } : c))
  }, [])

  const handleDragStart = useCallback((index: number) => {
    dragItem.current = index
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    dragOverItem.current = index
  }, [])

  const handleDrop = useCallback(() => {
    if (dragItem.current === null || dragOverItem.current === null) return
    const from = dragItem.current
    const to = dragOverItem.current
    if (from === to) return
    setCommits(prev => {
      const newList = [...prev]
      const [removed] = newList.splice(from, 1)
      newList.splice(to, 0, removed)
      return newList
    })
    dragItem.current = null
    dragOverItem.current = null
  }, [])

  const handleExecute = useCallback(async () => {
    setExecuting(true)
    setError(null)
    const result = await window.ion.gitRebaseExec(
      directory, onto,
      commits.map(c => ({ hash: c.hash, action: c.action })),
    )
    setExecuting(false)
    if (result.ok) {
      onComplete()
    } else {
      setError(result.error || 'Rebase failed')
    }
  }, [directory, onto, commits, onComplete])

  const handleAbort = useCallback(async () => {
    await window.ion.gitRebaseAbort(directory)
    onClose()
  }, [directory, onClose])

  const activeCount = commits.filter(c => c.action !== 'drop').length

  return (
    <FloatingPanel title={`Interactive Rebase onto ${onto.slice(0, 7)}`} onClose={onClose} defaultWidth={520} defaultHeight={400}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Toolbar */}
        <div
          className="flex items-center gap-2 px-3 py-1.5"
          style={{ borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}
        >
          <span className="text-[10px]" style={{ color: colors.textTertiary }}>
            {activeCount} commit{activeCount !== 1 ? 's' : ''} to rebase
          </span>
          <div style={{ flex: 1 }} />
          {error && (
            <button
              onClick={handleAbort}
              className="text-[9px] px-2 py-0.5 rounded"
              style={{ color: '#c47060', border: '1px solid #c47060' }}
            >
              Abort Rebase
            </button>
          )}
          <button
            onClick={handleExecute}
            disabled={executing || activeCount === 0}
            className="text-[9px] px-2 py-0.5 rounded font-medium"
            style={{
              color: activeCount > 0 ? '#fff' : colors.textMuted,
              background: activeCount > 0 ? colors.accent : 'transparent',
              cursor: activeCount > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            {executing ? 'Rebasing...' : 'Start Rebase'}
          </button>
        </div>

        {error && (
          <div className="px-3 py-1 text-[10px]" style={{ color: '#c47060', flexShrink: 0 }}>
            {error}
          </div>
        )}

        {/* Commit list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {commits.map((commit, i) => (
            <div
              key={commit.hash}
              draggable
              onDragStart={() => handleDragStart(i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={handleDrop}
              className="flex items-center gap-1.5 px-2 group"
              style={{
                height: 28,
                borderBottom: `1px solid ${colors.containerBorder}`,
                opacity: commit.action === 'drop' ? 0.4 : 1,
                cursor: 'grab',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <DotsSixVertical
                size={10}
                style={{ color: colors.textMuted, flexShrink: 0, cursor: 'grab' }}
              />

              {/* Action dropdown */}
              <select
                value={commit.action}
                onChange={(e) => handleActionChange(i, e.target.value as RebaseAction)}
                className="text-[9px] rounded px-1 py-0.5 bg-transparent outline-none cursor-pointer"
                style={{
                  color: ACTION_COLORS[commit.action],
                  border: `1px solid ${colors.containerBorder}`,
                  minWidth: 55,
                }}
                onClick={(e) => e.stopPropagation()}
              >
                {ACTIONS.map(a => (
                  <option key={a} value={a} style={{ color: ACTION_COLORS[a] }}>
                    {a}
                  </option>
                ))}
              </select>

              {/* Hash */}
              <span
                className="text-[9px] font-mono flex-shrink-0"
                style={{ color: colors.textMuted, width: 52 }}
              >
                {commit.hash.slice(0, 7)}
              </span>

              {/* Subject */}
              <span
                className="text-[10px] truncate flex-1"
                style={{
                  color: colors.textSecondary,
                  textDecoration: commit.action === 'drop' ? 'line-through' : 'none',
                }}
              >
                {commit.subject}
              </span>
            </div>
          ))}
        </div>

        {/* Help text */}
        <div
          className="px-3 py-1.5 text-[9px]"
          style={{
            color: colors.textMuted,
            borderTop: `1px solid ${colors.containerBorder}`,
            flexShrink: 0,
          }}
        >
          Drag to reorder • Actions: pick, reword, edit, squash, fixup, drop
        </div>
      </div>
    </FloatingPanel>
  )
}
