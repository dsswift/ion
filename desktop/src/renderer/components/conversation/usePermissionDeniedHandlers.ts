import { useSessionStore } from '../../stores/sessionStore'
import { usePreferencesStore } from '../../preferences'
import { nextMsgId } from '../../stores/session-store-helpers'
import { activeInstance, commitInstance } from '../../stores/conversation-instance'
import { formatImplementDivider } from '../../../shared/clear-divider'
import type { TabState, Attachment } from '../../../shared/types'

interface Handlers {
  onDismiss: () => void
  onAnswer: (answer: string) => void
  onApprove: (toolNames: string[]) => void
  onImplement: (clearContext?: boolean) => Promise<void>
  onImplementAndUnpin: (clearContext?: boolean) => Promise<void>
}

/**
 * Build the four PermissionDeniedCard callbacks for the active tab.
 *
 * onImplement takes a `clearContext` parameter (default `false`) that
 * the plan-approval card supplies per-click:
 *
 *   - `clearContext = false` (the regular **Implement** button): the
 *     engine session is preserved. Plan mode is flipped off via
 *     `setPermissionMode('auto', ...)`, which routes a
 *     `set_plan_mode(false)` to the engine and clears the plan-mode
 *     system prompt + restricted tool list without destroying the
 *     conversation. The implement prompt is sent with
 *     `implementationPhase=true` so the engine suppresses EnterPlanMode
 *     tool injection (the model can't re-propose plan mode against the
 *     user's intent). The model retains everything it learned during
 *     planning — no re-reading of files, no lost context.
 *
 *   - `clearContext = true` (the **"Implement, clear context"** button,
 *     revealed only when `showImplementClearContext` is enabled): the
 *     historical behavior — a fresh engine session is started via
 *     `resetTabSession`, the prior conversation ID is archived into
 *     `historicalSessionIds`, and the implement prompt is sent as the
 *     first message of a brand-new conversation. The plan file is the
 *     complete artifact of the planning session.
 *
 * Both branches insert the visual `── Implementing plan at <time> ──`
 * divider so the user can see where planning ended and implementation
 * began.
 *
 * Granularity is per-plan: the user decides at click-time whether they
 * want a fresh conversation for this particular plan. There is no
 * global "always clear context" toggle. Users can also manually clear
 * context with `/clear` at any time regardless of which button they
 * clicked.
 */
