import React, { useState, useMemo } from 'react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { InlineEditDiff } from '../InlineEditDiff'
import type { Message } from '../../../shared/types'

export function ToolRow({ tool, desc, isRunning }: { tool: Message; desc: string; isRunning: boolean }) {
  const colors = useColors()
  const expandToolResults = usePreferencesStore((s) => s.expandToolResults)
  const shouldAutoExpand = !!tool.autoExpandResult ||
    (expandToolResults && ['Edit', 'Write'].includes(tool.toolName || ''))
  const [showResult, setShowResult] = useState(!!tool.userExecuted || shouldAutoExpand)

  const editDiff = useMemo(() => {
    if (tool.toolName !== 'Edit' || !tool.toolInput) return null
    try {
      const input = JSON.parse(tool.toolInput)
      if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
        return { oldString: input.old_string, newString: input.new_string }
      }
    } catch { /* fallback */ }
    return null
  }, [tool.toolName, tool.toolInput])

  const hasContent = !!tool.content || !!editDiff
  const lineCount = editDiff
    ? (editDiff.oldString ? editDiff.oldString.split('\n').length : 0) +
      (editDiff.newString ? editDiff.newString.split('\n').length : 0)
    : tool.content ? tool.content.split('\n').length : 0

  return (
    <>
      <span className="inline-flex items-center gap-1.5">
        <span
          className="text-[12px] leading-[1.4] truncate"
          style={{ color: isRunning ? colors.textSecondary : colors.textTertiary }}
        >
          {desc}
        </span>
        {!isRunning && hasContent && (
          <span
            className="text-[10px] cursor-pointer select-none flex-shrink-0"
            style={{ color: colors.textMuted }}
            onClick={() => setShowResult(!showResult)}
          >
            +{lineCount} line{lineCount !== 1 ? 's' : ''}
          </span>
        )}
        {isRunning && (
          <span className="text-[10px]" style={{ color: colors.textMuted }}>
            running...
          </span>
        )}
      </span>
      {!isRunning && showResult && editDiff && (
        <InlineEditDiff oldString={editDiff.oldString} newString={editDiff.newString} />
      )}
      {!isRunning && showResult && !editDiff && tool.content && (
        <pre
          className="text-[11px] leading-[1.4] p-2 rounded overflow-auto whitespace-pre-wrap break-words"
          style={{
            margin: '4px 0 0 0',
            background: colors.surfaceHover,
            color: colors.textSecondary,
            maxHeight: shouldAutoExpand ? undefined : 200,
            border: `1px solid ${colors.toolBorder}`,
          }}
        >
          {tool.content}
        </pre>
      )}
    </>
  )
}
