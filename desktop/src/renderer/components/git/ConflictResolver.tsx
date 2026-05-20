import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useColors } from '../../theme'
import { FloatingPanel } from '../FloatingPanel'

interface ConflictBlock {
  type: 'context' | 'conflict'
  lines?: string[]
  ours?: string[]
  theirs?: string[]
}

function parseConflicts(content: string): ConflictBlock[] {
  const lines = content.split('\n')
  const blocks: ConflictBlock[] = []
  let current: string[] = []
  let inConflict = false
  let ours: string[] = []
  let theirs: string[] = []
  let inOurs = false

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      if (current.length > 0) {
        blocks.push({ type: 'context', lines: [...current] })
        current = []
      }
      inConflict = true
      inOurs = true
      ours = []
      theirs = []
    } else if (line.startsWith('=======') && inConflict) {
      inOurs = false
    } else if (line.startsWith('>>>>>>>') && inConflict) {
      blocks.push({ type: 'conflict', ours: [...ours], theirs: [...theirs] })
      inConflict = false
      inOurs = false
    } else if (inConflict) {
      if (inOurs) ours.push(line)
      else theirs.push(line)
    } else {
      current.push(line)
    }
  }
  if (current.length > 0) blocks.push({ type: 'context', lines: current })
  return blocks
}

function resolveBlocks(blocks: ConflictBlock[], resolutions: Record<number, 'ours' | 'theirs' | 'both'>): string {
  const result: string[] = []
  let conflictIdx = 0
  for (const block of blocks) {
    if (block.type === 'context') {
      result.push(...(block.lines || []))
    } else {
      const res = resolutions[conflictIdx] || 'both'
      if (res === 'ours') result.push(...(block.ours || []))
      else if (res === 'theirs') result.push(...(block.theirs || []))
      else { result.push(...(block.ours || []), ...(block.theirs || [])) }
      conflictIdx++
    }
  }
  return result.join('\n')
}

interface ConflictResolverProps {
  directory: string
  files: string[]
  onClose: () => void
  onResolved: () => void
}

