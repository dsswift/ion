/**
 * SurfaceTabStrip — pinned singletons | separator | dynamic tabs | “+” menu.
 *
 * Visual idiom follows FileEditorTabBar (compact pills, close ×,
 * middle-click close), not the conversation TabStrip. Dirty dots for file
 * tabs read sessionStore.fileEditorStates — the buffer owner.
 */
import React, { useCallback, useState } from 'react'
import { Plus, ChartBar, FileText, FolderOpen, GitBranch, GitDiff, Globe, TerminalWindow, Image, File as FileIcon, Bell, Rectangle, ChartDonut } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { transitions } from '../../theme-tokens'
import { useSessionStore } from '../../stores/sessionStore'
import { useSurfaceStore } from './surface-store'
import { isSingleton, type SurfaceTab } from '../../../shared/studio-surface-types'
import { SurfaceAddMenu } from './SurfaceAddMenu'
import { SurfaceTabContextMenu } from './SurfaceTabContextMenu'
import { canvasTabCommand, CANVAS_TAB_COMMAND_IDS } from './canvas-tab-commands'
import { ShortcutHint } from '../../shortcuts/ShortcutHint'
import { useRevealedShortcuts } from '../../shortcuts/useShortcutHints'

function tabIcon(tab: SurfaceTab): React.JSX.Element {
  const size = 12
  switch (tab.kind) {
    case 'singleton':
      if (tab.id === 'diff') return <GitDiff size={size} />
      if (tab.id === 'plan') return <FileText size={size} />
      if (tab.id === 'status') return <ChartDonut size={size} />
      if (tab.id === 'files') return <FolderOpen size={size} />
      if (tab.id === 'gitpanel') return <GitBranch size={size} />
      return <ChartBar size={size} />
    case 'file':
      return <FileIcon size={size} />
    case 'preview':
      return <Image size={size} />
    case 'notification':
      return <Bell size={size} />
    case 'runtime-panel':
    case 'dispatch':
      return <Rectangle size={size} />
    case 'browser':
      return <Globe size={size} />
    case 'terminal':
      return <TerminalWindow size={size} />
  }
}

function tabLabel(tab: SurfaceTab): string {
  switch (tab.kind) {
    case 'singleton':
      if (tab.id === 'diff') return 'Diff'
      if (tab.id === 'plan') return 'Plan'
      if (tab.id === 'status') return 'Status'
      if (tab.id === 'files') return 'Explorer'
      if (tab.id === 'gitpanel') return 'Git'
      return 'Visualizer'
    case 'file':
    case 'preview':
      return tab.filePath.split('/').pop() ?? tab.filePath
    case 'notification':
      return 'Notification'
    case 'runtime-panel':
    case 'dispatch':
      return tab.title
    case 'browser':
      return tab.title || tab.url || 'Browser'
    case 'terminal':
      return tab.title
  }
}

function SurfaceTabPill({
  tab,
  active,
  dirty,
  chord,
  onContextMenu,
}: {
  tab: SurfaceTab
  active: boolean
  dirty: boolean
  /** The tab's live chord, present only while its modifiers are held. */
  chord?: string
  onContextMenu: (e: React.MouseEvent) => void
}): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  const activateTab = useSurfaceStore((s) => s.activateTab)
  const closeTab = useSurfaceStore((s) => s.closeTab)
  const [confirmingClose, setConfirmingClose] = useState(false)

  // Dirty file tabs get an inline discard confirm (the FileEditorTabItem
  // pattern); the buffer itself is closed alongside the descriptor so the
  // floating editor never resurrects a closed surface tab's file.
  const requestClose = useCallback(() => {
    if (tab.kind === 'file' && dirty && !confirmingClose) {
      setConfirmingClose(true)
      return
    }
    if (tab.kind === 'file') {
      const s = useSessionStore.getState()
      const dirState = s.fileEditorStates.get(tab.dir)
      const buffer = dirState?.files.find((f) => f.filePath === tab.filePath)
      if (buffer) s.closeFileEditorTab(tab.dir, buffer.id)
    }
    closeTab(tab.id)
  }, [tab, dirty, confirmingClose, closeTab])

  return (
    <div
      {...handlers}
      onClick={() => activateTab(tab.id)}
      onAuxClick={(e) => {
        // Middle-click close (button 1), the editor-tab convention.
        if (e.button === 1) requestClose()
      }}
      onContextMenu={onContextMenu}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 6px 3px 8px',
        borderRadius: 6,
        cursor: 'pointer',
        fontSize: 12,
        whiteSpace: 'nowrap',
        maxWidth: 180,
        color: active ? colors.textPrimary : colors.textTertiary,
        background: active ? interactiveBg(colors, { hover: false, pressed: false }, colors.accentLight) : interactiveBg(colors, { hover, pressed }),
        transition: `background ${transitions.base}, color ${transitions.base}`,
        fontWeight: active ? 600 : 400,
        flexShrink: 0,
      }}
    >
      {tabIcon(tab)}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{tabLabel(tab)}</span>
      {chord && <ShortcutHint chord={chord} dimmed={!active} />}
      {dirty && <span style={{ width: 6, height: 6, borderRadius: 3, background: colors.accent, flexShrink: 0 }} />}
      {confirmingClose ? (
        <span style={{ display: 'flex', gap: 3, fontSize: 9 }} onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => setConfirmingClose(false)}
            style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
          >
            keep
          </button>
          <button
            onClick={requestClose}
            style={{ color: colors.dangerFg, background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
          >
            discard
          </button>
        </span>
      ) : (
        <span
          onClick={(e) => {
            e.stopPropagation()
            requestClose()
          }}
          style={{ color: colors.textTertiary, fontSize: 13, lineHeight: 1, padding: '0 1px' }}
          aria-label={`Close ${tabLabel(tab)}`}
        >
          ×
        </span>
      )}
    </div>
  )
}

