/**
 * snapshot-composer — what a phone's composer `+` menu offers in each
 * conversation, merged onto the snapshot so the menu is complete on first
 * paint. The server decides both lists; the phone derives neither.
 *
 * - Composer Actions: the board's answer for the tab
 *   (`server/src/engine/composer-actions.ts`).
 * - Quick Tools: the viewer's own Quick Tools that apply to the tab's working
 *   directory, by the same rule Studio's composer uses. Only id, name, and
 *   icon go out: `runQuickTool` looks the command up on the server by id, so
 *   a client never holds or supplies it.
 */
import { visibleUserQuickTools } from '@ion/shared/quick-tools-visible'
import type { QuickTool } from '@ion/shared/types-session'
import { composerActionsBoard } from '../engine/composer-actions-wiring'
import { readEffectiveSettings } from '../persistence/effective-settings'
import { debug } from '../logger'
import type { RemoteTabState } from './protocol'

function isQuickTool(value: unknown): value is QuickTool {
  const t = value as Partial<QuickTool> | null
  return !!t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.icon === 'string' && typeof t.command === 'string'
}

/** `subject`'s Quick Tools on this server; the ambient or local identity when unset. */
function quickToolsFor(subject: string | undefined): QuickTool[] {
  const raw: unknown = readEffectiveSettings(subject).quickTools
  return Array.isArray(raw) ? raw.filter(isQuickTool) : []
}

/**
 * Mutates the freshly-built tab array in place. A tab that offers nothing
 * gets no field, so an empty menu costs no bytes.
 */
export function applyComposerExtras(tabs: RemoteTabState[], subject: string | undefined): void {
  const tools = quickToolsFor(subject)
  let withActions = 0
  let withTools = 0
  for (const tab of tabs) {
    const actions = composerActionsBoard.actionsFor(tab.id)
    if (actions.length > 0) {
      tab.composerActions = actions
      withActions++
    }
    const visible = visibleUserQuickTools(tools, tab.workingDirectory)
    if (visible.length > 0) {
      tab.quickTools = visible.map(({ id, name, icon }) => ({ id, name, icon }))
      withTools++
    }
  }
  debug('desktop_snapshot', 'composer extras merged', {
    tab_count: tabs.length,
    tabs_with_actions: withActions,
    quick_tools: tools.length,
    tabs_with_quick_tools: withTools,
    subject: subject ?? '',
  })
}
