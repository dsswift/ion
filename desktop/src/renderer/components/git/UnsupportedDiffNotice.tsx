import React from 'react'
import { Warning } from '@phosphor-icons/react'
import { useColors } from '../../theme'

/** Safe fallback for changed files Git identifies as non-text. */
export function UnsupportedDiffNotice(): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      className="flex flex-col items-center justify-center gap-1.5 text-center"
      style={{ minHeight: 104, padding: 16, color: colors.textTertiary, fontFamily: 'system-ui, sans-serif' }}
    >
      <Warning size={20} weight="duotone" style={{ color: colors.textMuted }} />
      <span style={{ fontSize: 12, color: colors.textSecondary }}>Binary file changed</span>
      <span style={{ fontSize: 11 }}>This file type is not supported in Diff Viewer.</span>
    </div>
  )
}
