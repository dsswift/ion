/**
 * Unified-view diff table with optional word-diff highlight.
 */

import React from 'react'
import { Plus, Minus, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { wordDiff } from './wordDiff'
import type { ParsedDiff, DiffLine } from './diffParse'

interface DiffTableProps {
  parsed: ParsedDiff
  selected: Set<number>
  staged: boolean
  onLineClick: (line: DiffLine, ev: React.MouseEvent) => void
  onHunkAction: (hunkIdx: number) => void
  onHunkDiscard: (hunkIdx: number) => void
}

export function DiffTable({ parsed, selected, staged, onLineClick, onHunkAction, onHunkDiscard }: DiffTableProps) {
  const colors = useColors()

  // Pair adjacent +/- lines within a hunk for word-diff highlight
  const pairs = new Map<number, { add?: DiffLine; remove?: DiffLine }>()
  for (let i = 0; i < parsed.lines.length; i++) {
    const line = parsed.lines[i]
    if (line.type !== 'remove') continue
    const next = parsed.lines[i + 1]
    if (next && next.type === 'add' && next.hunkIndex === line.hunkIndex) {
      pairs.set(line.rawIndex, { remove: line, add: next })
      pairs.set(next.rawIndex, { remove: line, add: next })
    }
  }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }}>
      <tbody>
        {parsed.lines.map((line) => {
          if (line.type === 'hunk') {
            return (
              <tr key={line.rawIndex}>
                <td colSpan={4} style={{ padding: '3px 8px', color: colors.textTertiary, fontSize: 10, background: colors.surfacePrimary, borderTop: line.rawIndex > 0 ? `1px solid ${colors.containerBorder}` : undefined, borderBottom: `1px solid ${colors.containerBorder}` }}>
                  <div className="flex items-center justify-between">
                    <span>{line.content}</span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => onHunkAction(line.hunkIndex)}
                        className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px]"
                        style={{ color: staged ? colors.textTertiary : colors.accent }}
                        title={staged ? 'Unstage hunk' : 'Stage hunk'}
                      >
                        {staged ? <Minus size={9} /> : <Plus size={9} />}
                        {staged ? 'Unstage' : 'Stage'}{selected.size > 0 ? ' selected' : ' hunk'}
                      </button>
                      {!staged && (
                        <button onClick={() => onHunkDiscard(line.hunkIndex)} className="flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px]" style={{ color: '#c47060' }} title="Discard hunk">
                          <ArrowCounterClockwise size={9} />Discard
                        </button>
                      )}
                    </div>
                  </div>
                </td>
              </tr>
            )
          }

          const isSel = selected.has(line.rawIndex)
          const bgColor = isSel
            ? colors.accent + '22'
            : line.type === 'add' ? colors.diffAddBg
            : line.type === 'remove' ? colors.diffRemoveBg
            : 'transparent'
          const textColor = line.type === 'add' ? colors.diffAddText
            : line.type === 'remove' ? colors.diffRemoveText
            : colors.textSecondary

          let body: React.ReactNode = line.content
          const pair = pairs.get(line.rawIndex)
          if (pair && pair.add && pair.remove && (line.type === 'add' || line.type === 'remove')) {
            const tokens = wordDiff(pair.remove.content, pair.add.content)
            const side = line.type === 'add' ? tokens.new : tokens.old
            body = (
              <>
                {side.map((tok, ti) => (
                  <span
                    key={ti}
                    style={{
                      background: tok.type === 'add' ? '#7aac8c44'
                        : tok.type === 'remove' ? '#c4706044'
                        : undefined,
                    }}
                  >{tok.text}</span>
                ))}
              </>
            )
          }

          return (
            <tr key={line.rawIndex} style={{ background: bgColor, cursor: (line.type === 'add' || line.type === 'remove') ? 'pointer' : 'default' }} onClick={(e) => onLineClick(line, e)}>
              <td style={{ padding: '0 4px', color: colors.textMuted, textAlign: 'right', userSelect: 'none', width: 28, fontSize: 10 }}>{line.oldLine ?? ''}</td>
              <td style={{ padding: '0 4px', color: colors.textMuted, textAlign: 'right', userSelect: 'none', width: 28, fontSize: 10 }}>{line.newLine ?? ''}</td>
              <td style={{ padding: '0 2px', color: colors.textMuted, userSelect: 'none', width: 12, textAlign: 'center', fontSize: 10 }}>
                {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}
              </td>
              <td style={{ padding: '1px 6px', color: textColor, whiteSpace: 'pre', tabSize: 4 }}>{body}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
