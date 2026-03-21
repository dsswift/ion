import React, { useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { X } from '@phosphor-icons/react'
import { usePopoverLayer } from './PopoverLayer'
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
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose()
  }, [onClose])

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  const diffLines = useMemo(() => parseDiff(diff), [diff])

  if (!popoverLayer) return null

  const content = (
    <motion.div
      data-clui-ui
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.15 }}
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        pointerEvents: 'auto',
        zIndex: 10000,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      {/* Backdrop */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: 'rgba(0, 0, 0, 0.4)',
          backdropFilter: 'blur(4px)',
        }}
      />

      {/* Diff panel */}
      <div
        data-clui-ui
        className="glass-surface rounded-xl"
        style={{
          position: 'relative',
          width: '90%',
          maxWidth: 680,
          maxHeight: 500,
          display: 'flex',
          flexDirection: 'column',
          background: colors.containerBg,
          border: `1px solid ${colors.containerBorder}`,
          boxShadow: '0 16px 48px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-3 py-2"
          style={{
            borderBottom: `1px solid ${colors.containerBorder}`,
            background: colors.surfacePrimary,
          }}
        >
          <span
            className="text-[11px] truncate"
            style={{ color: colors.textSecondary, fontFamily: 'monospace' }}
          >
            {fileName}
          </span>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-0.5 rounded transition-colors"
            style={{ color: colors.textTertiary }}
          >
            <X size={12} />
          </button>
        </div>

        {/* Diff body */}
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
                    ? 'rgba(122, 172, 140, 0.12)'
                    : line.type === 'remove'
                    ? 'rgba(196, 112, 96, 0.1)'
                    : 'transparent'

                  const textColor = line.type === 'add'
                    ? '#7aac8c'
                    : line.type === 'remove'
                    ? '#c47060'
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
      </div>
    </motion.div>
  )

  return createPortal(content, popoverLayer)
}
