/**
 * The owner's `studio:tabs-sync` push carries the same tab records it writes
 * to `tabs.json`, minus what no client reads from it.
 *
 * A conversation instance persists its sub-agent roster (`agentStates`) and
 * dispatch records (`dispatchTelemetry`) so a restart can restore them. A
 * client never takes either from this push: it builds a conversation's
 * sub-agents from the live engine agent-state events. Both carry each
 * sub-agent's full task prompt, so on a server with many dispatches they were
 * most of the push, resent to every client on every tab change.
 */
import type { PersistedTab } from './types-persistence'

export function tabForStudioSync(tab: PersistedTab): PersistedTab {
  const pane = tab.conversationPane
  if (!pane?.instances.some((inst) => inst.agentStates !== undefined || inst.dispatchTelemetry !== undefined)) return tab
  return {
    ...tab,
    conversationPane: {
      ...pane,
      instances: pane.instances.map(({ agentStates: _agentStates, dispatchTelemetry: _dispatchTelemetry, ...kept }) => kept),
    },
  }
}
