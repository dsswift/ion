import React, { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { Terminal, CaretDown, Check, FolderOpen, Plus, X, ShieldCheck, ListChecks, GitBranch, Code, TreeStructure, NotePencil, ArrowsOutSimple, ArrowsInSimple, Copy } from '@phosphor-icons/react'
import { useSessionStore, AVAILABLE_MODELS, getModelDisplayLabel } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore } from '../theme'
import { useGitPolling, useGitPollingStore } from '../hooks/useGitPolling'

/* ─── Model Picker (inline — tightly coupled to StatusBar) ─── */

function ModelPicker() {
  const preferredModel = useSessionStore((s) => s.preferredModel)
  const setPreferredModel = useSessionStore((s) => s.setPreferredModel)
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.status === b.status && a.sessionModel === b.sessionModel),
  )
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const activeTabId = useSessionStore((s) => s.activeTabId)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  const isBusy = tab?.status === 'running' || tab?.status === 'connecting'

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (isBusy) return
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const activeLabel = (() => {
    if (preferredModel) {
      return getModelDisplayLabel(preferredModel)
    }
    if (tab?.sessionModel) {
      return getModelDisplayLabel(tab.sessionModel)
    }
    return AVAILABLE_MODELS[0].label
  })()

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: colors.textTertiary,
          cursor: isBusy ? 'not-allowed' : 'pointer',
        }}
        title={isBusy ? 'Stop the task to change model' : 'Switch model'}
      >
        {activeLabel}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 192,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            {AVAILABLE_MODELS.map((m) => {
              const isSelected = preferredModel === m.id || (!preferredModel && m.id === AVAILABLE_MODELS[0].id)
              return (
                <button
                  key={m.id}
                  onClick={() => { setPreferredModel(m.id); setOpen(false) }}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: isSelected ? colors.textPrimary : colors.textSecondary,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  {m.label}
                  {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                </button>
              )
            })}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

/* ─── Context Percentage Indicator ─── */

function ContextIndicator() {
  const colors = useColors()
  const { contextTokens, sessionModel } = useSessionStore(
    (s) => {
      const tab = s.tabs.find((t) => t.id === s.activeTabId)
      return { contextTokens: tab?.contextTokens ?? null, sessionModel: tab?.sessionModel ?? null }
    },
    (a, b) => a.contextTokens === b.contextTokens && a.sessionModel === b.sessionModel,
  )

  if (contextTokens === null) return null

  const windowSize = sessionModel?.includes('[1m]') ? 1_000_000 : 200_000
  const pct = Math.round((contextTokens / windowSize) * 100)

  let color = colors.textTertiary
  if (pct >= 70) color = '#e06040'
  else if (pct >= 50) color = '#d4a017'

  return (
    <span className="text-[10px] px-0.5" style={{ color }}>
      {pct}%
    </span>
  )
}

/* ─── Permission Mode Picker (per-tab) ─── */

function PermissionModePicker() {
  const permissionMode = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId)?.permissionMode ?? 'plan'
  )
  const setPermissionMode = useSessionStore((s) => s.setPermissionMode)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, left: 0 })

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      left: rect.left,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (triggerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const modeLabel = permissionMode === 'plan' ? 'Plan' : 'Auto'
  const modeIcon = permissionMode === 'plan'
    ? <ListChecks size={11} weight="bold" />
    : <ShieldCheck size={11} weight="fill" />
  const modeColor = permissionMode === 'plan'
    ? '#2eb8a6'
    : colors.textTertiary

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex items-center gap-0.5 text-[10px] rounded-full px-1.5 py-0.5 transition-colors"
        style={{
          color: modeColor,
          cursor: 'pointer',
        }}
        title="Permission mode (this tab)"
      >
        {modeIcon}
        {modeLabel}
        <CaretDown size={10} style={{ opacity: 0.6 }} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            left: pos.left,
            width: 180,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            <button
              onClick={() => { setPermissionMode('plan'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: permissionMode === 'plan' ? colors.textPrimary : colors.textSecondary,
                fontWeight: permissionMode === 'plan' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ListChecks size={12} weight="bold" />
                Plan
              </span>
              {permissionMode === 'plan' && <Check size={12} style={{ color: colors.accent }} />}
            </button>

            <div className="mx-2 my-0.5" style={{ height: 1, background: colors.popoverBorder }} />

            <button
              onClick={() => { setPermissionMode('auto'); setOpen(false) }}
              className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
              style={{
                color: permissionMode === 'auto' ? colors.textPrimary : colors.textSecondary,
                fontWeight: permissionMode === 'auto' ? 600 : 400,
              }}
            >
              <span className="flex items-center gap-1.5">
                <ShieldCheck size={12} weight="fill" />
                Auto
              </span>
              {permissionMode === 'auto' && <Check size={12} style={{ color: colors.accent }} />}
            </button>
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

/* ─── Open With Picker ─── */

const OPEN_WITH_OPTIONS = [
  { id: 'cli' as const, label: 'Open in CLI', icon: Terminal },
  { id: 'vscode' as const, label: 'Open in VS Code', icon: Code },
]

function OpenWithPicker() {
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.claudeSessionId === b.claudeSessionId && a.workingDirectory === b.workingDirectory),
  )
  const preferredOpenWith = useThemeStore((s) => s.preferredOpenWith)
  const setPreferredOpenWith = useThemeStore((s) => s.setPreferredOpenWith)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ bottom: 0, right: 0 })

  useEffect(() => { setOpen(false) }, [activeTabId])

  const updatePos = useCallback(() => {
    if (!containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    setPos({
      bottom: window.innerHeight - rect.top + 6,
      right: window.innerWidth - rect.right,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (containerRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const openCliInTerminal = useSessionStore((s) => s.openCliInTerminal)

  const handleExecute = () => {
    if (!tab) return
    if (preferredOpenWith === 'cli') {
      openCliInTerminal(tab.id, tab.claudeSessionId, tab.workingDirectory)
    } else {
      window.coda.openInVSCode(tab.workingDirectory)
    }
  }

  const handleToggle = () => {
    if (!open) updatePos()
    setOpen((o) => !o)
  }

  const handleSelect = (id: 'cli' | 'vscode') => {
    setPreferredOpenWith(id)
    setOpen(false)
  }

  const active = OPEN_WITH_OPTIONS.find((o) => o.id === preferredOpenWith) ?? OPEN_WITH_OPTIONS[0]
  const ActiveIcon = active.icon

  return (
    <>
      <div ref={containerRef} className="flex items-center">
        <button
          onClick={handleExecute}
          className="flex items-center gap-1 text-[11px] rounded-l-full pl-2 pr-1 py-0.5 transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          title={active.label}
        >
          {active.label}
          <ActiveIcon size={11} />
        </button>
        <button
          onClick={handleToggle}
          className="flex items-center rounded-r-full pr-1.5 py-0.5 transition-colors"
          style={{ color: colors.textTertiary, cursor: 'pointer' }}
          title="Switch open-with app"
        >
          <CaretDown size={9} style={{ opacity: 0.6 }} />
        </button>
      </div>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            bottom: pos.bottom,
            right: pos.right,
            width: 180,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
          }}
        >
          <div className="py-1">
            {OPEN_WITH_OPTIONS.map((opt) => {
              const Icon = opt.icon
              const isSelected = preferredOpenWith === opt.id
              return (
                <button
                  key={opt.id}
                  onClick={() => handleSelect(opt.id)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-[11px] transition-colors"
                  style={{
                    color: isSelected ? colors.textPrimary : colors.textSecondary,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <Icon size={12} />
                    {opt.label}
                  </span>
                  {isSelected && <Check size={12} style={{ color: colors.accent }} />}
                </button>
              )
            })}
            {tab?.claudeSessionId && (
              <>
                <div className="mx-2 my-1" style={{ borderTop: `1px solid ${colors.popoverBorder}` }} />
                <button
                  onClick={() => {
                    navigator.clipboard.writeText(tab.claudeSessionId)
                    setOpen(false)
                  }}
                  className="w-full flex items-center px-3 py-1.5 text-[11px] transition-colors"
                  style={{ color: colors.textSecondary }}
                >
                  <span className="flex items-center gap-1.5">
                    <Copy size={12} />
                    Copy Session ID
                  </span>
                </button>
              </>
            )}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}

/* ─── Tall View Toggle ─── */

function TallViewToggle() {
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const isTall = useSessionStore((s) => s.tallViewTabId === s.activeTabId)
  const toggleTallView = useSessionStore((s) => s.toggleTallView)
  const colors = useColors()

  return (
    <button
      onClick={() => toggleTallView(activeTabId)}
      className="flex items-center rounded-full px-1 py-0.5 transition-colors"
      style={{ color: isTall ? colors.accent : colors.textTertiary, cursor: 'pointer' }}
      title={isTall ? 'Exit tall view' : 'Expand to tall view'}
    >
      {isTall ? <ArrowsInSimple size={11} /> : <ArrowsOutSimple size={11} />}
    </button>
  )
}

/* ─── StatusBar ─── */

/** Get a compact display path: basename for deep paths, ~ for home */
function compactPath(fullPath: string): string {
  if (fullPath === '~') return '~'
  const parts = fullPath.replace(/\/$/, '').split('/')
  return parts[parts.length - 1] || fullPath
}

export function StatusBar() {
  const tab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b
      && a.status === b.status
      && a.additionalDirs === b.additionalDirs
      && a.hasChosenDirectory === b.hasChosenDirectory
      && a.workingDirectory === b.workingDirectory
      && a.claudeSessionId === b.claudeSessionId
      && (a.messages.length > 0) === (b.messages.length > 0)
    ),
  )
  const addDirectory = useSessionStore((s) => s.addDirectory)
  const removeDirectory = useSessionStore((s) => s.removeDirectory)
  const setBaseDirectory = useSessionStore((s) => s.setBaseDirectory)
  const gitPanelOpen = useSessionStore((s) => s.gitPanelOpen)
  const toggleGitPanel = useSessionStore((s) => s.toggleGitPanel)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const explorerOpen = useSessionStore((s) => s.fileExplorerOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const toggleFileExplorer = useSessionStore((s) => s.toggleFileExplorer)
  const editorOpen = useSessionStore((s) => s.fileEditorOpenDirs.has(s.tabs.find((t) => t.id === s.activeTabId)?.workingDirectory || ''))
  const toggleFileEditor = useSessionStore((s) => s.toggleFileEditor)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()

  const [isGitRepo, setIsGitRepo] = useState(false)
  const [dirOpen, setDirOpen] = useState(false)
  const dirRef = useRef<HTMLButtonElement>(null)
  const dirPopRef = useRef<HTMLDivElement>(null)
  const [dirPos, setDirPos] = useState({ bottom: 0, left: 0 })

  // Close popover on tab change
  useEffect(() => { setDirOpen(false) }, [activeTabId])

  // Close popover on outside click
  useEffect(() => {
    if (!dirOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (dirRef.current?.contains(target)) return
      if (dirPopRef.current?.contains(target)) return
      setDirOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [dirOpen])

  const closeGitPanel = useSessionStore((s) => s.closeGitPanel)

  // Check if working directory is a git repo; close git panel if not
  useEffect(() => {
    if (!tab?.workingDirectory || tab.workingDirectory === '~') {
      setIsGitRepo(false)
      closeGitPanel()
      return
    }
    window.coda.gitIsRepo(tab.workingDirectory).then(({ isRepo }) => {
      setIsGitRepo(isRepo)
      if (!isRepo) closeGitPanel()
    }).catch(() => {
      setIsGitRepo(false)
      closeGitPanel()
    })
  }, [tab?.workingDirectory, closeGitPanel])

  // Centralized git polling — one interval for StatusBar, GitPanel, and graph
  useGitPolling(tab?.workingDirectory || '', isGitRepo)
  const gitBranch = useGitPollingStore((s) => s.branch)
  const gitFileCount = useGitPollingStore((s) => s.files.length)
  const gitAhead = useGitPollingStore((s) => s.ahead)
  const gitBehind = useGitPollingStore((s) => s.behind)

  if (!tab) return null

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const isEmpty = tab.messages.length === 0
  const hasExtraDirs = tab.additionalDirs.length > 0
  const baseLocked = !isEmpty

  const handleDirClick = () => {
    if (isRunning) return
    if (!dirOpen && dirRef.current) {
      const rect = dirRef.current.getBoundingClientRect()
      setDirPos({
        bottom: window.innerHeight - rect.top + 6,
        left: rect.left,
      })
    }
    setDirOpen((o) => !o)
  }

  const handleAddDir = async () => {
    const dir = await window.coda.selectDirectory()
    if (dir) {
      if (!tab.hasChosenDirectory && !baseLocked) {
        setBaseDirectory(dir)
      } else {
        addDirectory(dir)
      }
    }
  }

  const handleChangeBaseDir = async () => {
    if (isRunning || baseLocked) return
    const dir = await window.coda.selectDirectory()
    if (dir) {
      setBaseDirectory(dir)
    }
  }

  const dirTooltip = tab.hasChosenDirectory
    ? [tab.workingDirectory, ...tab.additionalDirs].join('\n')
    : 'Using home directory by default — click to choose a folder'

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
        {/* Directory button */}
        <button
          ref={dirRef}
          onClick={handleDirClick}
          className="flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors flex-shrink-0"
          style={{
            color: colors.textTertiary,
            cursor: isRunning ? 'not-allowed' : 'pointer',
            maxWidth: 140,
          }}
          title={dirTooltip}
          disabled={isRunning}
        >
          <FolderOpen size={11} className="flex-shrink-0" />
          <span className="truncate">{tab.hasChosenDirectory ? compactPath(tab.workingDirectory) : '—'}</span>
          {hasExtraDirs && (
            <span style={{ color: colors.textTertiary, fontWeight: 600 }}>+{tab.additionalDirs.length}</span>
          )}
        </button>

        {/* Directory popover */}
        {popoverLayer && dirOpen && createPortal(
          <motion.div
            ref={dirPopRef}
            data-coda-ui
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.12 }}
            className="rounded-xl"
            style={{
              position: 'fixed',
              bottom: dirPos.bottom,
              left: dirPos.left,
              width: 'auto',
              minWidth: 220,
              maxWidth: 500,
              pointerEvents: 'auto',
              background: colors.popoverBg,
              backdropFilter: 'blur(20px)',
              WebkitBackdropFilter: 'blur(20px)',
              boxShadow: colors.popoverShadow,
              border: `1px solid ${colors.popoverBorder}`,
            }}
          >
            <div className="py-1.5 px-1">
              {/* Base directory */}
              <button
                onClick={handleChangeBaseDir}
                disabled={isRunning || baseLocked}
                className="w-full text-left px-2 py-1 rounded-lg transition-colors hover:bg-white/5"
                style={{ cursor: isRunning || baseLocked ? 'default' : 'pointer', opacity: baseLocked ? 0.7 : 1 }}
                title={baseLocked ? 'Base directory is locked after the conversation starts' : tab.hasChosenDirectory ? `${tab.workingDirectory} — click to change` : 'Click to choose a base directory'}
              >
                <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                  Base directory
                </div>
                <div className="flex items-center gap-1.5 text-[11px]" style={{ color: tab.hasChosenDirectory ? colors.textSecondary : colors.textMuted, whiteSpace: 'nowrap' }}>
                  <FolderOpen size={13} className="flex-shrink-0" style={{ color: colors.accent }} />
                  {tab.hasChosenDirectory ? tab.workingDirectory : 'None (defaults to ~)'}
                </div>
              </button>

              {/* Additional directories */}
              {hasExtraDirs && (
                <>
                  <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />
                  <div className="px-2 py-1">
                    <div className="text-[9px] uppercase tracking-wider mb-1" style={{ color: colors.textTertiary }}>
                      Added directories
                    </div>
                    {tab.additionalDirs.map((dir) => (
                      <div key={dir} className="flex items-center justify-between py-0.5 group">
                        <span className="text-[11px] truncate mr-2" style={{ color: colors.textSecondary }} title={dir}>
                          {compactPath(dir)}
                        </span>
                        <button
                          onClick={() => removeDirectory(dir)}
                          className="flex-shrink-0 opacity-50 hover:opacity-100 transition-opacity"
                          style={{ color: colors.textTertiary }}
                          title="Remove directory"
                        >
                          <X size={10} />
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <div className="mx-2 my-1" style={{ height: 1, background: colors.popoverBorder }} />

              {/* Add directory button */}
              <button
                onClick={handleAddDir}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 text-[11px] transition-colors rounded-lg"
                style={{ color: colors.accent }}
              >
                <Plus size={10} />
                Add directory...
              </button>
            </div>
          </motion.div>,
          popoverLayer,
        )}

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <ModelPicker />
        <ContextIndicator />

        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>

        <PermissionModePicker />
      </div>

      {/* Right — Tall view + Open in CLI + Git */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <TallViewToggle />
        <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
        <OpenWithPicker />
        {isGitRepo && (
          <>
            <span style={{ color: colors.textMuted, fontSize: 10 }}>|</span>
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
          </>
        )}
      </div>
    </div>
  )
}