export function SurfaceTabStrip(): React.JSX.Element {
  const colors = useColors()
  const tabs = useSurfaceStore((s) => s.tabs)
  const activeTabId = useSurfaceStore((s) => s.activeTabId)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; tab: SurfaceTab } | null>(null)
  const dirtyPaths = useSessionStore((s) => {
    const dirty = new Set<string>()
    for (const dirState of s.fileEditorStates.values()) {
      for (const f of dirState.files) if (f.isDirty && f.filePath) dirty.add(f.filePath)
    }
    return dirty
  })

  const pinnedTabs = useSurfaceStore((s) => s.pinnedTabs)
  // Canvas tabs reveal their chord on ⌘⌥. File, browser, and terminal tabs
  // own no command and therefore never show a hint.
  const revealed = useRevealedShortcuts('studio', CANVAS_TAB_COMMAND_IDS)
  const pins = tabs.filter((tab) => pinnedTabs.includes(tab.id as typeof pinnedTabs[number]))
  const notification = tabs.filter((tab) => tab.id === 'notification')
  const localSingletons = tabs.filter((tab) => !pinnedTabs.includes(tab.id as typeof pinnedTabs[number]) && tab.id !== 'notification' && isSingleton(tab))
  const dynamics = tabs.filter((tab) => !pinnedTabs.includes(tab.id as typeof pinnedTabs[number]) && tab.id !== 'notification' && !isSingleton(tab))
  const groups = [pins, notification, localSingletons, dynamics].filter((group) => group.length > 0)

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        borderBottom: `1px solid ${colors.containerBorder}`,
        fontFamily: 'system-ui, sans-serif',
        overflowX: 'auto',
        flexShrink: 0,
      }}
    >
      {groups.map((group, groupIndex) => (
        <React.Fragment key={`surface-group-${groupIndex}`}>
          {groupIndex > 0 && <div style={{ width: 1, alignSelf: 'stretch', margin: '3px 2px', background: colors.containerBorder, flexShrink: 0 }} />}
          {group.map((t) => {
            const command = canvasTabCommand(t.id)
            return (
            <SurfaceTabPill
              key={t.id}
              tab={t}
              active={t.id === activeTabId}
              dirty={t.kind === 'file' && dirtyPaths.has(t.filePath)}
              chord={command ? revealed.get(command) : undefined}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, tab: t })
              }}
            />
            )
          })}
        </React.Fragment>
      ))}
      <button
        onClick={(e) => setAddMenu({ x: e.clientX, y: e.clientY })}
        style={{
          border: 'none',
          background: 'transparent',
          color: colors.textTertiary,
          cursor: 'pointer',
          padding: '3px 4px',
          display: 'flex',
          alignItems: 'center',
          flexShrink: 0,
        }}
        aria-label="Add surface tab"
      >
        <Plus size={13} />
      </button>
      {addMenu && <SurfaceAddMenu x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)} />}
      {ctxMenu && <SurfaceTabContextMenu x={ctxMenu.x} y={ctxMenu.y} tab={ctxMenu.tab} onClose={() => setCtxMenu(null)} />}
    </div>
  )
}
