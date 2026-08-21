import { useSessionStore } from '../stores/sessionStore'
import { activeInstance } from '../stores/conversation-instance'
import { getDynamicContextWindow } from '../stores/model-labels'
import { useModelStore } from '../stores/model-store'
import { resolveContextInputs } from '../components/context-usage'
import { contextCapacityState, resolveContextCapacity, selectedModelContextLimit } from '../../shared/context-capacity'

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
    const model = useModelStore.getState().findModel(effectiveModelId)
    return selectedModelContextLimit(rawWindow, model?.maxOutputTokens)
  })
  const tokens = useSessionStore((state) =>
    resolveContextInputs(activeInstance(state.conversationPanes, state.activeTabId ?? '')).tokens,
  )
  const capacity = resolveContextCapacity(tokens, capacityLimit)
  return { capacity, capacityLimit, state: contextCapacityState(capacity), tokens }
}
