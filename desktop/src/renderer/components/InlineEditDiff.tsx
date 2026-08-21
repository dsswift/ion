import React from 'react'
import { useColors } from '../theme'

interface InlineEditDiffProps {
  oldString: string
  newString: string
}

export function InlineEditDiff({ oldString, newString }: InlineEditDiffProps) {
  const colors = useColors()
  const oldLines = oldString ? oldString.split('\n') : []
  const newLines = newString ? newString.split('\n') : []

  return (
    <div
      className="leading-[1.5] rounded"
      style={{
        margin: '4px 0 0 0',
        fontFamily: 'var(--ion-font-mono, monospace)',
        border: `1px solid ${colors.toolBorder}`,
        fontSize: 'var(--ion-data-code-font-size, 13px)',
      }}
    >
      {oldLines.map((line, i) => (
        <div
          key={`r-${i}`}
          style={{
            background: colors.diffRemoveBg,
            color: colors.diffRemoveText,
            padding: '0 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ userSelect: 'none', opacity: 0.6, marginRight: 4 }}>-</span>
          {line}
        </div>
      ))}
      {newLines.map((line, i) => (
        <div
          key={`a-${i}`}
          style={{
            background: colors.diffAddBg,
            color: colors.diffAddText,
            padding: '0 8px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          <span style={{ userSelect: 'none', opacity: 0.6, marginRight: 4 }}>+</span>
          {line}
        </div>
      ))}
    </div>
  )
}
