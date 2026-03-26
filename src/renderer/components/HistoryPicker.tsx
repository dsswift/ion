import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { Clock, ChatCircle } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePopoverLayer } from './PopoverLayer'
import { useColors, useThemeStore } from '../theme'
import type { SessionMeta } from '../../shared/types'

function formatTimeAgo(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(isoDate).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`
}

type HistoryMode = 'all' | 'project'

export function HistoryPicker() {
  const resumeSession = useSessionStore((s) => s.resumeSession)
  const selectTab = useSessionStore((s) => s.selectTab)
  const tabs = useSessionStore((s) => s.tabs)
  const isExpanded = useSessionStore((s) => s.isExpanded)
  const activeTab = useSessionStore(
    (s) => s.tabs.find((t) => t.id === s.activeTabId),
    (a, b) => a === b || (!!a && !!b && a.hasChosenDirectory === b.hasChosenDirectory && a.workingDirectory === b.workingDirectory),
  )
  const staticInfo = useSessionStore((s) => s.staticInfo)
  const popoverLayer = usePopoverLayer()
  const colors = useColors()
  const effectiveProjectPath = activeTab?.hasChosenDirectory
    ? activeTab.workingDirectory
    : (staticInfo?.homePath || activeTab?.workingDirectory || '~')

  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<HistoryMode>('all')
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [loading, setLoading] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ right: number; top?: number; bottom?: number; maxHeight?: number }>({ right: 0 })

  const updatePos = useCallback(() => {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    if (isExpanded) {
      const top = rect.bottom + 6
      setPos({
        top,
        right: window.innerWidth - rect.right,
        maxHeight: window.innerHeight - top - 12,
      })
    } else {
      setPos({
        bottom: window.innerHeight - rect.top + 6,
        right: window.innerWidth - rect.right,
      })
    }
  }, [isExpanded])

  const loadSessions = useCallback(async (m: HistoryMode) => {
    setLoading(true)
    try {
      const result = m === 'all'
        ? await window.coda.listAllSessions()
        : await window.coda.listSessions(effectiveProjectPath)
      setSessions(result)
    } catch {
      setSessions([])
    }
    setLoading(false)
  }, [effectiveProjectPath])

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
    if (!open) {
      updatePos()
      void loadSessions(mode)
    }
    setOpen((o) => !o)
  }

  const handleModeSwitch = (m: HistoryMode) => {
    setMode(m)
    void loadSessions(m)
  }

  const handleSelect = (session: SessionMeta) => {
    setOpen(false)
    // If this session is already open in a tab, switch to it instead of duplicating
    const existingTab = tabs.find((t) =>
      t.claudeSessionId === session.sessionId
      || t.historicalSessionIds.includes(session.sessionId)
    )
    if (existingTab) {
      selectTab(existingTab.id)
      return
    }
    const title = session.customTitle
      || (session.firstMessage
        ? (session.firstMessage.length > 40 ? session.firstMessage.substring(0, 37) + '...' : session.firstMessage)
        : session.slug || 'Resumed')

    // Use the session's own project path when available (global history), fall back to current tab's path
    const sessionProjectPath = session.projectPath || effectiveProjectPath
    void resumeSession(session.sessionId, title, sessionProjectPath, session.customTitle, session.encodedDir)

    // Add the directory to recent base directories so it appears in the new-tab picker
    if (session.projectPath) {
      useThemeStore.getState().addRecentBaseDirectory(session.projectPath)
    }
  }

  // Group sessions by projectLabel in "all" mode
  const grouped = useMemo(() => {
    if (mode !== 'all') return null
    const groups: Array<{ label: string; projectPath: string | null; sessions: SessionMeta[] }> = []
    const groupMap = new Map<string, number>()
    for (const s of sessions) {
      const key = s.encodedDir || s.projectPath || '__unknown__'
      const existing = groupMap.get(key)
      if (existing != null) {
        groups[existing].sessions.push(s)
      } else {
        groupMap.set(key, groups.length)
        groups.push({
          label: s.projectLabel || 'Unknown',
          projectPath: s.projectPath,
          sessions: [s],
        })
      }
    }
    // Groups are already sorted by most recent session (since sessions come sorted by mtime)
    return groups
  }, [mode, sessions])

  const renderSession = (session: SessionMeta) => {
    const isOpen = tabs.some((t) =>
      t.claudeSessionId === session.sessionId
      || t.historicalSessionIds.includes(session.sessionId)
    )
    return (
      <button
        key={session.sessionId}
        onClick={() => handleSelect(session)}
        className="w-full flex items-start gap-2.5 px-3 py-2 text-left transition-colors"
        style={isOpen ? { opacity: 0.5 } : undefined}
      >
        <ChatCircle size={13} className="flex-shrink-0 mt-0.5" style={{ color: colors.textTertiary }} />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] truncate" style={{ color: colors.textPrimary }}>
            {session.customTitle || session.firstMessage || session.slug || session.sessionId.substring(0, 8)}
          </div>
          {session.customTitle && session.firstMessage && (
            <div className="text-[10px] truncate mt-0.5" style={{ color: colors.textSecondary, opacity: 0.7 }}>
              {session.firstMessage}
            </div>
          )}
          {!session.customTitle && session.lastResponse && (
            <div className="text-[10px] truncate mt-0.5" style={{ color: colors.textSecondary, opacity: 0.7 }}>
              {session.lastResponse}
            </div>
          )}
          <div className="flex items-center gap-2 text-[10px] mt-0.5" style={{ color: colors.textTertiary }}>
            <span>{formatTimeAgo(session.lastTimestamp)}</span>
            <span>{formatSize(session.size)}</span>
            {session.slug && <span className="truncate">{session.slug}</span>}
            {isOpen && <span style={{ color: colors.textSecondary }}>open</span>}
          </div>
        </div>
      </button>
    )
  }

  return (
    <>
      <button
        ref={triggerRef}
        onClick={handleToggle}
        className="flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full transition-colors"
        style={{ color: colors.textTertiary }}
        title="Resume a previous session"
      >
        <Clock size={13} />
      </button>

      {popoverLayer && open && createPortal(
        <motion.div
          ref={popoverRef}
          data-coda-ui
          initial={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: isExpanded ? -4 : 4 }}
          transition={{ duration: 0.12 }}
          className="rounded-xl"
          style={{
            position: 'fixed',
            ...(pos.top != null ? { top: pos.top } : {}),
            ...(pos.bottom != null ? { bottom: pos.bottom } : {}),
            right: pos.right,
            width: 300,
            pointerEvents: 'auto',
            background: colors.popoverBg,
            backdropFilter: 'blur(20px)',
            WebkitBackdropFilter: 'blur(20px)',
            boxShadow: colors.popoverShadow,
            border: `1px solid ${colors.popoverBorder}`,
            ...(pos.maxHeight != null ? { maxHeight: pos.maxHeight } : {}),
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column' as const,
          }}
        >
          {/* Header with mode toggle */}
          <div className="px-3 py-2 flex items-center justify-between flex-shrink-0" style={{ borderBottom: `1px solid ${colors.popoverBorder}` }}>
            <span className="text-[11px] font-medium" style={{ color: colors.textTertiary }}>
              Recent Sessions
            </span>
            <div className="flex gap-0.5 rounded-md p-0.5" style={{ background: colors.inputBg }}>
              {(['all', 'project'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => handleModeSwitch(m)}
                  className="px-2 py-0.5 rounded text-[10px] transition-colors"
                  style={{
                    color: mode === m ? colors.textPrimary : colors.textTertiary,
                    background: mode === m ? colors.popoverBg : 'transparent',
                    fontWeight: mode === m ? 600 : 400,
                  }}
                >
                  {m === 'all' ? 'All' : 'This Project'}
                </button>
              ))}
            </div>
          </div>

          <div className="overflow-y-auto py-1" style={{ maxHeight: pos.maxHeight != null ? undefined : 360 }}>
            {loading && (
              <div className="px-3 py-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                Loading...
              </div>
            )}

            {!loading && sessions.length === 0 && (
              <div className="px-3 py-4 text-center text-[11px]" style={{ color: colors.textTertiary }}>
                No previous sessions found
              </div>
            )}

            {/* "All" mode: grouped by directory */}
            {!loading && mode === 'all' && grouped && grouped.map((group) => (
              <div key={group.projectPath || group.label}>
                <div
                  className="px-3 pt-2 pb-1 text-[10px] font-semibold truncate"
                  style={{ color: colors.textTertiary, opacity: group.projectPath ? 1 : 0.5 }}
                  title={group.projectPath || undefined}
                >
                  {group.label}
                  {!group.projectPath && <span className="ml-1 font-normal">(removed)</span>}
                </div>
                {group.sessions.map(renderSession)}
              </div>
            ))}

            {/* "This Project" mode: flat list */}
            {!loading && mode === 'project' && sessions.map(renderSession)}
          </div>
        </motion.div>,
        popoverLayer,
      )}
    </>
  )
}
