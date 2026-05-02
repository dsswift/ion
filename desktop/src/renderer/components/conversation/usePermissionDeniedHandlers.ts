import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { serializeConversation } from './serializeConversation'
import type { TabState, Attachment } from '../../../shared/types'

interface Handlers {
  onDismiss: () => void
  onAnswer: (answer: string) => void
  onApprove: (toolNames: string[]) => void
  onImplement: (clearContext: boolean) => Promise<void>
}

/**
 * Build the four PermissionDeniedCard callbacks for the active tab. The
 * `onImplement` handler does the most work: it starts a fresh session, optionally
 * clears UI state, reads the plan file, and seeds the next prompt with prior
 * conversation context so the model has full history without plan-mode patterns.
 */
export function buildPermissionDeniedHandlers(
  tab: TabState,
  sendMessage: (
    content: string,
    workingDir?: string,
    attachments?: Attachment[],
    appendSystemPrompt?: string,
  ) => void,
): Handlers {
  const dismissPermissionDenied = () => {
    useSessionStore.setState((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tab.id ? { ...t, permissionDenied: null } : t
      ),
    }))
  }

  const onDismiss = dismissPermissionDenied

  const onAnswer = (answer: string) => {
    dismissPermissionDenied()
    // Resume session with the answer (no mode change, no context clear)
    sendMessage(answer)
  }

  const onApprove = (toolNames: string[]) => {
    // Approve the denied tools for future runs on this tab
    window.ion.approveDeniedTools(tab.id, toolNames)
    dismissPermissionDenied()
    // Tell the agent to retry
    sendMessage('The denied tools have been approved. Please retry the operation.')
  }

  const onImplement = async (clearContext: boolean) => {
    dismissPermissionDenied()
    // Switch to auto mode for implementation
    useSessionStore.getState().setPermissionMode('auto', 'plan_approved')

    // Auto-move tab to in-progress group if designated
    const { inProgressGroupId, tabGroupMode, autoGroupMovement } = usePreferencesStore.getState()
    if (autoGroupMovement && inProgressGroupId && tabGroupMode === 'manual' && tab.groupId !== inProgressGroupId) {
      useSessionStore.getState().moveTabToGroup(tab.id, inProgressGroupId)
    }

    let implementPrompt = 'Implement the plan'

    // Extract plan file path: tab state (engine event) > denial toolInput
    let planFilePath: string | null = tab.planFilePath || null

    if (!planFilePath && tab.permissionDenied?.tools) {
      const exitDenial = tab.permissionDenied.tools.find(
        (t) => t.toolName === 'ExitPlanMode' && t.toolInput
      )
      if (exitDenial?.toolInput?.planFilePath) {
        planFilePath = exitDenial.toolInput.planFilePath as string
      }
    }

    // Read plan content for both paths
    let planContent: string | null = null
    if (planFilePath) {
      try {
        const result = await window.ion.readPlan(planFilePath)
        planContent = result.content
      } catch (err) {
        console.warn('Failed to read plan file:', err)
      }
    }

    // Both paths start a fresh session to break out of plan mode.
    window.ion.resetTabSession(tab.id)

    if (clearContext) {
      // Clear UI messages
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                messages: [],
                historicalSessionIds: [
                  ...t.historicalSessionIds,
                  ...(t.conversationId && !t.historicalSessionIds.includes(t.conversationId)
                    ? [t.conversationId] : []),
                ],
                conversationId: null,
                lastResult: null,
                currentActivity: '',
                permissionQueue: [],
                permissionDenied: null,
                queuedPrompts: [],
              }
            : t
        ),
      }))

      if (planContent) {
        implementPrompt = `Implement the following plan:\n\n${planContent}`
      }
    } else {
      // Keep UI messages but start fresh Claude session.
      // Conversation context goes via system prompt (invisible to user).
      useSessionStore.setState((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                historicalSessionIds: [
                  ...t.historicalSessionIds,
                  ...(t.conversationId && !t.historicalSessionIds.includes(t.conversationId)
                    ? [t.conversationId] : []),
                ],
                conversationId: null,
              }
            : t
        ),
      }))

      if (planContent) {
        implementPrompt = `Implement the following plan:\n\n${planContent}`
      }
    }

    // Build plan attachment for the message
    const planAttachment = planFilePath ? [{
      id: crypto.randomUUID(),
      type: 'plan' as const,
      name: planFilePath.split('/').pop() || 'plan.md',
      path: planFilePath,
    }] : undefined

    // For non-clear-context, inject prior conversation as system prompt context
    // so the model has full history without plan-mode patterns, but the user
    // only sees "Implement the plan".
    const contextPrompt = !clearContext
      ? serializeConversation(tab.messages)
      : undefined
    const appendSys = contextPrompt
      ? `The following is the conversation history from the planning session. Use it as context for implementation.\n\n<previous_conversation>\n${contextPrompt}\n</previous_conversation>`
      : undefined

    sendMessage(implementPrompt, tab.workingDirectory, planAttachment, appendSys)
  }

  return { onDismiss, onAnswer, onApprove, onImplement }
}
