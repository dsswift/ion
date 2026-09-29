import { useSessionStore } from '@ion/server/store/sessionStore'
import { activeInstance } from '@ion/server/store/conversation-instance'
import { getDynamicContextWindow } from '@ion/server/store/model-labels'
import { useModelStore } from '@ion/server/store/model-store'
import { tabEnvironmentId } from '../studio/connection/tab-environment'
import { resolveContextInputs } from '../components/context-usage'
import { contextCapacityState, resolveContextCapacity, selectedModelContextLimit } from '@ion/shared/context-capacity'

/** Selected-model capacity for the active tab, shared by send admission and composer UI. */
export function useActiveContextCapacity(effectiveModelId: string) {
  const rawWindow = useSessionStore((state) => {
    const instance = activeInstance(state.conversationPanes, state.activeTabId ?? '')
    return getDynamicContextWindow(effectiveModelId, resolveContextInputs(instance).engineWindow)
  })
  const capacityLimit = useSessionStore((state) => {
    const instance = activeInstance(state.conversationPanes, state.activeTabId ?? '')
    const reportedLimit = instance?.statusFields?.contextEffectiveLimit
    if (reportedLimit && reportedLimit > 0) return reportedLimit
    const activeTab = state.tabs.find((t) => t.id === state.activeTabId)
    const model = useModelStore.getState().findModelIn(tabEnvironmentId(activeTab), effectiveModelId)
    return selectedModelContextLimit(rawWindow, model?.maxOutputTokens)
  })
  const tokens = useSessionStore((state) =>
    resolveContextInputs(activeInstance(state.conversationPanes, state.activeTabId ?? '')).tokens,
  )
  const capacity = resolveContextCapacity(tokens, capacityLimit)
  return { capacity, capacityLimit, state: contextCapacityState(capacity), tokens }
}
