/**
 * Window-local Questions cache — the renderer's synchronized replica of the
 * server-owned QuestionsCoordinator state, unioned across every connected
 * Environment (ADR-033).
 *
 * Deliberately OUTSIDE useSessionStore: this store contains no business
 * logic, forwards nothing, and never participates in the Studio mirror. All
 * mutations go through validated server actions (questionsPatch /
 * questionsAction); the accepted state comes back on `ion:questions-state`
 * and replaces that Environment's rows wholesale.
 *
 * One Environment per snapshot. Each server answers `questions.getState`
 * with ITS OWN complete workflow list, so a single flat replace would let
 * the last Environment to speak erase every other Environment's parked
 * questions. `byEnvironment` keeps them apart and `workflows` is the union
 * the consumers read.
 *
 * Hydration: `hydrateQuestions()` runs once per window and then follows the
 * connection registry — an Environment is pulled when it reaches
 * `connected`, and its rows are dropped when it stops being reachable,
 * because a question on a server the window cannot talk to is one the
 * operator cannot answer.
 */
import { create } from 'zustand'
import type {
  QuestionsStateSnapshot,
  QuestionsWorkflowState,
  QuestionsPatch,
  QuestionsAction,
  QuestionsActionResult,
} from '@ion/shared/questions-state'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { rWarn } from '../rendererLogger'
import { host } from '../host/host-instance'
import { registry } from '../studio/connection/registry'
import { withTargetEnvironment } from '../studio/connection/tab-environment'

/** Phases in which a server can still answer a question the operator sends it. */
const REACHABLE_PHASES = new Set(['connected', 'degraded'])

interface QuestionsCacheState {
  /** Every reachable Environment's workflows, keyed by its local catalog id. */
  byEnvironment: Record<string, QuestionsWorkflowState[]>
  /** The union of `byEnvironment`, oldest request first — what consumers read. */
  workflows: QuestionsWorkflowState[]
  lastActionResult: QuestionsStateSnapshot['lastActionResult']
  hydrated: boolean
  /** Replace one Environment's rows with its authoritative snapshot. */
  replaceFromEnvironment: (environmentId: string, snapshot: QuestionsStateSnapshot) => void
  /** Drop one Environment's rows: it is no longer reachable. */
  dropEnvironment: (environmentId: string) => void
}

function unionOf(byEnvironment: Record<string, QuestionsWorkflowState[]>): QuestionsWorkflowState[] {
  return Object.values(byEnvironment)
    .flat()
    .sort((a, b) => a.startedAt - b.startedAt)
}

export const useQuestionsStore = create<QuestionsCacheState>((set) => ({
  byEnvironment: {},
  workflows: [],
  lastActionResult: undefined,
  hydrated: false,
  replaceFromEnvironment: (environmentId, snapshot) =>
    set((state) => {
      const byEnvironment = { ...state.byEnvironment, [environmentId]: snapshot.workflows }
      return {
        byEnvironment,
        workflows: unionOf(byEnvironment),
        // The result belongs to whichever client action was just decided, so
        // the newest one wins regardless of which Environment decided it.
        lastActionResult: snapshot.lastActionResult ?? state.lastActionResult,
        hydrated: true,
      }
    }),
  dropEnvironment: (environmentId) =>
    set((state) => {
      if (!(environmentId in state.byEnvironment)) return state
      const byEnvironment = { ...state.byEnvironment }
      delete byEnvironment[environmentId]
      return { byEnvironment, workflows: unionOf(byEnvironment) }
    }),
}))

/**
 * The Environment that owns `workflowId`, so a patch or an action reaches the
 * server that is actually holding the question open. Falls back to the local
 * Environment when the workflow is unknown, which is where a single-
 * Environment window's questions all live anyway.
 */
export function environmentOfWorkflow(workflowId: string): string {
  const { byEnvironment } = useQuestionsStore.getState()
  for (const [environmentId, workflows] of Object.entries(byEnvironment)) {
    if (workflows.some((w) => w.workflowId === workflowId)) return environmentId
  }
  rWarn('questions', 'workflow has no known environment; routing local', { workflow_id: workflowId })
  return LOCAL_ENVIRONMENT_ID
}

