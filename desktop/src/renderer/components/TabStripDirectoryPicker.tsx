import React, { useState, useRef, useEffect, useLayoutEffect, useMemo } from 'react'
import { useViewportClamp } from '../hooks/useViewportClamp'
import { createPortal } from 'react-dom'
import { motion } from 'framer-motion'
import { FolderPlus, FolderOpen, Trash, GitBranch, Flask as FlaskIcon } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { useColors } from '../theme'
import { usePopoverLayer } from './PopoverLayer'
import { usePreferencesStore } from '../preferences'
import { pickDirectoryForSession } from '../stores/remote-fs-store'
import { rError } from '../rendererLogger'
import { recentLocalDirectories } from '../../shared/recent-directories'

interface DirectoryPickerProps {
  anchor: { x: number; y: number; bottom: number }
  onSelectDir: (dir: string) => void
  onClose: () => void
}

/**
 * Collapse the multi-key aliasing in the inventory maps down to one row per
 * directory.
 *
 * `openRepoPaths` is keyed by whatever directory each tab REPORTS, and a tab
 * living inside a worktree or a bench (terminal tabs, tabs without worktree
 * metadata) reports that directory as its "repo". `git worktree list` from
 * inside a worktree returns the same repo's worktrees, so the inventory map
 * holds identical entry sets under several keys and a plain flatMap renders
 * every worktree once per key — the duplicate-list bug, plus duplicate React
 * keys. A directory's identity is its path; dedupe on it, keeping the first
 * occurrence (repo-key order is the tab order, which is stable within a
 * render).
 */
