/**
 * The single prompt-admission predicate used by the input UI and send path.
 *
 * Context capacity is client policy. The engine reports occupancy as
 * `contextTokens`; the client measures it against the selected model's effective
 * input limit. `/compact` and `/clear` are recovery commands and stay available
 * when normal prompts are blocked.
 */
import { contextCapacityBlocksPrompt, resolveContextCapacity } from './context-capacity'

/** Why a prompt cannot be accepted right now. */
export type PromptRefusalReason =
  | 'no-tab'
  | 'tabs-not-ready'
  | 'connecting'
  | 'input-locked'
  | 'context-full'

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
  contextTokens?: number | null
  contextLimit?: number | null
}

export interface PromptAcceptanceInput {
  tab?: PromptAcceptanceTab | null
  /** Raw prompt text. Recovery commands can bypass the context-full refusal. */
  text?: string
  /** Prompt origin. `'machine'` is the auto-fix flow's single sanctioned pass. */
  source?: string
  /** Omit when the caller does not require restored tab state. */
  tabsReady?: boolean
}

/** Returns null when the prompt may proceed, or a refusal that blocks it. */
export function promptRefusal(input: PromptAcceptanceInput): PromptRefusal | null {
  const { tab, source, tabsReady, text = '' } = input

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

  if (contextCapacityBlocksPrompt(resolveContextCapacity(tab.contextTokens, tab.contextLimit), text)) {
    return { reason: 'context-full', detail: 'context occupancy has reached the selected model input limit' }
  }

  return null
}
