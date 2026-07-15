import React, { useState, useEffect } from 'react'
import { TreeStructure, NotePencil } from '@phosphor-icons/react'
import { useShallow } from 'zustand/shallow'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { useGitRepo } from '../hooks/useGitRepo'
import { ModelPicker } from './StatusBarModelPicker'
import { ContextIndicator } from './StatusBarContextIndicator'
import { PermissionModePicker } from './StatusBarPermissionModePicker'
import { ThinkingPicker } from './StatusBarThinkingPicker'
import { AttachmentsButton } from './StatusBarAttachmentsButton'
import { TallViewToggle } from './StatusBarTallViewToggle'
import { DirectoryPicker } from './StatusBarDirectoryPicker'
import { GitButton } from './StatusBarGitButton'
import { StatusBarEngineIdentity } from './StatusBarEngineIdentity'
import { StatusBarEngineState } from './StatusBarEngineState'

// Re-export sibling components for any consumer importing from StatusBar.tsx
export { ModelPicker } from './StatusBarModelPicker'
export { ContextIndicator } from './StatusBarContextIndicator'
export { PermissionModePicker } from './StatusBarPermissionModePicker'
export { AttachmentsButton } from './StatusBarAttachmentsButton'
export { TallViewToggle } from './StatusBarTallViewToggle'
export { DirectoryPicker } from './StatusBarDirectoryPicker'
export { GitButton } from './StatusBarGitButton'
export { StatusBarEngineIdentity } from './StatusBarEngineIdentity'
export { StatusBarEngineState } from './StatusBarEngineState'
export { compactPath } from './StatusBarShared'

/* ─── StatusBar ───
 *
 * The single status bar for the desktop application. Always rendered
 * at the bottom of the active tab body via `App.tsx`. One instance
 * per visible tab — every state read inside this tree is derived from
 * `s.activeTabId`, so the same JSX serves conversation, engine,
 * terminal-only, and terminal-tall tabs.
 *
 * On engine tabs, additional engine-only slots appear in the left
 * cluster (extension name + team, run-state dot + label) and right
 * cluster (cost). The slot components themselves return `null` on
 * non-engine tabs, so the layout doesn't require `isEngine` gating at
 * this level.
 *
 * The context indicator (`<ContextIndicator />`) works on both tab
 * types: it reads `tab.contextPercent` / `tab.contextTokens`, both
 * of which are populated for the active engine instance by the
 * engine event slice (see engine-event-slice.ts case 'message_end').
 * One indicator, one rendering — the simple `65%` percent with a
 * hover tooltip showing the token count.
 */

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

  // Subscribe to git events for the current tab — pushes updates into useGitStore.
  useGitRepo(tab?.workingDirectory, isGitRepo)

  if (!tab) return null

  return (
    <div
      className="flex items-center justify-between px-4 py-1.5"
      style={{ minHeight: 28, flexShrink: 0 }}
    >
      {/* Left cluster — workspace toggles + directory + identity +
          state + model + context + permission + attachments. */}
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

        {/* Engine identity (extension name + team) — engine-only;
            self-gates internally to render null on conversation tabs. */}
        <StatusBarEngineIdentity />
        {/* Engine run-state dot + label — engine-only;
            self-gates internally. */}
        <StatusBarEngineState />
        <ModelPicker />
        {/* Context indicator — same component on both tab types.
            Reads `tab.contextPercent` / `tab.contextTokens`, which the
            engine event slice populates for the active engine instance
            (see engine-event-slice.ts case 'message_end'). */}
        <ContextIndicator />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <PermissionModePicker />

        {/* Per-conversation extended-thinking control. Self-hides when the
            global thinkingEnabled setting is off or the model doesn't support
            reasoning. */}
        <ThinkingPicker />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
        <AttachmentsButton />
      </div>

      {/* Right cluster — tall view + git */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <TallViewToggle />
        {isGitRepo && (
          <>
            <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
            <GitButton directory={tab?.workingDirectory ?? ''} />
          </>
        )}
      </div>
    </div>
  )
}