/**
 * Send a draft patch to the Environment holding the workflow.
 *
 * `QuestionsPatch` names a workflow, not a tab, so `resolveShellEnvironment`
 * cannot route it from the payload and would send every patch to the local
 * server — which answers for a workflow it has never heard of. The explicit
 * target is what makes answering a remote question land where the question is.
 */
export function patchQuestions(patch: QuestionsPatch): Promise<QuestionsActionResult> {
  return withTargetEnvironment(environmentOfWorkflow(patch.workflowId), () => host.shell.questionsPatch(patch))
}

/** Send a wizard action to the Environment holding the workflow. See `patchQuestions`. */
export function actOnQuestions(action: QuestionsAction): Promise<QuestionsActionResult> {
  return withTargetEnvironment(environmentOfWorkflow(action.workflowId), () => host.shell.questionsAction(action))
}

let wired = false

/** Pull one Environment's complete snapshot. */
function hydrateEnvironment(environmentId: string): void {
  void withTargetEnvironment(environmentId, () => host.shell.questionsGetState())
    .then((snapshot) => useQuestionsStore.getState().replaceFromEnvironment(environmentId, snapshot))
    .catch((err: unknown) => {
      rWarn('questions', 'state hydration failed', { environment_id: environmentId, error: String(err) })
    })
}

/**
 * Hydrate from every reachable Environment and subscribe to their broadcasts.
 * Idempotent per window. Returns the unsubscribe function (unused in practice
 * — the subscription lives for the window's lifetime).
 */
export function hydrateQuestions(): () => void {
  if (wired) return () => {}
  wired = true

  /** Environments already pulled, so a phase re-notification does not re-pull. */
  const pulled = new Set<string>()
  // `registry.subscribe` replays the current phase map immediately, so an
  // Environment that welcomed before this ran is hydrated on the first call
  // rather than waiting for its next transition.
  const offRegistry = registry.subscribe((states) => {
    for (const [environmentId, state] of states) {
      const reachable = REACHABLE_PHASES.has(state.phase)
      if (reachable && !pulled.has(environmentId)) {
        pulled.add(environmentId)
        hydrateEnvironment(environmentId)
      } else if (!reachable && pulled.has(environmentId)) {
        pulled.delete(environmentId)
        useQuestionsStore.getState().dropEnvironment(environmentId)
      }
    }
  })

  const offState = host.shell.onQuestionsState((snapshot: QuestionsStateSnapshot, environmentId?: string) => {
    useQuestionsStore.getState().replaceFromEnvironment(environmentId ?? LOCAL_ENVIRONMENT_ID, snapshot)
  })

  return () => {
    offRegistry()
    offState()
  }
}

/**
 * Open (renderable) workflows for one tab, oldest first. Terminal states are
 * excluded — the same rule the coordinator's openForSession applies,
 * duplicated read-side because terminal states DO transit the broadcast once
 * (for dismissal animations). Matches by engine-key prefix: extension-hosted
 * sessions key as `tabId:instanceId`. Tab ids are unique across Environments,
 * so the union needs no Environment filter here.
 */
export function openWorkflowsForTab(
  workflows: QuestionsWorkflowState[],
  tabId: string,
): QuestionsWorkflowState[] {
  return workflows
    .filter((w) => {
      const wfTab = w.sessionKey.includes(':') ? w.sessionKey.slice(0, w.sessionKey.indexOf(':')) : w.sessionKey
      return wfTab === tabId && w.phase !== 'terminal'
    })
    .sort((a, b) => a.startedAt - b.startedAt)
}

/**
 * Number of active guided waits on a tab, read from the synchronized cache
 * without subscribing. Feeds the Inbox rules (pendingAskCount, snooze
 * eligibility, auto-settle guards): an open guided wait is an operator
 * decision pending, so the tab must not snooze or auto-settle under it.
 * Non-reactive by design — the Inbox guards re-evaluate on their own ticks
 * and action attempts, where a getState() read is current enough.
 */
export function activeQuestionsCount(tabId: string): number {
  return openWorkflowsForTab(useQuestionsStore.getState().workflows, tabId).length
}
