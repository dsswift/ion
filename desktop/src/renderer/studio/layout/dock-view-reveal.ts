/**
 * Left-dock view selection.
 *
 * The numbered chords (Mod+1/2/3) name a DESTINATION, so selecting a view is
 * idempotent: it reveals the dock on that view and never closes it. Closing is
 * the sole job of the sidebar toggle, so exactly one chord owns the visible
 * state and repeat presses cannot pull the panel out from under the operator.
 *
 * The patch is computed here rather than in the shell so the rule is testable
 * without mounting Studio.
 */

import type { StudioLayout, StudioSidebarView } from '../../../shared/types-studio'

/** The layout fields a dock reveal reads. */
type DockLayout = Pick<StudioLayout, 'leftSidebarVisible' | 'leftSidebarView'>

export interface DockRevealResult {
  patch: Pick<StudioLayout, 'leftSidebarVisible' | 'leftSidebarView'>
  /** True when the dock was closed and this reveal opens it. */
  revealedSidebar: boolean
  /** True when the requested view was already the one on screen. */
  alreadyActive: boolean
}

/**
 * The layout patch that reveals `view`.
 *
 * `leftSidebarVisible` is always true in the result: there is no input state
 * for which selecting a view should hide the dock. In inbox nav mode the shell
 * force-opens the dock anyway, so a close written here would be immediately
 * overridden by render and leave persisted layout disagreeing with the screen.
 */
export function revealDockView(layout: DockLayout, view: StudioSidebarView): DockRevealResult {
  return {
    patch: { leftSidebarVisible: true, leftSidebarView: view },
    revealedSidebar: !layout.leftSidebarVisible,
    alreadyActive: layout.leftSidebarVisible && layout.leftSidebarView === view,
  }
}
