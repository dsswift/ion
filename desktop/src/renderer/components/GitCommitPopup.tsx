import React from 'react'
import { motion } from 'framer-motion'
import { GitBranch } from '@phosphor-icons/react'
import { useColors } from '../theme'
import type { GitCommit, GitCommitDetail } from '../../shared/types'
import { relativeDate } from './GitPanelTypes'

// ─── Commit detail popup ───

export function CommitPopup({ commit, rect, detail, panelRight }: {
  commit: GitCommit
  rect: DOMRect
  detail: GitCommitDetail | null
  panelRight: number
}) {
  const colors = useColors()
  const POPUP_WIDTH = 300
  const GAP = 8

  // Position to the right of the panel edge, fall back to left
  const spaceRight = window.innerWidth - panelRight - GAP - POPUP_WIDTH
  const left = spaceRight >= 0 ? panelRight + GAP : rect.left - GAP - POPUP_WIDTH
  // Vertically center on the row, clamp to viewport
  const top = Math.max(8, Math.min(rect.top - 40, window.innerHeight - 200))

  const absDate = new Date(commit.authorDate)
  const dateStr = absDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const timeStr = absDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  return (
    <motion.div
      data-ion-ui
      initial={{ opacity: 0, x: spaceRight >= 0 ? -4 : 4 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left,
        top,
        width: POPUP_WIDTH,
        pointerEvents: 'none',
        background: colors.popoverBg,
        backdropFilter: 'blur(20px)',
        WebkitBackdropFilter: 'blur(20px)',
        boxShadow: colors.popoverShadow,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 10,
        padding: '10px 12px',
        zIndex: 9999,
      }}
    >
      {/* Author + date */}
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: colors.textSecondary }}>
        <span style={{ fontWeight: 500 }}>{commit.authorName},</span>
        <span>{relativeDate(commit.authorDate)}</span>
        <span style={{ color: colors.textTertiary }}>({dateStr} at {timeStr})</span>
      </div>

      {/* Subject */}
      <div className="text-[11px] mt-1.5" style={{ color: colors.textPrimary, whiteSpace: 'pre-wrap' }}>
        {commit.subject}
      </div>

      {/* Diff stats */}
      {detail && (detail.filesChanged > 0 || detail.insertions > 0 || detail.deletions > 0) && (
        <div className="text-[10px] mt-2" style={{ color: colors.textSecondary }}>
          {detail.filesChanged} {detail.filesChanged === 1 ? 'file' : 'files'} changed
          {detail.insertions > 0 && (
            <span>, <span style={{ color: '#7aac8c' }}>{detail.insertions} {detail.insertions === 1 ? 'insertion' : 'insertions'}(+)</span></span>
          )}
          {detail.deletions > 0 && (
            <span>, <span style={{ color: '#c47060' }}>{detail.deletions} {detail.deletions === 1 ? 'deletion' : 'deletions'}(-)</span></span>
          )}
        </div>
      )}

      {/* Ref badges */}
      {commit.refs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {commit.refs.map((ref, i) => (
            <span
              key={i}
              className="text-[9px] px-1.5 py-0.5 rounded-sm flex items-center gap-0.5"
              style={{
                border: `1px solid ${ref.isCurrent ? colors.accent : colors.containerBorder}`,
                background: ref.isCurrent ? colors.accentLight : 'transparent',
                color: ref.isCurrent ? colors.accent : colors.textTertiary,
              }}
            >
              <GitBranch size={9} />
              {ref.name}
            </span>
          ))}
        </div>
      )}

      {/* Hash */}
      <div className="text-[10px] mt-2" style={{ color: colors.accent, fontFamily: 'monospace' }}>
        {commit.hash}
      </div>
    </motion.div>
  )
}