export function dedupeByPath<T>(entries: readonly T[], pathOf: (e: T) => string): T[] {
  const seen = new Set<string>()
  return entries.filter((e) => {
    const path = pathOf(e)
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
}

/**
 * Return generic local project recents in display order.
 *
 * Workspace rows are deliberately rendered from worktree/bench inventory above
 * this list, so raw workspace paths never compete with their named shortcuts.
 */
export function sortRecentDirectories(
  recentDirs: readonly string[],
  usageCounts: Readonly<Record<string, number>>,
): string[] {
  return [...recentLocalDirectories(recentDirs)].sort((a, b) => {
    const countDiff = (usageCounts[b] || 0) - (usageCounts[a] || 0)
    if (countDiff !== 0) return countDiff
    return a.localeCompare(b)
  })
}

/** Popover that lists recent base directories (sorted by usage) and a "Choose directory..." action. */
export function DirectoryPicker({
  anchor,
  onSelectDir,
  onClose,
}: DirectoryPickerProps) {
  const colors = useColors()
  const popoverLayer = usePopoverLayer()
  const ref = useRef<HTMLDivElement>(null)
  // Keep the portaled popover inside the window (Studio top-anchored strip).
  useViewportClamp(ref, true)
  const recentDirs = usePreferencesStore((s) => s.recentBaseDirectories)
  const usageCounts = usePreferencesStore((s) => s.directoryUsageCounts)
  const [flipDown, setFlipDown] = useState(false)

  // Worktrees + benches for every project the operator has open. This is the
  // ZERO-KNOWLEDGE recovery path: closing a worktree conversation no longer
  // destroys anything, but the operator still needs a way back in without
  // knowing the generated `~/.ion/worktrees/...` path — and without the git
  // panel necessarily being open.
  const tabs = useSessionStore((s) => s.tabs)
  const worktreeInventory = useSessionStore((s) => s.worktreeInventory)
  const benchWorkspaces = useSessionStore((s) => s.benchWorkspaces)

  const openRepoPaths = useMemo(() => {
    const set = new Set<string>()
    for (const t of tabs) {
      const repo = t.worktree?.repoPath ?? t.workingDirectory
      if (repo && repo !== '~') set.add(repo)
    }
    return [...set]
  }, [tabs])

  // Refresh on open so the list is correct the moment it renders rather than a
  // beat later (view-readiness).
  useEffect(() => {
    for (const repo of openRepoPaths) {
      void useSessionStore.getState().refreshWorktreeInventory(repo)
      void useSessionStore.getState().refreshBench(repo)
    }
  }, [openRepoPaths])

  // See dedupeByPath: several repo keys can hold the same inventory, and a
  // worktree or bench must render exactly once regardless of how many open
  // tabs surfaced it.
  const worktreeEntries = useMemo(
    () => dedupeByPath(
      openRepoPaths.flatMap((repo) =>
        (worktreeInventory.get(repo) ?? []).map((w) => ({ repo, entry: w }))),
      ({ entry }) => entry.worktreePath,
    ),
    [openRepoPaths, worktreeInventory],
  )
  const benchEntries = useMemo(
    () => dedupeByPath(
      openRepoPaths.flatMap((repo) =>
        (benchWorkspaces.get(repo) ?? [])
          // Only benches that have been built have a directory to open.
          .filter((ws) => ws.lastBuiltAt > 0)
          .map((ws) => ({ repo, ws }))),
      ({ ws }) => ws.benchPath,
    ),
    [openRepoPaths, benchWorkspaces],
  )

  const sortedDirs = sortRecentDirectories(recentDirs, usageCounts)

  // Flip to open downward if the popover overflows the top of the viewport
  useLayoutEffect(() => {
    if (!ref.current) return
    const rect = ref.current.getBoundingClientRect()
    if (rect.top < 0) setFlipDown(true)
  }, [])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', handleClick)
    window.addEventListener('keydown', handleKey)
    return () => {
      window.removeEventListener('mousedown', handleClick)
      window.removeEventListener('keydown', handleKey)
    }
  }, [onClose])

  const handleChooseDirectory = async () => {
    // New-tab creation doesn't know its session type yet; we treat it as
    // engine-mediated by default, which means the remote picker is used
    // when the bridge is remote.
    const dir = await pickDirectoryForSession({ isTerminalOnly: false })
    if (dir) {
      onSelectDir(dir)
      onClose()
    }
  }

  if (!popoverLayer) return null

  return createPortal(
    <motion.div
      ref={ref}
      data-ion-ui
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.12 }}
      style={{
        position: 'fixed',
        left: anchor.x,
        ...(flipDown
          ? { top: anchor.bottom + 6 }
          : { bottom: (window.innerHeight / (usePreferencesStore.getState().uiZoom || 1)) - anchor.y + 6 }),
        pointerEvents: 'auto',
        background: colors.popoverBg,
        border: `1px solid ${colors.popoverBorder}`,
        borderRadius: 8,
        padding: 4,
        zIndex: 10000,
        minWidth: 220,
      }}
    >
      {/* Benches first: distinct from feature worktrees, and the surface an
          operator reaches for when a combined build is failing. A bench row
          opens the bench TERMINAL, not a conversation: bench work is shell
          work (build, run, test), operator conversations are deliberately
          not offered in a bench (see BenchBar), and the one-terminal-per-
          bench action lands on the existing tab instead of stacking one. */}
      {benchEntries.map(({ repo, ws }) => (
        <div
          key={ws.benchPath}
          data-testid={`picker-bench-${ws.sourceBranch}`}
          className="flex items-center w-full rounded px-2 py-1.5"
          style={{ fontSize: 12, color: colors.textPrimary, cursor: 'pointer' }}
          title={ws.benchPath}
          onClick={() => {
            void useSessionStore.getState().openBenchTerminal(repo, ws.sourceBranch)
              .catch((err) => rError('tabs', 'open bench terminal failed', { error: String(err) }))
            onClose()
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
        >
          <FlaskIcon size={14} color={colors.accent} style={{ flexShrink: 0, marginRight: 8 }} />
          <span style={{ whiteSpace: 'nowrap', flex: 1 }}>Bench · {ws.sourceBranch}</span>
          <span style={{ fontSize: 10, color: colors.textTertiary }}>
            {ws.members.length} member{ws.members.length === 1 ? '' : 's'}
          </span>
        </div>
      ))}

      {worktreeEntries.map(({ entry }) => {
        const openTab = tabs.find((t) => t.workingDirectory === entry.worktreePath)
        return (
          <div
            key={entry.worktreePath}
            data-testid={`picker-worktree-${entry.branchName}`}
            className="flex items-center w-full rounded px-2 py-1.5"
            style={{ fontSize: 12, color: colors.textPrimary, cursor: 'pointer' }}
            title={entry.worktreePath}
            onClick={() => {
              void useSessionStore.getState().openWorktreeConversation(entry.worktreePath)
                .catch((err) => rError('tabs', 'open worktree conversation failed', { error: String(err) }))
              onClose()
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <GitBranch size={14} color={colors.worktreeGreen} style={{ flexShrink: 0, marginRight: 8 }} />
            {/* Title-first, like every other worktree surface. The slug stays
                reachable through the row's `title` attribute (the worktree
                path), which is what the operator needs when picking a
                directory rather than picking work. */}
            <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{entry.title || entry.label}</span>
            {entry.isDirty && (
              <span style={{ fontSize: 10, color: colors.worktreeGreen, marginRight: 6 }}>dirty</span>
            )}
            {entry.needsSync && (
              <span style={{ fontSize: 10, color: colors.warningFg, marginRight: 6 }}>base moved</span>
            )}
            {openTab && (
              <span style={{ fontSize: 10, color: colors.accent }}>open</span>
            )}
          </div>
        )
      })}

      {(benchEntries.length > 0 || worktreeEntries.length > 0) && sortedDirs.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
      )}

      {sortedDirs.map((dir) => {
        const homePath = useSessionStore.getState().staticInfo?.homePath || ''
        const displayPath = homePath && dir.startsWith(homePath) ? '~' + dir.slice(homePath.length) : dir
        return (
          <div
            key={dir}
            className="flex items-center w-full rounded px-2 py-1.5"
            style={{
              fontSize: 12,
              color: colors.textPrimary,
              background: 'transparent',
              cursor: 'pointer',
            }}
            title={dir}
            onClick={() => { onSelectDir(dir); onClose() }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
          >
            <FolderOpen size={14} color={colors.textSecondary} style={{ flexShrink: 0, marginRight: 8 }} />
            <span style={{ whiteSpace: 'nowrap', flex: 1 }}>{displayPath}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                usePreferencesStore.getState().removeRecentBaseDirectory(dir)
              }}
              style={{
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: 2,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
                marginLeft: 8,
                opacity: 0.5,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.5' }}
              title="Remove from recents"
            >
              <Trash size={12} color={colors.textTertiary} />
            </button>
          </div>
        )
      })}
      {/* Separator when there are recent dirs */}
      {sortedDirs.length > 0 && (
        <div style={{ borderTop: `1px solid ${colors.popoverBorder}`, margin: '4px 0' }} />
      )}
      <div
        className="flex items-center w-full rounded px-2 py-1.5"
        style={{
          fontSize: 12,
          color: colors.textSecondary,
          background: 'transparent',
          cursor: 'pointer',
        }}
        onClick={() => { void handleChooseDirectory().catch((err) => rError('tabs', 'choose directory failed', { error: String(err) })) }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = colors.tabActive }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      >
        <FolderPlus size={14} color={colors.textTertiary} style={{ flexShrink: 0, marginRight: 8 }} />
        <span>Choose directory...</span>
      </div>
    </motion.div>,
    popoverLayer,
  )
}
