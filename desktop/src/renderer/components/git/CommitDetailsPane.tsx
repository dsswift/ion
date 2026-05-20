import React from 'react'
import { useColors } from '../../theme'
import type { GitCommit, GitCommitFile, GitCommitDetail } from '../../../shared/types'

const STATUS_COLORS: Record<string, string> = {
  added: '#7aac8c',
  modified: '#6b9bd2',
  deleted: '#c47060',
  renamed: '#b08fd8',
}

const STATUS_LETTERS: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
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
          {detail.insertions > 0 && <span style={{ color: '#7aac8c' }}>+{detail.insertions}</span>}
          {detail.deletions > 0 && <span style={{ color: '#c47060' }}>−{detail.deletions}</span>}
        </div>
      )}

      {/* File list */}
      {files.length > 0 && (
        <div className="mt-1.5" style={{ maxHeight: 120, overflowY: 'auto' }}>
          {files.map((file) => (
            <div
              key={file.path}
              className="flex items-center cursor-pointer group"
              style={{ height: 20, paddingRight: 4 }}
              onClick={() => onFileClick(file)}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = colors.surfaceHover }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >
              <span
                className="text-[9px] font-mono flex-shrink-0"
                style={{ color: STATUS_COLORS[file.status] || colors.textTertiary, width: 14, textAlign: 'center' }}
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
          ))}
        </div>
      )}
    </div>
  )
}
