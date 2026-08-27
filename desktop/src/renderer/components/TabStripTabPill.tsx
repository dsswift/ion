import React, { useCallback } from 'react'
import { X, GitBranch, GitFork, FolderSimple, PushPin, Warning } from '@phosphor-icons/react'
import { useColors } from '../theme'
import { usePreferencesStore } from '../preferences'
import { useSessionStore } from '../stores/sessionStore'
import type { TabState } from '../../shared/types'
import {
  waitingStateOfPane, isAnyEngineInstanceRunning, anyEngineInstanceHasRunningChildren,
  anyEngineInstanceHasRunningShells,
  isAnyTerminalCommandRunning,
  formatRelativeShort, abbreviateProfileName, resolveTabModelFallback, getTabStatusColor,
} from './TabStripShared'
import { activeInstanceOfPane } from '../stores/conversation-instance'
import { useQuestionsStore } from '../stores/questions-store'
import { useInteractiveState, interactiveBg } from '../hooks/useInteractiveState'
import { StatusDot } from './TabStripStatusDot'
import { InlineRenameInput } from './TabStripInlineRenameInput'

interface TabPillProps {
  tab: TabState
  isActive: boolean
  isEditing: boolean
  onSelect: () => void
  onClose: () => void
  onStartEdit: () => void
  onStopEdit: () => void
  onRename: (newValue: string | null) => void
  onSetPillColor: (color: string | null) => void
  colorPickerTabId: string | null
  onOpenColorPicker: (tabId: string, anchor: { x: number; y: number }) => void
  onCloseColorPicker: () => void
  onOpenDirMenu: (tabId: string, anchor: { x: number; y: number }) => void
  onCreateTabInDir: (dir: string) => void
  dirMenuTabId: string | null
  onOpenTabMenu: (tabId: string, anchor: { x: number; y: number }) => void
  tabRefs: React.MutableRefObject<Map<string, HTMLDivElement>>
  onDragPointerDown: (key: string, e: React.PointerEvent) => void
  isDraggingRef: React.RefObject<boolean>
}

