import React, { useState, useCallback } from 'react'
import { Reorder } from 'framer-motion'
import { X, Plus, Eye, PencilSimple, TextAlignLeft } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { usePreferencesStore } from '../preferences'
import { useSessionStore, FileEditorTab } from '../stores/sessionStore'
import { isMarkdownFile } from './FileEditorShared'
import { FileEditorTabContextMenu } from './FileEditorTabContextMenu'

/**
 * Icon button in the tab bar (new scratch, preview/read-only/word-wrap
 * toggles, tab close X). Standard hover/pressed backgrounds over an
 * optional active-toggle base background.
 */
function TabBarIconButton({
  title,
  onClick,
  colors,
  color,
  activeBg,
  className,
  style,
  children,
}: {
  title?: string
  onClick: (e: React.MouseEvent) => void
  colors: ReturnType<typeof useColors>
  color: string
  /** Base background when the toggle is active (e.g. accentLight). */
  activeBg?: string
  className?: string
  style?: React.CSSProperties
  children: React.ReactNode
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      title={title}
      onClick={onClick}
      className={`${className ?? ''} ion-focusable`}
      {...handlers}
      style={{
        color,
        cursor: 'pointer',
        background: interactiveBg(colors, { hover, pressed }, activeBg ?? 'transparent'),
        transition: `color ${transitions.base}, background ${transitions.base}`,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

interface FileEditorTabBarProps {
  dir: string
  files: FileEditorTab[]
  activeFile: FileEditorTab | null
  activeFileId: string | null
}

/**
 * The strip of file tabs above the editor surface, plus the right-side
 * action buttons (preview toggle, read-only toggle, word-wrap toggle).
 */
export function FileEditorTabBar({ dir, files, activeFile, activeFileId }: FileEditorTabBarProps) {
  const colors = useColors()
  const setActiveEditorFile = useSessionStore((s) => s.setActiveEditorFile)
  const closeFileEditorTab = useSessionStore((s) => s.closeFileEditorTab)
  const createScratchFile = useSessionStore((s) => s.createScratchFile)
  const reorderEditorFiles = useSessionStore((s) => s.reorderEditorFiles)
  const toggleEditorPreview = useSessionStore((s) => s.toggleEditorPreview)
  const toggleEditorReadOnly = useSessionStore((s) => s.toggleEditorReadOnly)
  const editorWordWrap = usePreferencesStore((s) => s.editorWordWrap)
  const setEditorWordWrap = usePreferencesStore((s) => s.setEditorWordWrap)

  // Tab context menu state
  const [tabCtxMenu, setTabCtxMenu] = useState<{ x: number; y: number; file: FileEditorTab } | null>(null)

  const handleCloseOthers = useCallback((fileId: string) => {
    files.forEach((f) => { if (f.id !== fileId) closeFileEditorTab(dir, f.id) })
  }, [files, dir, closeFileEditorTab])

  const handleCloseAll = useCallback(() => {
    files.forEach((f) => closeFileEditorTab(dir, f.id))
  }, [files, dir, closeFileEditorTab])

  const handleCloseToRight = useCallback((fileId: string) => {
    const idx = files.findIndex((f) => f.id === fileId)
    if (idx < 0) return
    files.slice(idx + 1).forEach((f) => closeFileEditorTab(dir, f.id))
  }, [files, dir, closeFileEditorTab])

  return (
    <div
      data-ion-ui
      className="flex items-center"
      style={{
        height: 30,
        minHeight: 30,
        background: colors.surfacePrimary,
        borderBottom: `1px solid ${colors.containerBorder}`,
        userSelect: 'none',
      }}
    >
      {/* Scrollable tabs (draggable reorder) */}
      <Reorder.Group
        as="div"
        axis="x"
        values={files}
        onReorder={(reordered) => reorderEditorFiles(dir, reordered)}
        className="flex items-center gap-0 flex-1 overflow-x-auto"
        style={{ scrollbarWidth: 'none' }}
      >
        {files.map((file) => (
          <Reorder.Item
            key={file.id}
            value={file}
            as="div"
            dragListener={true}
            dragConstraints={{ top: 0, bottom: 0 }}
            style={{ cursor: 'grab' }}
          >
            <FileEditorTabItem
              file={file}
              isActive={file.id === activeFileId}
              colors={colors}
              onSelect={() => setActiveEditorFile(dir, file.id)}
              onClose={(e) => {
                e.stopPropagation()
                closeFileEditorTab(dir, file.id)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setTabCtxMenu({ x: e.clientX, y: e.clientY, file })
              }}
            />
          </Reorder.Item>
        ))}
        <TabBarIconButton
          className="flex items-center justify-center px-2 rounded"
          style={{ height: 30 }}
          color={colors.textTertiary}
          colors={colors}
          onClick={() => createScratchFile(dir)}
          title="New scratch file"
        >
          <Plus size={12} weight="bold" />
        </TabBarIconButton>
      </Reorder.Group>

      {/* Right-side actions */}
      <div className="flex items-center gap-1 px-2">
        {activeFile && isMarkdownFile(activeFile.fileName) && (
          <TabBarIconButton
            className="flex items-center justify-center rounded p-1"
            color={activeFile.isPreview ? colors.accent : colors.textTertiary}
            activeBg={activeFile.isPreview ? colors.accentLight : undefined}
            colors={colors}
            onClick={() => toggleEditorPreview(dir, activeFile.id)}
            title="Toggle preview"
          >
            <Eye size={13} />
          </TabBarIconButton>
        )}
        {activeFile && activeFile.isReadOnly && (
          <TabBarIconButton
            className="flex items-center justify-center rounded p-1"
            color={colors.textTertiary}
            colors={colors}
            onClick={() => toggleEditorReadOnly(dir, activeFile.id)}
            title="Enable editing"
          >
            <PencilSimple size={13} />
          </TabBarIconButton>
        )}
        <TabBarIconButton
          className="flex items-center justify-center rounded p-1"
          color={editorWordWrap ? colors.accent : colors.textTertiary}
          colors={colors}
          onClick={() => setEditorWordWrap(!editorWordWrap)}
          title={editorWordWrap ? 'Disable word wrap' : 'Enable word wrap'}
        >
          <TextAlignLeft size={13} />
        </TabBarIconButton>
      </div>

      {/* Tab context menu */}
      {tabCtxMenu && (
        <FileEditorTabContextMenu
          x={tabCtxMenu.x}
          y={tabCtxMenu.y}
          filePath={tabCtxMenu.file.filePath}
          onClose={() => setTabCtxMenu(null)}
          onCloseTab={() => closeFileEditorTab(dir, tabCtxMenu.file.id)}
          onCloseOthers={() => handleCloseOthers(tabCtxMenu.file.id)}
          onCloseAll={handleCloseAll}
          onCloseToRight={() => handleCloseToRight(tabCtxMenu.file.id)}
          onCopyPath={() => {
            if (tabCtxMenu.file.filePath) void navigator.clipboard.writeText(tabCtxMenu.file.filePath)
          }}
          onCopyRelativePath={() => {
            if (tabCtxMenu.file.filePath) {
              const rel = tabCtxMenu.file.filePath.startsWith(dir + '/')
                ? tabCtxMenu.file.filePath.slice(dir.length + 1)
                : tabCtxMenu.file.filePath
              void navigator.clipboard.writeText(rel)
            }
          }}
          onRevealInFinder={() => {
            if (tabCtxMenu.file.filePath) void window.ion.fsRevealInFinder(tabCtxMenu.file.filePath)
          }}
          onOpenInVSCode={() => {
            if (tabCtxMenu.file.filePath) void window.ion.openExternal(`vscode://file${tabCtxMenu.file.filePath}`)
          }}
        />
      )}
    </div>
  )
}

// ---- Tab item sub-component ----

interface FileEditorTabItemProps {
  file: FileEditorTab
  isActive: boolean
  colors: ReturnType<typeof useColors>
  onSelect: () => void
  onClose: (e: React.MouseEvent) => void
  onContextMenu: (e: React.MouseEvent) => void
}

function FileEditorTabItem({ file, isActive, colors, onSelect, onClose, onContextMenu }: FileEditorTabItemProps) {
  const [confirmingClose, setConfirmingClose] = useState(false)
  const { hover, pressed, handlers } = useInteractiveState()

  const handleClose = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (file.isDirty) {
      setConfirmingClose(true)
    } else {
      onClose(e)
    }
  }

  return (
    <div
      className="flex items-center gap-1.5 px-2 cursor-pointer"
      {...handlers}
      style={{
        height: 30,
        background: interactiveBg(colors, { hover, pressed }, isActive ? colors.tabActive : 'transparent'),
        borderBottom: isActive ? `2px solid ${colors.accent}` : '2px solid transparent',
        fontFamily: 'monospace',
        fontSize: 11,
        color: isActive ? colors.textPrimary : colors.textTertiary,
        whiteSpace: 'nowrap',
        transition: `background ${transitions.base}, color ${transitions.base}`,
      }}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); handleClose(e) } }}
    >
      <span style={{ fontStyle: file.filePath === null ? 'italic' : 'normal', fontWeight: isActive ? 500 : undefined }}>
        {file.fileName}
      </span>
      {confirmingClose ? (
        <div className="flex items-center gap-0.5 text-[9px] flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setConfirmingClose(false)}
            className="px-1 rounded ion-focusable"
            style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            No
          </button>
          <button
            onClick={(e) => { onClose(e); setConfirmingClose(false) }}
            className="px-1 rounded ion-focusable"
            style={{ color: colors.accent, background: 'none', border: 'none', cursor: 'pointer' }}
          >
            Yes
          </button>
        </div>
      ) : (
        <>
          {file.isDirty && (
            <span
              style={{
                display: 'inline-block',
                width: 5,
                height: 5,
                borderRadius: '50%',
                backgroundColor: colors.accent,
                flexShrink: 0,
              }}
            />
          )}
          <TabBarIconButton
            className="flex items-center justify-center rounded p-0.5"
            color={colors.textTertiary}
            colors={colors}
            style={{ opacity: 0.6, flexShrink: 0 }}
            onClick={handleClose}
          >
            <X size={10} />
          </TabBarIconButton>
        </>
      )}
    </div>
  )
}
