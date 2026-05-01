import React from 'react'
import { GitBranch } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useGitPollingStore } from '../hooks/useGitPolling'

/* ─── Git Branch Button (right side of StatusBar) ─── */

export function GitButton() {
  const gitPanelOpen = useSessionStore((s) => s.gitPanelOpen)
  const toggleGitPanel = useSessionStore((s) => s.toggleGitPanel)
  const colors = useColors()

  const gitBranch = useGitPollingStore((s) => s.branch)
  const gitFileCount = useGitPollingStore((s) => s.files.length)
  const gitAhead = useGitPollingStore((s) => s.ahead)
  const gitBehind = useGitPollingStore((s) => s.behind)

  return (
    <button
      onClick={toggleGitPanel}
      className="flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors"
      style={{ color: gitPanelOpen ? colors.accent : colors.textTertiary, cursor: 'pointer' }}
      title={gitPanelOpen ? 'Close git panel' : 'Open git panel'}
    >
      <GitBranch size={11} className="flex-shrink-0" />
      {gitBranch && (
        <span style={{ fontSize: 10, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {gitBranch}
        </span>
      )}
      {gitFileCount > 0 && (
        <span style={{ fontSize: 9, color: colors.textMuted, marginLeft: -2 }}>
          *{gitFileCount}
        </span>
      )}
      {(gitAhead > 0 || gitBehind > 0) && (
        <span style={{ fontSize: 9, color: colors.textMuted, marginLeft: -2 }}>
          {gitAhead > 0 && `↑${gitAhead}`}{gitAhead > 0 && gitBehind > 0 && ' '}{gitBehind > 0 && `↓${gitBehind}`}
        </span>
      )}
    </button>
  )
}
