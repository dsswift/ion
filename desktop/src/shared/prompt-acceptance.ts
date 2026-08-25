/**
 * The single prompt-admission predicate used by the input UI and send path.
 *
 * Input locks and connection readiness are client-known facts. Context capacity is
 * engine policy: the engine can recover an over-limit API conversation through
 * proactive compaction, so clients must submit and let the engine decide.
 */
/** Why a prompt cannot be accepted right now. */
export type PromptRefusalReason =
  | 'no-tab'
  | 'tabs-not-ready'
  | 'connecting'
  | 'input-locked'

export interface PromptRefusal {
  reason: PromptRefusalReason
  /** Human-readable detail for the log line. Never shown as UI copy. */
  detail: string
}

/** The subset of tab state the decision reads. */
export interface PromptAcceptanceTab {
  status?: string
  inputLocked?: boolean
  inputLockReason?: string | null
  /** Capacity fields are display telemetry only. The engine owns admission. */
  contextTokens?: number | null
  contextLimit?: number | null
}

export interface PromptAcceptanceInput {
  tab?: PromptAcceptanceTab | null
  /** Prompt origin. `'machine'` is the auto-fix flow's single sanctioned pass. */
  source?: string
  /** Omit when the caller does not require restored tab state. */
  tabsReady?: boolean
}

/** Returns null when the prompt may proceed, or a refusal that blocks it. */
export function promptRefusal(input: PromptAcceptanceInput): PromptRefusal | null {
  const { tab, source, tabsReady } = input

  if (!tab) return { reason: 'no-tab', detail: 'no active conversation resolved' }
  if (tabsReady === false) return { reason: 'tabs-not-ready', detail: 'tab state has not finished restoring' }
  if (tab.status === 'connecting') return { reason: 'connecting', detail: 'session is still connecting' }

  if (tab.inputLocked) {
    const terminal = tab.inputLockReason === 'landed-worktree' || tab.inputLockReason === 'settled'
    if (terminal || source !== 'machine') {
      return {
        reason: 'input-locked',
        detail: `conversation is input-locked (${tab.inputLockReason ?? 'unspecified'})`,
      }
    }
  }

  return null
}
