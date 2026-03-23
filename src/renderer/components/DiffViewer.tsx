import React, { useMemo } from 'react'
import { FloatingPanel } from './FloatingPanel'
import { useColors } from '../theme'

interface DiffViewerProps {
  diff: string
  fileName: string
  onClose: () => void
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk'
  content: string
  oldLine: number | null
  newLine: number | null
}

function parseDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHeader = true

  for (const line of lines) {
    // Skip diff headers
    if (inHeader) {
      if (line.startsWith('diff --git') || line.startsWith('index ') ||
          line.startsWith('--- ') || line.startsWith('+++ ') ||
          line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('old mode') || line.startsWith('new mode') ||
          line.startsWith('similarity') || line.startsWith('rename') ||
          line.startsWith('Binary')) {
        continue
      }
      inHeader = false
    }

    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      result.push({ type: 'hunk', content: line, oldLine: null, newLine: null })
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.substring(1), oldLine: null, newLine: newLine++ })
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', content: line.substring(1), oldLine: oldLine++, newLine: null })
    } else {
      // Context line (may start with space)
      const content = line.startsWith(' ') ? line.substring(1) : line
      if (line.trim() === '' && result.length === 0) continue
      result.push({ type: 'context', content, oldLine: oldLine++, newLine: newLine++ })
    }
  }

  return result
}

export function DiffViewer({ diff, fileName, onClose }: DiffViewerProps) {
  const colors = useColors()
  const diffLines = useMemo(() => parseDiff(diff), [diff])

  return (
    <FloatingPanel title={fileName} onClose={onClose} defaultWidth={680} defaultHeight={420}>
      <div
        style={{
          overflowY: 'auto',
          overflowX: 'auto',
          flex: 1,
        }}
      >
        {diffLines.length === 0 ? (
          <div className="p-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
            No changes
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'monospace', fontSize: 11 }}>
            <tbody>
              {diffLines.map((line, i) => {
                if (line.type === 'hunk') {
                  return (
                    <tr key={i}>
                      <td
                        colSpan={3}
                        style={{
                          padding: '4px 8px',
                          color: colors.textTertiary,
                          fontSize: 10,
                          background: colors.surfacePrimary,
                          borderTop: i > 0 ? `1px solid ${colors.containerBorder}` : undefined,
                          borderBottom: `1px solid ${colors.containerBorder}`,
                        }}
                      >
                        {line.content}
                      </td>
                    </tr>
                  )
                }

                const bgColor = line.type === 'add'
                  ? colors.diffAddBg
                  : line.type === 'remove'
                  ? colors.diffRemoveBg
                  : 'transparent'

                const textColor = line.type === 'add'
                  ? colors.diffAddText
                  : line.type === 'remove'
                  ? colors.diffRemoveText
                  : colors.textSecondary

                return (
                  <tr key={i} style={{ background: bgColor }}>
                    <td style={{ padding: '0 6px', color: colors.textMuted, textAlign: 'right', userSelect: 'none', width: 32, fontSize: 10 }}>
                      {line.oldLine ?? ''}
                    </td>
                    <td style={{ padding: '0 6px', color: colors.textMuted, textAlign: 'right', userSelect: 'none', width: 32, fontSize: 10 }}>
                      {line.newLine ?? ''}
                    </td>
                    <td style={{ padding: '1px 8px', color: textColor, whiteSpace: 'pre' }}>
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}{line.content}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </FloatingPanel>
  )
}
