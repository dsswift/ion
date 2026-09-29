// resolve-engine-model.ts — the model a tab is effectively using, by tab id.
//
// A lookup over the one resolver (model-resolution.ts), for callers that hold
// a tab id rather than the tab: the phone's create echo is one. It reads the
// live store, so it answers from the same conversation state the send path
// does and cannot disagree with it.

import { useSessionStore } from './store/sessionStore'
import { activeInstance } from './store/conversation-instance'
import { resolveModelForTab } from './model-resolution'
import { debug } from './logger'

/** Empty means "no client-side choice": the engine applies its own configured default, or refuses. */
export function resolveEngineModel(tabId: string, instanceId?: string | null): string {
  const state = useSessionStore.getState()
  const tab = state.tabs.find((t) => t.id === tabId)
  if (!tab) {
    debug('main', 'resolve_engine_model', { tab_id: tabId, instance_id: instanceId ?? null, source: 'no-tab', model: '' })
    return ''
  }
  const pane = state.conversationPanes.get(tabId)
  const inst = (instanceId ? pane?.instances.find((i) => i.id === instanceId) : undefined) ?? activeInstance(state.conversationPanes, tabId)
  const resolved = resolveModelForTab(tab, inst)
  debug('main', 'resolve_engine_model', {
    tab_id: tabId, instance_id: instanceId ?? null, source: resolved.source, model: resolved.model,
  })
  return resolved.model
}