export function buildPermissionDeniedHandlers(
  tab: TabState,
  sendMessage: (
    content: string,
    workingDir?: string,
    attachments?: Attachment[],
    appendSystemPrompt?: string,
    implementationPhase?: boolean,
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
    sendMessage(answer)
  }

  const onApprove = (toolNames: string[]) => {
    window.ion.approveDeniedTools(tab.id, toolNames)
    dismissPermissionDenied()
    sendMessage('The denied tools have been approved. Please retry the operation.')
  }

  const onImplement = async (clearContext: boolean = false) => {
    dismissPermissionDenied()

    // Do NOT set tab.status eagerly here. The renderer's tab.status has
    // no effect on the main-process heartbeat guard (engine-control-plane-
    // events.ts:311 reads its own tab entry, not the renderer store). The
    // main-process tab is already 'completed' at this point, which is
    // sufficient to suppress stale denial re-promotion.
    //
    // Setting 'connecting' caused sendMessage to silently drop the
    // implement prompt (sendMessage guards on status==='connecting').
    // Setting 'running' caused sendMessage to route the prompt through
    // steer() instead of prompt() (sendMessage treats running as isBusy).
    // Both are wrong — sendMessage must see a non-busy, non-connecting
    // status so it dispatches via window.ion.prompt().
    //
    // sendMessage itself sets 'connecting' at dispatch time (line ~157),
    // which is the correct transition point.

    // Switch to auto mode for implementation
    useSessionStore.getState().setPermissionMode('auto', 'plan_approved')

    // Auto-switch to the implementation model if the split feature is enabled
    const { planModelSplitEnabled, implementModeModel } = usePreferencesStore.getState()
    if (planModelSplitEnabled && implementModeModel) {
      useSessionStore.getState().setTabModel(tab.id, implementModeModel)
    }

    // Auto-move tab to in-progress group if designated
    const { inProgressGroupId, tabGroupMode, autoGroupMovement } = usePreferencesStore.getState()
    if (autoGroupMovement && inProgressGroupId && tabGroupMode === 'manual' && tab.groupId !== inProgressGroupId) {
      if (tab.groupPinned) {
        console.log(`[auto-move] suppressed: tab=${tab.id.slice(0, 8)} pinned=true currentGroup=${tab.groupId ?? 'none'} wouldMoveTo=${inProgressGroupId}`)
      } else {
        useSessionStore.getState().moveTabToGroup(tab.id, inProgressGroupId)
      }
    }

    // Extract plan file path: instance state (engine event) > denial toolInput.
    // Per-conversation state lives on the tab's active instance now.
    const planInst = activeInstance(useSessionStore.getState().conversationPanes, tab.id)
    let planFilePath: string | null = planInst?.planFilePath || null
    if (!planFilePath && planInst?.permissionDenied?.tools) {
      const exitDenial = planInst.permissionDenied.tools.find(
        (t) => t.toolName === 'ExitPlanMode' && t.toolInput
      )
      if (exitDenial?.toolInput?.planFilePath) {
        planFilePath = exitDenial.toolInput.planFilePath as string
      }
    }

    // Read plan content
    let planContent: string | null = null
    if (planFilePath) {
      try {
        const result = await window.ion.readPlan(planFilePath)
        planContent = result.content
      } catch (err) {
        console.warn('Failed to read plan file:', err)
      }
    }

    // Branch on the per-click `clearContext` argument. Default (false)
    // keeps the engine session alive so the model retains its planning
    // context; true (opt-in via the "Implement, clear context" button)
    // runs the historical reset-and-archive behavior.
    console.log(`[onImplement] tab=${tab.id.slice(0, 8)} clearContext=${clearContext} planFilePath=${planFilePath ?? '<none>'} planContentLen=${planContent?.length ?? 0}`)

    if (clearContext) {
      // Opt-in: destroy the engine session so the implementation run
      // starts clean. This clears the conversation, the plan-mode
      // system prompt, and the restricted tool list. The prior
      // conversation ID is archived into historicalSessionIds so the
      // user can still navigate back to it via session history.
      console.log(`[onImplement] tab=${tab.id.slice(0, 8)} clearing context — resetTabSession + archive conversationId`)
      window.ion.resetTabSession(tab.id)

      useSessionStore.setState((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tab.id, (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            {
              id: nextMsgId(),
              role: 'system' as const,
              content: formatImplementDivider(new Date()),
              timestamp: Date.now(),
            },
          ],
          planFilePath: null,
          permissionQueue: [],
          permissionDenied: null,
        }))
        return {
          conversationPanes,
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
                  lastResult: null,
                  currentActivity: '',
                  queuedPrompts: [],
                }
              : t
          ),
        }
      })
    } else {
      // Default: preserve the engine session. The setPermissionMode call
      // above already flipped plan mode off on the engine side (which
      // also drops the plan-mode system prompt and the restricted tool
      // list — see engine/internal/session/plan_mode.go:23-41). The
      // conversationId stays put so the LLM history is preserved across
      // the plan→implement boundary.
      console.log(`[onImplement] tab=${tab.id.slice(0, 8)} preserving conversation — staying in conversationId=${tab.conversationId ?? '<none>'}`)
      useSessionStore.setState((s) => {
        const conversationPanes = commitInstance(s.conversationPanes, tab.id, (inst) => ({
          ...inst,
          messages: [
            ...inst.messages,
            {
              id: nextMsgId(),
              role: 'system' as const,
              content: formatImplementDivider(new Date()),
              timestamp: Date.now(),
            },
          ],
          planFilePath: null,
          permissionQueue: [],
          permissionDenied: null,
        }))
        return {
          conversationPanes,
          tabs: s.tabs.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  lastResult: null,
                  currentActivity: '',
                  queuedPrompts: [],
                }
              : t
          ),
        }
      })
    }

    // Structured signal to the engine that this run is the implement
    // half of a plan-then-implement flow. The engine maps this onto
    // RunOptions.ImplementationPhase, which suppresses EnterPlanMode
    // sentinel-tool injection so the model can't re-propose plan-mode
    // entry against the user's already-approved intent.
    //
    // Replaces the prior mechanism that prepended a "You are implementing
    // a user-approved plan. Do not re-enter plan mode..." preamble to
    // the user prompt and relied on the EnterPlanMode tool docstring
    // telling the model to recognize those phrases. Substring matching
    // was brittle (translation-sensitive, easy to bypass with
    // paraphrasing) and bled UI/harness policy into engine-visible
    // prompt text. The boolean is the mechanical equivalent and lives
    // on the structured wire contract.
    //
    // The flag is set regardless of the clearContext branch because the
    // engine-side concern (don't let the model re-enter plan mode)
    // applies identically whether we reset or preserve the conversation.
    const implementPrompt = planContent
      ? `Implement the following plan:\n\n${planContent}`
      : 'Implement the plan.'

    const planAttachment = planFilePath ? [{
      id: crypto.randomUUID(),
      type: 'plan' as const,
      name: planFilePath.split('/').pop() || 'plan.md',
      path: planFilePath,
    }] : undefined

    sendMessage(implementPrompt, tab.workingDirectory, planAttachment, undefined, true)
  }

  const onImplementAndUnpin = async (clearContext: boolean = false): Promise<void> => {
    // Unpin first so the auto-move guard fires when onImplement switches
    // the tab to auto mode — tab will then move to in-progress as expected.
    useSessionStore.getState().toggleTabGroupPin(tab.id)
    console.log(`[tab-pin] implement-and-unpin: tab=${tab.id.slice(0, 8)} clearContext=${clearContext} — pin cleared, handing off to onImplement`)
    await onImplement(clearContext)
  }

  return { onDismiss, onAnswer, onApprove, onImplement, onImplementAndUnpin }
}