/** A single (un-grouped) tab pill rendered in the flat tab strip. Owns interaction (select, close, drag, context menus) but not the popovers themselves — the parent renders those. */
export function TabPill({
  tab,
  isActive,
  isEditing,
  onSelect,
  onClose,
  onStartEdit,
  onStopEdit,
  onRename,
  onOpenColorPicker,
  onOpenDirMenu,
  onOpenTabMenu,
  tabRefs,
  onDragPointerDown,
  isDraggingRef,
}: TabPillProps) {
  const colors = useColors()
  const gitOpsMode = usePreferencesStore((s) => s.gitOpsMode)
  const tabGroupMode = usePreferencesStore((s) => s.tabGroupMode)
  // Pointer states: one hook for the pill surface, one for the close-X.
  const pillState = useInteractiveState()
  const closeState = useInteractiveState()
  // Resolve the profile name for the harness badge. DATA-driven: the badge
  // renders iff the tab carries an engineProfileId (a resolvable harness name),
  // not because of a tab-type branch. A plain conversation carries no profile
  // id, so it has no harness name and shows no badge — purely by absence of
  // data. Subscribe narrowly so the pill only re-renders when engine profiles
  // change. Falls back to 'EXT' if the profile id has no matching entry
  // (deleted profile, pre-Phase-2 tab).
  const harnessBadgeLabel = usePreferencesStore((s) => {
    if (!tab.engineProfileId) return null
    const profile = s.engineProfiles.find((p) => p.id === tab.engineProfileId)
    return abbreviateProfileName(profile?.name)
  })

  // Subscribe to THIS TAB'S pane so the pill re-renders when its own engine
  // instance changes — statusFields, agentStates, permissionDenied and
  // permissionQueue all live on the instance. Subscribing to the whole
  // conversationPanes map instead would re-render every pill in the strip
  // whenever any conversation streamed, which is how one busy tab pinned the
  // renderer's main thread with many tabs open.
  const pane = useSessionStore((s) => s.conversationPanes.get(tab.id))

  // Model-fallback warning for this tab's active instance. The engine emits
  // engine_model_fallback when a requested model is unavailable and it runs
  // with the configured default instead; the desktop's policy is to surface
  // a small ⚠ on the affected tab pill (the iOS counterpart renders the same
  // glyph on its EngineInstanceBar — see AGENTS.md parity table). Derived via
  // the shared resolveTabModelFallback so the component and its test share one
  // derivation. Subscribe narrowly so the pill only re-renders when this tab's
  // fallback state changes. Cleared on the next idle transition.
  const modelFallback = useSessionStore((s) =>
    resolveTabModelFallback(s.conversationPanes, s.engineModelFallbacks, tab.id),
  )

  const isRunning = tab.status === 'running' || tab.status === 'connecting'
  const displayTitle = tab.customTitle || tab.title

  // Active instance for this tab (the single `main` instance for normal
  // tabs). Holds the permission queue that used to live on TabState.
  const inst = activeInstanceOfPane(pane)
  const _hasPermission = (inst?.permissionQueue.length ?? 0) > 0

  // DATA-driven (not tab-type): does ANY instance of this tab have a running
  // run / running dispatched children? A plain conversation has one instance
  // and can dispatch background agents too, so we fold across instances for
  // every tab. The helpers read the tab's pane regardless of tab type.
  const anyInstanceRunning = isAnyEngineInstanceRunning(tab.id)
  // Parallel "any instance has running dispatched background children" —
  // drives the yellow "awaiting children" dot and the hard-block on the X
  // close button. Foreground orange wins over background yellow.
  const anyInstanceHasRunningChildren = anyEngineInstanceHasRunningChildren(tab.id)
  // Parallel "any instance is waiting on background bash commands" — drives
  // the pink shell dot and the same close hard-block. Closing the tab kills
  // those shell processes, so an outstanding command blocks close exactly as a
  // running child does.
  const anyInstanceHasRunningShells = anyEngineInstanceHasRunningShells(tab.id) || isAnyTerminalCommandRunning(tab.id)
  const _effectiveStatus = (anyInstanceRunning && !isRunning) ? 'running' as const : tab.status
  // Combined "must not close" predicate. Hard-blocks the X close
  // button below. Mirrors the action-layer guard in tab-slice.ts
  // closeTab so every entry point — UI affordance, keyboard shortcut,
  // programmatic call — refuses to destroy a tab whose orchestrator
  // is running, whose dispatched background agents are still
  // executing, or which is waiting on background bash commands. The
  // user must stop the tab first.
  const closeBlocked = isRunning || anyInstanceHasRunningChildren || anyInstanceHasRunningShells

  // Derive waiting-for-user state from permission denials AND from an open
  // Guided Questions round (which is deliberately absent from
  // permissionDenied — see waitingStateOfPane).
  //
  // Subscribing to `workflows` is what makes the rim appear the moment a
  // question round opens: waitingStateOfPane reads the questions store
  // non-reactively, so without this the pill would only pick the change up on
  // an unrelated re-render.
  useQuestionsStore((s) => s.workflows)
  const waitingState = waitingStateOfPane(pane, tab.id)

  // Waiting-state border color (thin rim, no boxShadow bleed)
  const waitingBorder = waitingState === 'plan-ready'
    ? colors.tabGlowPlanReady
    : waitingState === 'question'
      ? colors.tabGlowQuestion
      : null

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Middle-click close. Honors the same closeBlocked predicate as the
    // X button below — never allow middle-click to bypass the guard
    // when an orchestrator is running OR dispatched background agents
    // are still in flight.
    //
    // Worktree tabs are NOT excluded. They were, back when close ran
    // gitWorktreeRemove(force=true) + `git branch -D` and a stray click
    // destroyed work. Close has been non-destructive since the worktree
    // lifecycle split (a worktree outlives its conversations; removal is the
    // explicit Retire verb), so the exclusion was a guard for a defect that no
    // longer exists — it just left worktree tabs with no close affordance.
    if (e.button === 1) { e.preventDefault(); if (!closeBlocked && !tab.bashExecuting) onClose(); return }
    if (e.button !== 0) return
    onDragPointerDown(tab.id, e)
  }, [onClose, onDragPointerDown, tab.id, tab.bashExecuting, closeBlocked])

  return (
    <div
      ref={(el: HTMLDivElement | null) => {
        if (el) tabRefs.current.set(tab.id, el)
        else tabRefs.current.delete(tab.id)
      }}
      style={{ flexShrink: 0 }}
    >
      <div
        onClick={() => { if (isDraggingRef.current) return; onSelect() }}
        onPointerDown={onPointerDown}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onOpenTabMenu(tab.id, { x: e.clientX, y: e.clientY }) }}
        {...pillState.handlers}
        className={`group flex items-center gap-1.5 cursor-pointer select-none ion-focusable ${
          isEditing ? '' : 'max-w-[240px]'
        } ${waitingBorder ? 'animate-border-pulse' : ''}`}
        style={{
          '--border-waiting': waitingBorder ?? 'transparent',
          '--border-default': tab.pillColor
            ? `${tab.pillColor}${isActive ? '40' : '25'}`
            : isActive ? colors.tabActiveBorder : 'transparent',
          // Background cascade: the active pill keeps its dedicated
          // tabActive/tabActiveBorder treatment; inactive pills answer to the
          // pointer (pressed > hover > transparent). A user pill color keeps
          // the runtime `${pillColor}NN` alpha-concat pattern, deepening
          // 10 → 18 on hover.
          background: tab.pillColor
            ? `${tab.pillColor}${isActive || pillState.hover ? '18' : '10'}`
            : isActive
              ? colors.tabActive
              : pillState.pressed
                ? colors.surfacePressed
                : pillState.hover
                  ? colors.tabHover
                  : 'transparent',
          borderWidth: 1,
          borderStyle: 'solid',
          borderColor: waitingBorder
            ?? (tab.pillColor ? `${tab.pillColor}${isActive ? '40' : '25'}` : isActive ? colors.tabActiveBorder : 'transparent'),
          borderRadius: 9999,
          padding: '4px 10px',
          fontSize: 12,
          color: isActive ? colors.textPrimary : colors.textTertiary,
          fontWeight: isActive ? 500 : 400,
        } as React.CSSProperties}
      >
      <span
        className="flex-shrink-0 inline-flex"
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onOpenColorPicker(tab.id, { x: e.clientX, y: e.clientY })
        }}
      >
        <StatusDot derived={getTabStatusColor(tab, colors)} pillIcon={tab.pillIcon} />
      </span>
      {harnessBadgeLabel !== null && (
        // Harness badge: abbreviated profile name in an accent-tinted chip.
        // Shown iff harnessBadgeLabel is non-null, i.e. the tab carries an
        // engineProfileId (data). A plain conversation has none and shows no
        // badge — by absence of data, not a tab-type branch.
        // Style spec: 4px border-radius, accent bg/border/text at 25/40/100%
        // opacity, 9px/600 weight, flex-shrink-0 so it never collapses.
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: colors.accent,
            background: `${colors.accent}25`,
            border: `1px solid ${colors.accent}40`,
            borderRadius: 4,
            padding: '1px 3px',
            lineHeight: 1.4,
            letterSpacing: '0.02em',
          }}
        >
          {harnessBadgeLabel}
        </span>
      )}
      {modelFallback && (
        // Model-fallback ⚠: the requested model was unavailable and the tab
        // is running with the configured default. Mirrors the iOS
        // EngineInstanceBar indicator (AGENTS.md parity table). The title
        // attribute carries the requested-vs-fallback detail on hover.
        <span
          className="flex-shrink-0 inline-flex"
          data-testid={`model-fallback-warning-${tab.id}`}
          title={`Requested model "${modelFallback.requestedModel}" not configured; running with default "${modelFallback.fallbackModel}"`}
          style={{ color: colors.accent }}
        >
          <Warning size={11} weight="fill" />
        </span>
      )}
      {tab.groupPinned && tabGroupMode === 'manual' && (
        <PushPin size={10} color={colors.textTertiary} className="flex-shrink-0" style={{ opacity: 0.7 }} />
      )}
      {tab.forkedFromSessionId && !tab.worktree ? (
        <GitFork size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : tab.worktree ? (
        <GitBranch size={11} color={colors.worktreeGreen} style={{ opacity: 0.7 }} className="flex-shrink-0" />
      ) : gitOpsMode === 'worktree' ? (
        <FolderSimple size={11} color={colors.textTertiary} className="flex-shrink-0" />
      ) : null}
      {tab.workingDirectory && (
        <span
          className="flex-shrink-0"
          style={{
            fontSize: 10,
            fontWeight: 500,
            color: tab.worktree ? colors.worktreeGreen : colors.textSecondary,
            opacity: tab.worktree ? 0.6 : 0.5,
            cursor: 'default',
          }}
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onOpenDirMenu(tab.id, { x: e.clientX, y: e.clientY })
          }}
        >
          {tab.workingDirectory.split('/').pop() || tab.workingDirectory}
        </span>
      )}
      {isEditing ? (
        <InlineRenameInput
          value={displayTitle}
          color={isActive ? colors.textPrimary : colors.textTertiary}
          fontWeight={isActive ? 500 : 400}
          onCommit={(newValue) => {
            onStopEdit()
            onRename(newValue || null)
          }}
          onCancel={onStopEdit}
        />
      ) : (
        <span
          className="flex-1 min-w-0 flex flex-col items-start leading-tight"
          onContextMenu={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onStartEdit()
          }}
          title={tab.lastMessagePreview ?? undefined}
        >
          <span className="truncate w-full">{displayTitle}</span>
          {tab.lastMessagePreview && (
            <span
              className="truncate w-full text-[9px]"
              style={{ color: colors.textTertiary }}
            >
              {tab.lastMessagePreview}
              {tab.lastEventAt ? ` · ${formatRelativeShort(tab.lastEventAt)}` : ''}
            </span>
          )}
        </span>
      )}
      {!closeBlocked && (
        // Hide the X close button while the orchestrator is running OR
        // dispatched background children are still executing. The user
        // must explicitly stop the tab (via the in-pane Interrupt
        // button or by waiting for completion) before close becomes
        // available. Mirrors the action-layer guard in tab-slice.ts
        // closeTab — UI and action layer enforce the same rule.
        //
        // Worktree tabs get the button too. It was suppressed for them while
        // close still force-removed the worktree; close is non-destructive now,
        // so the suppression only served to leave those tabs uncloseable from
        // the strip.
        <button
          onClick={(e) => { e.stopPropagation(); onClose() }}
          className="flex-shrink-0 rounded-full w-4 h-4 flex items-center justify-center transition-opacity ion-focusable"
          style={{
            opacity: closeState.hover ? 1 : isActive ? 0.5 : 0,
            color: colors.textSecondary,
            background: interactiveBg(colors, closeState),
          }}
          {...closeState.handlers}
        >
          <X size={10} />
        </button>
      )}
      </div>
    </div>
  )
}
