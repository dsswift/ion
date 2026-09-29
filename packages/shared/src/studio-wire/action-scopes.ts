/**
 * studio-wire/action-scopes — the scope half of the `studio_action` registry.
 *
 * Split out of `actions.ts` at the file-size cap, along the seam the file
 * already had: `actions.ts` answers "is this action forwarded, and what
 * arguments does it take"; this answers "what scope must a connection hold to
 * invoke it". Both halves are re-exported from `actions.ts`, so every existing
 * import keeps resolving and there is still one place to read the contract
 * from.
 */
import type { Scope } from './types'
import { FORWARDED_ACTIONS, type ForwardedActionSpec } from './actions'

// ── studio_action scope registry (manifest contract C4) ──────────────────
//
// Every forwarded action declares exactly one required scope. The groups
// below mirror the section comments in FORWARDED_ACTIONS (./actions):
//   - terminal:operate — the Conversation Terminal Panel actions.
//   - git:write — every worktree/bench/fork/conflict-resolution action that
//     mutates a git working tree or the worktree registry.
//   - conversations:operate — everything else: tab lifecycle, inbox
//     metadata, the prompt pipeline, permissions, attachments.
// `conversations:read` and `admin` are not required by any FORWARDED
// action today (read access rides `studio_hello`/`studio_snapshot`, and
// `admin` gates server-diagnostic and credential operations outside this
// registry) but are part of the Scope union so a future action can declare
// them without widening the type.
const TERMINAL_ACTIONS: ReadonlySet<string> = new Set([
  'toggleTerminal',
  'addTerminalInstance',
  'relaunchTerminalInstance',
  'ensureTerminalInstance',
  'removeTerminalInstance',
  'selectTerminalInstance',
  'toggleTerminalReadOnly',
  'renameTerminalInstance',
  'getOrCreateDedicatedTerminal',
  'runInTerminal',
  'runQuickTool',
])

const GIT_WRITE_ACTIONS: ReadonlySet<string> = new Set([
  'forkTab',
  'forkFromMessage',
  'finishWorktreeTab',
  'landAndRetireWorktree',
  'convertToWorktree',
  'setupWorktree',
  'createWorktree',
  'cancelWorktreeSetup',
  'renameTabAndWorktree',
  'renameWorktree',
  'openWorktreeConversation',
  'newWorktreeConversation',
  'syncWorktree',
  'startWorktreePipeline',
  'confirmWorktreePipelineAi',
  'cancelWorktreePipeline',
  'dismissWorktreePipeline',
  'retireWorktree',
  'reprovisionWorktree',
  'openBenchConversation',
  'cycleBenchConversation',
  'openBenchTerminal',
  'benchAssemble',
  'benchResolveConflict',
  'benchRerereForget',
  'benchRerereDiscardAll',
  'benchUpdateMember',
  'benchUpdateAll',
  'benchAddMember',
  'benchRemoveMember',
  'setWorktreeStage',
  'benchSetReview',
  'benchSetOrder',
  'openConflictAssist',
  'continueConflictOperation',
  'abortConflictOperation',
  'openBenchVerificationAnalysis',
  'benchDiscardMemberRecordings',
  'benchApplyOverlapFastLane',
  'retireLandedWorktrees',
  'sealLandedWorktree',
  'refreshWorktreeInventory',
  'refreshBench',
  'refreshWorkspaceViews',
  'benchRerereCount',
])

function classifyScope(action: string): Scope {
  if (TERMINAL_ACTIONS.has(action)) return 'terminal:operate'
  if (GIT_WRITE_ACTIONS.has(action)) return 'git:write'
  return 'conversations:operate'
}

export interface ActionSpec {
  name: string
  requiredScope: Scope
  /** Wire-shape validation, reusing the forwarder's own arg-count/tabId spec. */
  argsSchema: ForwardedActionSpec
}

/** Every `studio_action` name, with its required scope and argument shape. */
export const ACTIONS: Record<string, ActionSpec> = Object.fromEntries(
  Object.entries(FORWARDED_ACTIONS).map(([name, argsSchema]) => [
    name,
    { name, requiredScope: classifyScope(name), argsSchema },
  ]),
)

/** True when `scope` satisfies the action's requirement (`admin` satisfies everything). */
export function scopeSatisfies(scopes: readonly Scope[], required: Scope): boolean {
  return scopes.includes(required) || scopes.includes('admin')
}
