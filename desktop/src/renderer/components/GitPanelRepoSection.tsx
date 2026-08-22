/**
 * GitPanelRepoSection — one repo's Changes zone inside the git panel:
 * collapsible header (caret, repo basename, branch, change-count badge,
 * per-repo refresh) + the existing CommitForm and GitChangesSection (both
 * already directory-scoped, reused as-is).
 *
 * The multi-repo git panel renders one of these per workspace repo
 * ([primaryRepo, ...secondaryRepos]); collapse state persists per-repo via
 * the gitPanelRepoSectionsCollapsed preference. Each section subscribes to
 * its own repo through the refcounted useGitRepo (same-window collisions
 * fixed in the F5 commit).
 */
import React, { useCallback, useEffect, useMemo } from 'react'
import { ArrowsClockwise } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import { useColors } from '../theme'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { transitions } from '../theme-tokens'
import { Chevron } from './Chevron'
import { useRepoState } from '../stores/git'
import { useGitRepo } from '../hooks/useGitRepo'
import { GitChangesSection } from './GitChangesSection'
import { CommitForm } from './git/CommitForm'
import { SECTION_HEADER } from './git/paneLayout'
import { rDebug, rError } from '../rendererLogger'

function HeaderIconButton({
  title,
  onClick,
  colors,
  children,
}: {
  title: string
  onClick: (e: React.MouseEvent) => void
  colors: ReturnType<typeof useColors>
  children: React.ReactNode
}) {
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      title={title}
      onClick={onClick}
      className="ion-focusable p-0.5 rounded"
      {...handlers}
      style={{
        color: hover ? colors.accent : colors.textTertiary,
        cursor: 'pointer',
        border: 'none',
        background: interactiveBg(colors, { hover: false, pressed }),
        transition: `color ${transitions.base}, background ${transitions.base}`,
        display: 'flex',
        alignItems: 'center',
      }}
    >
      {children}
    </button>
  )
}

export interface GitPanelRepoSectionProps {
  directory: string
  isPrimary: boolean
  /** Body height when expanded (from the pane layout); primary only. */
  bodyHeight?: number
  onFileDiffClick?: (target: { repoDir: string; filePath: string; staged: boolean }) => boolean
}

export function GitPanelRepoSection(props: GitPanelRepoSectionProps): React.JSX.Element {
  const { directory, isPrimary } = props
  const colors = useColors()
  const collapsedMap = usePreferencesStore((s) => s.gitPanelRepoSectionsCollapsed)
  const setCollapsed = usePreferencesStore((s) => s.setGitPanelRepoSectionCollapsed)
  // Primary repos default expanded, secondary repos default collapsed —
  // the persisted map overrides either way.
  const collapsed = collapsedMap[directory] ?? !isPrimary
  const gitChangesTreeView = usePreferencesStore((s) => s.gitChangesTreeView)
  const activeTabId = useSessionStore((s) => s.activeTabId)
  const commitCommand = usePreferencesStore((s) => s.commitCommand)

  // Per-section subscription (refcounted — safe beside StatusBar's).
  useGitRepo(directory, true)
  const repoState = useRepoState(directory)
  const files = useMemo(() => repoState?.files ?? [], [repoState?.files])
  const stagedCount = useMemo(() => files.filter((f) => f.staged).length, [files])

  const refresh = useCallback(() => {
    window.ion.gitRefresh(directory).catch((err) => rDebug('git', 'gitRefresh failed', { directory, error: String(err) }))
  }, [directory])

  // Fresh snapshot whenever the section expands (watcher is best-effort).
  useEffect(() => {
    if (!collapsed) refresh()
  }, [collapsed, refresh])

  const handleQuickCommit = useCallback(() => {
    if (commitCommand) {
      const safeCwd = directory.replace(/'/g, "'\\''")
      useSessionStore.getState().runInTerminal(activeTabId, `cd '${safeCwd}' && ${commitCommand}`)
    } else {
      useSessionStore.getState().submit(activeTabId, 'commit the current changes')
    }
  }, [commitCommand, directory, activeTabId])

  const baseName = directory.split('/').filter(Boolean).pop() || directory
  const { hover, pressed, handlers } = useInteractiveState()

  return (
    <div className="flex flex-col" style={{ flexShrink: 0, overflow: 'hidden', minHeight: 0, ...(collapsed ? {} : { flex: 1 }) }}>
      <div
        className="flex items-center gap-1 px-2.5"
        style={{
          height: SECTION_HEADER,
          background: colors.surfacePrimary,
          borderBottom: `1px solid ${colors.containerBorder}`,
          color: colors.textSecondary,
          fontSize: 11,
          flexShrink: 0,
        }}
      >
        <button
          onClick={() => setCollapsed(directory, !collapsed)}
          className="flex items-center gap-1 ion-focusable"
          {...handlers}
          style={{
            color: 'inherit',
            padding: 0,
            borderRadius: 4,
            border: 'none',
            cursor: 'pointer',
            background: interactiveBg(colors, { hover, pressed }),
            transition: `background ${transitions.base}`,
            overflow: 'hidden',
          }}
        >
          <Chevron open={!collapsed} size={10} weight="regular" />
          <span style={{ fontWeight: isPrimary ? 600 : 400, whiteSpace: 'nowrap' }}>{baseName}</span>
          {repoState?.branch && (
            <span style={{ color: colors.textTertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {repoState.branch}
            </span>
          )}
        </button>
        {files.length > 0 && (
          <span className="text-[9px] px-1 rounded-full" style={{ background: colors.accentLight, color: colors.accent }}>
            {files.length}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <HeaderIconButton title={`Refresh ${baseName}`} onClick={(e) => { e.stopPropagation(); refresh() }} colors={colors}>
          <ArrowsClockwise size={11} />
        </HeaderIconButton>
      </div>
      {!collapsed && (
        <div style={{ ...(props.bodyHeight != null ? { height: props.bodyHeight } : { flex: 1, minHeight: 0 }), display: 'flex', flexDirection: 'column' }}>
          <CommitForm
            directory={directory}
            branch={repoState?.branch ?? ''}
            stagedCount={stagedCount}
            onCommit={async (message, amend, opts) => {
              const result = await window.ion.gitCommit(directory, message, { amend, signoff: opts?.signoff, gpg: opts?.gpg })
              if (result.ok) { refresh(); return true }
              return false
            }}
            onQuickCommit={handleQuickCommit}
            onPush={() => {
              void (async () => {
                await window.ion.gitPush(directory)
                refresh()
              })().catch((err) => rError('git-panel', 'push failed', { error: String(err) }))
            }}
          />
          <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            <GitChangesSection
              directory={directory}
              files={files}
              onRefresh={refresh}
              treeView={gitChangesTreeView}
              onFileDiffClick={props.onFileDiffClick}
            />
          </div>
        </div>
      )}
    </div>
  )
}
