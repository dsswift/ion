import React, { useState, useEffect } from 'react'
import { TreeStructure, NotePencil } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useGitPolling } from '../hooks/useGitPolling'
import { BackendIndicator } from './StatusBarBackendIndicator'
import { ModelPicker } from './StatusBarModelPicker'
import { ContextIndicator } from './StatusBarContextIndicator'
import { PermissionModePicker } from './StatusBarPermissionModePicker'
import { OpenWithPicker } from './StatusBarOpenWithPicker'
import { TallViewToggle } from './StatusBarTallViewToggle'
import { DirectoryPicker } from './StatusBarDirectoryPicker'
import { GitButton } from './StatusBarGitButton'

// Re-export sibling components for any consumer importing from StatusBar.tsx
export { BackendIndicator } from './StatusBarBackendIndicator'
export { ModelPicker } from './StatusBarModelPicker'
export { ContextIndicator } from './StatusBarContextIndicator'
export { PermissionModePicker } from './StatusBarPermissionModePicker'
export { OpenWithPicker } from './StatusBarOpenWithPicker'
export { TallViewToggle } from './StatusBarTallViewToggle'
export { DirectoryPicker } from './StatusBarDirectoryPicker'
export { GitButton } from './StatusBarGitButton'
export { compactPath } from './StatusBarShared'

/* ─── StatusBar ─── */

export function StatusBar() {
  const tab = useSessionStore(
    useShallow((s) => {
      const t = s.tabs.find((t) => t.id === s.activeTabId)
      return t
        ? {
            workingDirectory: t.workingDirectory,
          }
        : undefined
    }),
  )
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const isEngine = useSessionStore((s) => {
    const t = s.tabs.find((t) => t.id === s.activeTabId)
    return t?.isEngine || false
  })
  const engineStatusFields = useSessionStore((s) => s.engineStatusFields)
  const enginePanes = useSessionStore((s) => s.enginePanes)
  const explorerOpen = useSessionStore((s) => s.fileExplorerOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const toggleFileExplorer = useSessionStore((s) => s.toggleFileExplorer)
  const editorOpen = useSessionStore((s) => s.fileEditorOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const toggleFileEditor = useSessionStore((s) => s.toggleFileEditor)
  const colors = useColors()

  const [isGitRepo, setIsGitRepo] = useState(false)
  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)

  // Check if working directory is a git repo; close git panel if not
  useEffect(() => {
    if (!tab?.workingDirectory || tab.workingDirectory === '~') {
      setIsGitRepo(false)
      closeGitPanel()
      return
    }
    window.ion.gitIsRepo(tab.workingDirectory).then(({ isRepo }) => {
      setIsGitRepo(isRepo)
      if (!isRepo) closeGitPanel()
    }).catch(() => {
      setIsGitRepo(false)
      closeGitPanel()
    })
  }, [tab?.workingDirectory, closeGitPanel])

  // Centralized git polling — one interval for StatusBar, GitPanel, and graph
  useGitPolling(tab?.workingDirectory || '', isGitRepo)

  if (!tab) return null

  return (
    <div
      className="flex items-center justify-between px-4 py-1.5"
      style={{ minHeight: 28, flexShrink: 0 }}
    >
      {/* Left — explorer/editor toggles + directory + model picker */}
      <div className="flex items-center gap-2 text-[11px] min-w-0" style={{ color: colors.textTertiary }}>
        {/* File explorer toggle */}
        <button
          onClick={() => toggleFileExplorer(activeTabId)}
          className="flex items-center rounded-full px-1 py-0.5 transition-colors flex-shrink-0"
          style={{ color: explorerOpen ? colors.accent : colors.textTertiary, cursor: 'pointer' }}
          title={explorerOpen ? 'Close file explorer (⌘1)' : 'Open file explorer (⌘1)'}
        >
          <TreeStructure size={11} />
        </button>
        {/* File editor toggle */}
        <button
          onClick={() => toggleFileEditor(activeTabId)}
          className="flex items-center rounded-full px-1 py-0.5 transition-colors flex-shrink-0"
          style={{ color: editorOpen ? colors.accent : colors.textTertiary, cursor: 'pointer' }}
          title={editorOpen ? 'Close file editor (⌘E)' : 'Open file editor (⌘E)'}
        >
          <NotePencil size={11} />
        </button>
        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <DirectoryPicker />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <BackendIndicator />
        {!isEngine && <ModelPicker />}
        <ContextIndicator />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <PermissionModePicker />

        {isEngine && (() => {
          const pane = enginePanes.get(activeTabId)
          const hk = pane?.activeInstanceId ? `${activeTabId}:${pane.activeInstanceId}` : activeTabId
          const fields = engineStatusFields.get(hk)
          if (!fields) return null
          return (
            <>
              <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
              <span style={{ color: colors.accent, fontSize: 10 }}>
                {fields.label} [{fields.state}]
              </span>
            </>
          )
        })()}
      </div>

      {/* Right — Tall view + Open in CLI + Git */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <TallViewToggle />
        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
        <OpenWithPicker />
        {isGitRepo && (
          <>
            <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
            <GitButton />
          </>
        )}
      </div>
    </div>
  )
}