export function ConflictResolver({ directory, files, onClose, onResolved }: ConflictResolverProps) {
  const colors = useColors()
  const [currentFile, setCurrentFile] = useState(files[0] || '')
  const [content, setContent] = useState('')
  const [resolutions, setResolutions] = useState<Record<number, 'ours' | 'theirs' | 'both'>>({})
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const loadFile = useCallback(async (path: string) => {
    const result = await window.ion.gitConflictFile(directory, path)
    if (result.ok) {
      setContent(result.content)
      setResolutions({})
    } else {
      setError(result.error || 'Failed to load file')
    }
  }, [directory])

  useEffect(() => {
    if (currentFile) loadFile(currentFile)
  }, [currentFile, loadFile])

  const blocks = useMemo(() => parseConflicts(content), [content])
  const conflictCount = blocks.filter(b => b.type === 'conflict').length
  const resolvedCount = Object.keys(resolutions).length
  const allResolved = resolvedCount >= conflictCount && conflictCount > 0

  const handleResolve = useCallback((idx: number, resolution: 'ours' | 'theirs' | 'both') => {
    setResolutions(prev => ({ ...prev, [idx]: resolution }))
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const resolved = resolveBlocks(blocks, resolutions)
    const result = await window.ion.gitResolveConflict(directory, currentFile, resolved)
    setSaving(false)
    if (result.ok) {
      const remaining = files.filter(f => f !== currentFile)
      if (remaining.length > 0) {
        setCurrentFile(remaining[0])
      } else {
        onResolved()
      }
    } else {
      setError(result.error || 'Failed to resolve')
    }
  }, [blocks, resolutions, directory, currentFile, files, onResolved])

  const handleAcceptAllCurrent = useCallback(() => {
    const all: Record<number, 'ours'> = {}
    let idx = 0
    for (const block of blocks) {
      if (block.type === 'conflict') { all[idx] = 'ours'; idx++ }
    }
    setResolutions(all)
  }, [blocks])

  const handleAcceptAllIncoming = useCallback(() => {
    const all: Record<number, 'theirs'> = {}
    let idx = 0
    for (const block of blocks) {
      if (block.type === 'conflict') { all[idx] = 'theirs'; idx++ }
    }
    setResolutions(all)
  }, [blocks])

  let conflictIdx = 0

  return (
    <FloatingPanel title={`Resolve Conflicts — ${currentFile.split('/').pop()}`} onClose={onClose} defaultWidth={720} defaultHeight={500}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* File selector */}
        {files.length > 1 && (
          <div className="flex items-center gap-1 px-3 py-1" style={{ borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}>
            {files.map(f => (
              <button key={f} onClick={() => setCurrentFile(f)}
                className="text-[10px] px-2 py-0.5 rounded"
                style={{ color: f === currentFile ? colors.accent : colors.textTertiary,
                  background: f === currentFile ? colors.accentLight : 'transparent' }}>
                {f.split('/').pop()}
              </button>
            ))}
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3 py-1" style={{ borderBottom: `1px solid ${colors.containerBorder}`, flexShrink: 0 }}>
          <span className="text-[10px]" style={{ color: colors.textTertiary }}>
            {conflictCount} conflict{conflictCount !== 1 ? 's' : ''}, {resolvedCount} resolved
          </span>
          <div style={{ flex: 1 }} />
          <button onClick={handleAcceptAllCurrent} className="text-[9px] px-2 py-0.5 rounded"
            style={{ color: colors.textSecondary, border: `1px solid ${colors.containerBorder}` }}>
            Accept All Current
          </button>
          <button onClick={handleAcceptAllIncoming} className="text-[9px] px-2 py-0.5 rounded"
            style={{ color: colors.textSecondary, border: `1px solid ${colors.containerBorder}` }}>
            Accept All Incoming
          </button>
          <button onClick={handleSave} disabled={!allResolved || saving}
            className="text-[9px] px-2 py-0.5 rounded font-medium"
            style={{ color: allResolved ? '#fff' : colors.textMuted,
              background: allResolved ? colors.accent : 'transparent',
              border: allResolved ? 'none' : `1px solid ${colors.containerBorder}`,
              cursor: allResolved ? 'pointer' : 'not-allowed' }}>
            {saving ? 'Saving...' : 'Save & Mark Resolved'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div className="px-3 py-1 text-[10px]" style={{ color: '#c47060', flexShrink: 0 }}>{error}</div>
        )}

        {/* Content */}
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', fontSize: 11 }}>
          {blocks.map((block, i) => {
            if (block.type === 'context') {
              return (
                <div key={i} style={{ padding: '0 12px' }}>
                  {block.lines?.map((line, j) => (
                    <div key={j} style={{ color: colors.textSecondary, whiteSpace: 'pre', minHeight: 18 }}>{line}</div>
                  ))}
                </div>
              )
            }

            const ci = conflictIdx++
            const resolution = resolutions[ci]

            return (
              <div key={i} style={{ border: `1px solid ${colors.containerBorder}`, margin: '4px 8px', borderRadius: 4, overflow: 'hidden' }}>
                {/* Conflict header with action buttons */}
                <div className="flex items-center gap-1 px-2 py-1" style={{ background: colors.surfacePrimary, borderBottom: `1px solid ${colors.containerBorder}` }}>
                  <span className="text-[9px] font-medium" style={{ color: colors.textTertiary }}>
                    Conflict {ci + 1}
                  </span>
                  <div style={{ flex: 1 }} />
                  <button onClick={() => handleResolve(ci, 'ours')}
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ color: resolution === 'ours' ? '#fff' : '#6b9bd2',
                      background: resolution === 'ours' ? '#6b9bd2' : 'transparent' }}>
                    Current
                  </button>
                  <button onClick={() => handleResolve(ci, 'theirs')}
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ color: resolution === 'theirs' ? '#fff' : '#7aac8c',
                      background: resolution === 'theirs' ? '#7aac8c' : 'transparent' }}>
                    Incoming
                  </button>
                  <button onClick={() => handleResolve(ci, 'both')}
                    className="text-[9px] px-1.5 py-0.5 rounded"
                    style={{ color: resolution === 'both' ? '#fff' : '#b08fd8',
                      background: resolution === 'both' ? '#b08fd8' : 'transparent' }}>
                    Both
                  </button>
                </div>

                {/* Two-column view */}
                <div style={{ display: 'flex' }}>
                  {/* Current (ours) */}
                  <div style={{ flex: 1, padding: '4px 8px',
                    background: resolution === 'ours' || resolution === 'both' ? colors.diffAddBg : 'transparent',
                    borderRight: `1px solid ${colors.containerBorder}`,
                    opacity: resolution === 'theirs' ? 0.4 : 1 }}>
                    <div className="text-[9px] mb-1" style={{ color: '#6b9bd2' }}>Current</div>
                    {block.ours?.map((line, j) => (
                      <div key={j} style={{ color: colors.textSecondary, whiteSpace: 'pre', minHeight: 16, fontSize: 11 }}>{line}</div>
                    ))}
                    {(!block.ours || block.ours.length === 0) && (
                      <div className="text-[9px] italic" style={{ color: colors.textMuted }}>empty</div>
                    )}
                  </div>
                  {/* Incoming (theirs) */}
                  <div style={{ flex: 1, padding: '4px 8px',
                    background: resolution === 'theirs' || resolution === 'both' ? colors.diffAddBg : 'transparent',
                    opacity: resolution === 'ours' ? 0.4 : 1 }}>
                    <div className="text-[9px] mb-1" style={{ color: '#7aac8c' }}>Incoming</div>
                    {block.theirs?.map((line, j) => (
                      <div key={j} style={{ color: colors.textSecondary, whiteSpace: 'pre', minHeight: 16, fontSize: 11 }}>{line}</div>
                    ))}
                    {(!block.theirs || block.theirs.length === 0) && (
                      <div className="text-[9px] italic" style={{ color: colors.textMuted }}>empty</div>
                    )}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </FloatingPanel>
  )
}
