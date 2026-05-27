import type React from 'react'
import { Diamond, Square, StarFour, Triangle, Heart, Hexagon, Lightning, Terminal } from '@phosphor-icons/react'
import { useSessionStore } from '../stores/sessionStore'
import { usePreferencesStore } from '../preferences'
import type { useColors } from '../theme'
import type { TabState } from '../../shared/types'

/** Pill background-color presets shown in the color picker. `null` means "use theme default". */
export const PILL_COLOR_PRESETS = [
  { color: null, label: 'Default' },
  { color: '#f08c4a', label: 'Orange' },
  { color: '#4ece78', label: 'Green' },
  { color: '#ef5350', label: 'Red' },
  { color: '#42a5f5', label: 'Blue' },
  { color: '#b06de8', label: 'Purple' },
  { color: '#f5c842', label: 'Gold' },
] as const

/** Pill status-icon presets shown in the icon picker. `null` means "use the default dot". */
export const PILL_ICON_PRESETS = [
  { icon: null, label: 'Default' },
  { icon: 'diamond', label: 'Diamond' },
  { icon: 'square', label: 'Square' },
  { icon: 'star', label: 'Star' },
  { icon: 'triangle', label: 'Triangle' },
  { icon: 'heart', label: 'Heart' },
  { icon: 'hexagon', label: 'Hexagon' },
  { icon: 'lightning', label: 'Lightning' },
] as const

/** Maps the persisted `pillIcon` string to a Phosphor icon component. */
export const PILL_ICON_MAP: Record<string, React.ComponentType<any>> = {
  diamond: Diamond,
  square: Square,
  star: StarFour,
  triangle: Triangle,
  heart: Heart,
  hexagon: Hexagon,
  lightning: Lightning,
  Terminal,
}

/** Adjust viewport rect to zoomed coordinate space for fixed positioning.
 * getBoundingClientRect() returns viewport pixels, but position:fixed inside
 * a CSS-zoomed root interprets coordinates in the zoomed space. Dividing by
 * zoom cancels the double-scaling. */
export function zoomRect(rect: DOMRect): DOMRect {
  const z = usePreferencesStore.getState().uiZoom
  if (z === 1) return rect
  return new DOMRect(rect.x / z, rect.y / z, rect.width / z, rect.height / z)
}

/** Return viewport dimensions in zoom-adjusted coordinate space. */
export function zoomViewport(): { width: number; height: number } {
  const z = usePreferencesStore.getState().uiZoom
  return { width: window.innerWidth / z, height: window.innerHeight / z }
}

/** Decide whether a tab-creation event should use worktree mode. Holding Alt inverts the default. */
export const shouldUseWorktree = (altKey: boolean): boolean => {
  const gitOpsMode = usePreferencesStore.getState().gitOpsMode
  return altKey ? gitOpsMode !== 'worktree' : gitOpsMode === 'worktree'
}

/** On-demand uncommitted check for worktree tabs whose status isn't in the map yet. */
export function checkWorktreeUncommitted(tab: TabState | undefined): void {
  if (!tab?.worktree) return
  const { worktreeUncommittedMap, setWorktreeUncommitted } = useSessionStore.getState()
  if (worktreeUncommittedMap.has(tab.id)) return
  window.ion.gitChanges(tab.workingDirectory).then((result) => {
    setWorktreeUncommitted(tab.id, result.files.length > 0)
  }).catch(() => {})
}

/** Compact relative-time formatter for tab-pill subtitles. */
export function formatRelativeShort(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return 'now'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h`
  return `${Math.floor(d / 86_400_000)}d`
}

/** Tristate "waiting for the user" derived from queued permission denials. */
export type WaitingState = 'plan-ready' | 'question' | null

/** Derive the waiting state from a denial-tools array. Returns 'question'
 *  if any tool is AskUserQuestion, else 'plan-ready' if any is
 *  ExitPlanMode, else null. Shared by both CLI and engine paths. */
function waitingStateFromTools(
  tools: ReadonlyArray<{ toolName: string }> | undefined | null,
): WaitingState {
  if (!tools?.length) return null
  if (tools.some((t) => t.toolName === 'AskUserQuestion')) return 'question'
  if (tools.some((t) => t.toolName === 'ExitPlanMode')) return 'plan-ready'
  return null
}

/**
 * Derive the waiting state from a tab's pending denials.
 *
 * - CLI tabs: read from `tab.permissionDenied`.
 * - Engine tabs (`tab.isEngine === true`): fold across every engine
 *   instance under this tab in `state.enginePermissionDenied`, returning
 *   the worst-priority waiting state ('question' > 'plan-ready' > null).
 *
 * Engine sub-tabs (instances) are independent sub-conversations and
 * each may have its own pending question or plan card. Parent-pill
 * glow must surface "any sub-tab is blocked," so we walk the per-
 * instance map keyed by `${tabId}:${instanceId}`.
 */
export function getWaitingState(tab: TabState): WaitingState {
  if (tab.isEngine) {
    // Read the store directly. This is invoked from render callsites
    // that already subscribe to the parts of state that change the
    // map's identity (enginePermissionDenied / enginePanes), so this
    // is consistent at render time.
    const s = useSessionStore.getState()
    const pane = s.enginePanes.get(tab.id)
    if (!pane || pane.instances.length === 0) return null
    let hasPlanReady = false
    for (const inst of pane.instances) {
      const entry = s.enginePermissionDenied.get(`${tab.id}:${inst.id}`)
      const ws = waitingStateFromTools(entry?.tools)
      if (ws === 'question') return 'question'
      if (ws === 'plan-ready') hasPlanReady = true
    }
    return hasPlanReady ? 'plan-ready' : null
  }
  return waitingStateFromTools(tab.permissionDenied?.tools)
}

/** Same tristate logic as `getWaitingState`, but for a single engine
 *  instance identified by its compound `${tabId}:${instanceId}` key.
 *  Used by the engine sub-tab pill renderer to draw a per-instance
 *  status dot. */
export function getEngineInstanceWaitingState(key: string): WaitingState {
  const entry = useSessionStore.getState().enginePermissionDenied.get(key)
  return waitingStateFromTools(entry?.tools)
}

/** Status-dot color/pulse/glow derived from a tab's runtime state. Used by both single dots and stacked group dots. */
export function getTabStatusColor(
  tab: TabState,
  colors: ReturnType<typeof useColors>,
): { bg: string; pulse: boolean; glow: boolean; glowColor: string } {
  let bg = colors.statusIdle
  let pulse = false
  let glow = false
  let glowColor = colors.statusPermissionGlow

  const waitingState = getWaitingState(tab)

  if (tab.status === 'dead' || tab.status === 'failed') {
    bg = colors.statusError
  } else if (tab.permissionQueue.length > 0) {
    bg = colors.statusPermission; glow = true
  } else if (waitingState === 'plan-ready') {
    bg = colors.statusComplete; glow = true; glowColor = colors.tabGlowPlanReady
  } else if (waitingState === 'question') {
    bg = colors.infoText; glow = true; glowColor = colors.tabGlowQuestion
  } else if (tab.status === 'connecting' || tab.status === 'running') {
    bg = colors.statusRunning; pulse = true
  } else if (tab.bashExecuting) {
    bg = colors.statusBash; pulse = true; glow = true; glowColor = colors.statusBashGlow
  } else if (tab.hasUnread) {
    bg = colors.statusComplete
  }

  return { bg, pulse, glow, glowColor }
}
