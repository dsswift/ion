import React from 'react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { GIT_STATUS_COLOR_KEYS } from '../../stores/git/types'
import type { GitCommit, GitCommitFile, GitCommitDetail } from '../../../shared/types'

const STATUS_LETTERS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
}

/** Single file row in the commit details pane — standard hover/pressed states. */
function DetailFileRow({ file, onFileClick }: {
  file: GitCommitFile
  onFileClick: (file: GitCommitFile) => void
}) {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <div
      className="flex items-center cursor-pointer group"
      {...handlers}
      style={{
        height: 20,
        paddingRight: 4,
        background: interactiveBg(colors, { hover, pressed }),
        transition: `background ${transitions.base}`,
      }}
      onClick={() => onFileClick(file)}
    >
      <span
        className="text-[9px] font-mono flex-shrink-0"
        style={{ color: GIT_STATUS_COLOR_KEYS[file.status] ? colors[GIT_STATUS_COLOR_KEYS[file.status]] : colors.textTertiary, width: 14, textAlign: 'center' }}
      >
        {STATUS_LETTERS[file.status] || '?'}
      </span>
      <span
        className="text-[10px] truncate flex-1"
        style={{ color: colors.textSecondary, marginLeft: 4 }}
        title={file.path}
      >
        {file.path}
      </span>
    </div>
  )
}

interface CommitDetailsPaneProps {
  commit: GitCommit
  detail: GitCommitDetail | null
  files: GitCommitFile[]
  onFileClick: (file: GitCommitFile) => void
}

export function CommitDetailsPane({ commit, detail, files, onFileClick }: CommitDetailsPaneProps) {
  const colors = useColors()

  return (
    <div
      style={{
        background: colors.surfacePrimary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        padding: '6px 8px',
      }}
    >
      {/* Hash + author */}
      <div className="flex items-center gap-2 text-[10px]" style={{ color: colors.textTertiary }}>
        <span style={{ fontFamily: 'var(--font-mono, monospace)', userSelect: 'text' }}>
          {commit.hash}
        </span>
        <span>{commit.authorName}</span>
        <span>{new Date(commit.authorDate).toLocaleDateString()}</span>
      </div>

      {/* Full message */}
      <div
        className="text-[10px] mt-1"
        style={{
          color: colors.textSecondary,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          maxHeight: 60,
          overflow: 'auto',
        }}
      >
        {commit.subject}
      </div>

      {/* Stats */}
      {detail && (
        <div className="flex items-center gap-2 mt-1 text-[9px]" style={{ color: colors.textTertiary }}>
          <span>{detail.filesChanged} file{detail.filesChanged !== 1 ? 's' : ''}</span>
          {detail.insertions > 0 && <span style={{ color: colors.successFg }}>+{detail.insertions}</span>}
          {detail.deletions > 0 && <span style={{ color: colors.dangerFg }}>−{detail.deletions}</span>}
        </div>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="mt-1.5" style={{ maxHeight: 120, overflowY: 'auto' }}>
          {files.map((file) => (
            <DetailFileRow key={file.path} file={file} onFileClick={onFileClick} />
          ))}
        </div>
      )}
    </div>
  )
}
