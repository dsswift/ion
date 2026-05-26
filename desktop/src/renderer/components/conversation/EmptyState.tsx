import React from 'react'
import { FolderOpen } from '@phosphor-icons/react'
import { useSessionStore } from '../../stores/sessionStore'
import { useColors } from '../../theme'
import { pickDirectoryForSession } from '../../stores/remote-fs-store'
import { useShallow } from 'zustand/shallow'

/** Empty state shown when no messages exist yet — directory picker prompt. */
export function EmptyState() {
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const isTerminalOnly = useSessionStore(
    useShallow((s) => s.tabs.find((t) => t.id === s.activeTabId)?.isTerminalOnly ?? false),
  )
  const colors = useColors()

  const handleChooseFolder = async () => {
    const dir = await pickDirectoryForSession({ isTerminalOnly })
    if (dir) {
      setBaseDirectory(dir)
    }
  }

  return (
    <div
      className="flex flex-col items-center justify-center px-4 py-3 gap-1.5"
      style={{ minHeight: 80 }}
    >
      <button
        onClick={handleChooseFolder}
        className="flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-lg transition-colors"
        style={{
          color: colors.accent,
          background: colors.surfaceHover,
          border: 'none',
          cursor: 'pointer',
        }}
      >
        <FolderOpen size={13} />
        Choose folder
      </button>
      <span className="text-[11px]" style={{ color: colors.textTertiary }}>
        Press <strong style={{ color: colors.textSecondary }}>⌥ + Space</strong> to show/hide this overlay
      </span>
    </div>
  )
}
