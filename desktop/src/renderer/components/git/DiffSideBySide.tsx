/**
 * Side-by-side renderer for a parsed diff.
 *
 * Pairs adjacent +/- lines for aligned display. Unpaired removes show on the
 * left only (right empty), unpaired adds show on the right only (left empty).
 * Word-diff highlight is applied to paired lines.
 */

import React from 'react'
import { useColors } from '../../theme'
import { wordDiff } from './wordDiff'
import type { ParsedDiff } from './diffParse'

type Row =
  | { kind: 'hunk'; content: string; key: number }
  | { kind: 'context'; oldNo: number | null; newNo: number | null; left: string; right: string; key: number }
  | { kind: 'mod'; oldNo: number | null; newNo: number | null; left: string; right: string; key: number }
  | { kind: 'add'; newNo: number | null; right: string; key: number }
  | { kind: 'remove'; oldNo: number | null; left: string; key: number }

function buildRows(parsed: ParsedDiff): Row[] {
  const rows: Row[] = []
  const lines = parsed.lines
  let i = 0
  let key = 0
  while (i < lines.length) {
    const l = lines[i]
    if (l.type === 'hunk') { rows.push({ kind: 'hunk', content: l.content, key: key++ }); i++; continue }
    if (l.type === 'context') {
      rows.push({ kind: 'context', oldNo: l.oldLine, newNo: l.newLine, left: l.content, right: l.content, key: key++ })
      i++; continue
    }
    if (l.type === 'remove') {
      const next = lines[i + 1]
      if (next && next.type === 'add' && next.hunkIndex === l.hunkIndex) {
        rows.push({ kind: 'mod', oldNo: l.oldLine, newNo: next.newLine, left: l.content, right: next.content, key: key++ })
        i += 2; continue
      }
      rows.push({ kind: 'remove', oldNo: l.oldLine, left: l.content, key: key++ })
      i++; continue
    }
    if (l.type === 'add') {
      rows.push({ kind: 'add', newNo: l.newLine, right: l.content, key: key++ })
      i++; continue
    }
    i++
  }
  return rows
}

function renderInline(text: string, side: 'left' | 'right', pair?: { left: string; right: string }, colors?: ReturnType<typeof useColors>): React.ReactNode {
  if (!pair) return text
  const tokens = wordDiff(pair.left, pair.right)
  const arr = side === 'left' ? tokens.old : tokens.new
  return (
    <>
      {arr.map((tok, ti) => (
        <span key={ti} style={{ background: tok.type === 'add' ? '#7aac8c44' : tok.type === 'remove' ? '#c4706044' : undefined }}>{tok.text}</span>
      ))}
    </>
  )
}

export function DiffSideBySide({ parsed }: { parsed: ParsedDiff }) {
  const colors = useColors()
  const rows = buildRows(parsed)

  const cellBase: React.CSSProperties = { padding: '1px 6px', whiteSpace: 'pre', tabSize: 4, fontFamily: 'var(--font-mono, monospace)', fontSize: 11 }
  const numCell: React.CSSProperties = { padding: '0 4px', color: colors.textMuted, textAlign: 'right', userSelect: 'none', width: 28, fontSize: 10 }
  const halfWidth: React.CSSProperties = { width: '50%', verticalAlign: 'top' }

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
      <colgroup>
        <col style={{ width: 28 }} /><col style={halfWidth} />
        <col style={{ width: 28 }} /><col style={halfWidth} />
      </colgroup>
      <tbody>
        {rows.map((row) => {
          if (row.kind === 'hunk') {
            return (
              <tr key={row.key}>
                <td colSpan={4} style={{ padding: '3px 8px', color: colors.textTertiary, fontSize: 10, background: colors.surfacePrimary, borderBottom: `1px solid ${colors.containerBorder}` }}>{row.content}</td>
              </tr>
            )
          }
          const leftBg = row.kind === 'remove' || row.kind === 'mod' ? colors.diffRemoveBg : 'transparent'
          const rightBg = row.kind === 'add' || row.kind === 'mod' ? colors.diffAddBg : 'transparent'
          const pair = row.kind === 'mod' ? { left: row.left, right: row.right } : undefined
          const leftBody = row.kind === 'add' ? '' : (row.kind === 'mod' ? renderInline(row.left, 'left', pair, colors) : 'left' in row ? row.left : '')
          const rightBody = row.kind === 'remove' ? '' : (row.kind === 'mod' ? renderInline(row.right, 'right', pair, colors) : 'right' in row ? row.right : '')
          const leftNo = 'oldNo' in row ? row.oldNo : null
          const rightNo = 'newNo' in row ? row.newNo : null

          return (
            <tr key={row.key}>
              <td style={numCell}>{leftNo ?? ''}</td>
              <td style={{ ...cellBase, background: leftBg, color: row.kind === 'remove' || row.kind === 'mod' ? colors.diffRemoveText : colors.textSecondary, borderRight: `1px solid ${colors.containerBorder}` }}>{leftBody}</td>
              <td style={numCell}>{rightNo ?? ''}</td>
              <td style={{ ...cellBase, background: rightBg, color: row.kind === 'add' || row.kind === 'mod' ? colors.diffAddText : colors.textSecondary }}>{rightBody}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
