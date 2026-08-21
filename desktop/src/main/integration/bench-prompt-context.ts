/**
 * Bench prompt context — the exact record facts about the integration bench a
 * conversation is running in, as a structured value plus a generic formatter.
 *
 * Ported from the bench half of engine/internal/workspaces/prompt_context.go.
 * The desktop appends this prose per prompt via appendSystemPrompt; the
 * worktree half (WorktreeContext) stays engine-side.
 *
 * ── Why structured first, prose second ──────────────────────────────────────
 * This module owns the MECHANISM — reading the workspace record and stating
 * what it says. It does not own the OPINION of how those facts should be
 * phrased to a model, which varies per consumer. So the structured value is
 * the contract and the formatter is one least-opinionated default over it: a
 * consumer that wants different prose reads the same shape and writes its own,
 * with no need to re-derive anything from git or re-parse the records.
 *
 * ── Why the prose is deliberately thin ──────────────────────────────────────
 * The formatter states facts and the safety invariant that is actually
 * enforced (a bench edit is destroyed by the next assembly). It does NOT
 * prescribe a workflow — which conversation should fix what, when to
 * reassemble, how to review. Those are harness opinions, and hardcoding them
 * here would force every consumer through one product's workflow. The line is:
 * explain what is true and what is refused; the harness decides what to do
 * about it.
 */
import { sep } from 'path'
import { loadWorkspaces } from './bench-store'
import { lookupWorktreeTitle } from '../worktree/registry'
import { debug as _debug } from '../logger'
import type { IntegrationMember, IntegrationWorkspace } from '../../shared/types'
import type { ClientWorkspaceContext } from '../../shared/types-engine'

const TAG = 'bench.prompt-context'
function debug(msg: string, fields?: Record<string, unknown>): void { _debug(TAG, msg, fields) }

/** Marker present in every rendered bench context; used for idempotency checks. */
export const BENCH_CONTEXT_MARKER = '## Workspace: integration bench'

/**
 * The structured description of an integration bench: what it was assembled
 * from and which member worktrees own its content.
 */
export interface BenchContext {
  benchPath: string
  benchBranch: string
  repoPath: string
  sourceBranch: string
  baseSha: string
  /**
   * "assembled", "failed", or "" for unknown. Unknown is carried through as
   * unknown: claiming either outcome would be a fact the record does not
   * contain.
   */
  lastAssembly: string
  lastAssemblyError: string
  /** Unix ms of the last assembly attempt; 0 means never. */
  lastBuiltAt: number
  /**
   * The members in merge order — the contributors whose content is actually in
   * the bench.
   */
  members: MemberContext[]
  /**
   * Facts that change how bench observations should be read (failed assembly,
   * stale pins, conflicts). Generic strings so a consumer can surface them
   * without interpreting a taxonomy. Each is read from the record, never
   * guessed from the tree.
   */
  warnings: string[]
}

/** One enrolled worktree's contribution to a bench. */
export interface MemberContext {
  worktreePath: string
  branchName: string
  title: string
  /**
   * `pinnedBaseSha..pinnedSha` — the EXACT contribution the assembly merged.
   * The tip alone is not the contribution: a collision introduced by an
   * earlier commit in the range belongs to this member too.
   */
  pinnedRange: string
  pinnedSha: string
  pinnedBaseSha: string
  /**
   * True when the member has committed nothing of its own (equal base and
   * tip), which is distinct from having landed.
   */
  emptyContribution: boolean
  /**
   * True when the member's current tree differs from the pinned one: the
   * bench does NOT hold this worktree's current work.
   */
  stale: boolean
  /**
   * False when the record lacks the tree hashes needed to answer `stale` at
   * all. Reported so a consumer never reads an absent hash as freshness.
   */
  stalenessKnown: boolean
  pin: string
  merge: string
  /**
   * Legacy per-pin review verdict. The desktop's record loader migrates this
   * into the worktree registry's `stage` and strips it from the member shape
   * (see bench-store.ts `migrateLegacyReview`), so it is always empty here.
   * Kept so the format line stays a verbatim port of the Go contract, which
   * renders `review=<value>` when a record carries one.
   */
  review: string
  conflictPaths: string[]
  conflictsWith: string[]
  /**
   * "replayed" when the merge succeeded only via a recorded rerere
   * resolution.
   */
  mergeResolution: string
}

/**
 * Resolve which workspace's bench contains `directory`, or null when none
 * does.
 *
 * The separator is REQUIRED on the descendant check. A bare
 * `directory.startsWith(benchPath)` would also match a sibling whose name
 * merely begins with the bench path — `…/project-josh-other` against
 * `…/project-josh` — attributing an unrelated directory to a bench. The check
 * is exact-or-separator-prefixed, never bare (same discipline as
 * bench-guard.ts `resolveBenchFor`).
 */
function workspaceContaining(directory: string): IntegrationWorkspace | null {
  for (const ws of loadWorkspaces()) {
    if (!ws.benchPath) continue
    if (directory === ws.benchPath) return ws
    if (directory.startsWith(ws.benchPath + sep)) return ws
  }
  return null
}

/**
 * Project a bench record plus the worktree registry's titles into the
 * structured context, and derive the warnings that change how observations
 * made in the bench should be read.
 */
function benchContext(ws: IntegrationWorkspace): BenchContext {
  const members = ws.members.map(memberContext)
  return {
    benchPath: ws.benchPath,
    benchBranch: ws.benchBranch,
    repoPath: ws.repoPath,
    sourceBranch: ws.sourceBranch,
    baseSha: ws.baseSha,
    // Absent on records written before atomic assembly: UNKNOWN, carried as
    // the empty string exactly as the Go contract does.
    lastAssembly: ws.lastAssembly ?? '',
    lastAssemblyError: ws.lastAssemblyError ?? '',
    lastBuiltAt: ws.lastBuiltAt,
    members,
    warnings: benchWarnings(ws),
  }
}

function memberContext(m: IntegrationMember): MemberContext {
  return {
    worktreePath: m.worktreePath,
    branchName: m.branchName,
    // Titles are joined from the worktree registry: the member record carries
    // no worktree facts of its own (see the sidecar rationale on
    // IntegrationMember).
    title: lookupWorktreeTitle(m.worktreePath) ?? '',
    pinnedRange: pinnedRangeOf(m),
    pinnedSha: m.pinnedSha,
    pinnedBaseSha: m.pinnedBaseSha,
    emptyContribution: emptyContributionOf(m),
    stale: staleOf(m),
    stalenessKnown: stalenessKnownOf(m),
    pin: m.pin,
    merge: m.merge,
    review: '',
    conflictPaths: m.conflictPaths ?? [],
    conflictsWith: m.conflictsWith ?? [],
    mergeResolution: m.mergeResolution ?? '',
  }
}

/**
 * The member's contribution range in git syntax, or '' when the record cannot
 * express one.
 */
function pinnedRangeOf(m: IntegrationMember): string {
  if (!m.pinnedBaseSha || !m.pinnedSha) return ''
  return `${m.pinnedBaseSha}..${m.pinnedSha}`
}

/**
 * Whether the member has committed nothing of its own. An equal base/tip pair
 * is the one fact no git query at assembly time can recover once the source
 * branch moves, so it is read from the record.
 */
function emptyContributionOf(m: IntegrationMember): boolean {
  return m.pinnedBaseSha !== '' && m.pinnedBaseSha === m.pinnedSha
}

/**
 * Whether the member's current work differs from what the bench holds. Only
 * answerable when BOTH tree hashes are recorded: an absent hash is unknown,
 * and unknown must not read as "current" — that would assert freshness the
 * record does not carry.
 */
function staleOf(m: IntegrationMember): boolean {
  if (!m.pinnedTreeHash || !m.currentTreeHash) return false
  return m.pinnedTreeHash !== m.currentTreeHash
}

function stalenessKnownOf(m: IntegrationMember): boolean {
  return m.pinnedTreeHash !== '' && m.currentTreeHash !== ''
}

/**
 * Derive the facts that make a bench observation misleading if unstated. Each
 * is read from the record, never guessed from the tree.
 */
function benchWarnings(ws: IntegrationWorkspace): string[] {
  const warnings: string[] = []

  if (ws.lastAssembly === 'failed') {
    let w = 'The last assembly FAILED, so this bench was wiped to an empty tree and holds no member content. Anything built or tested here is not the enrolled combination.'
    if (ws.lastAssemblyError) w += ' Recorded error: ' + ws.lastAssemblyError
    warnings.push(w)
  } else if (ws.lastAssembly === undefined) {
    warnings.push('The last assembly outcome is unknown for this bench (the record predates outcome tracking), so whether the tree matches the enrolled combination cannot be confirmed from the record.')
  }

  const stale: string[] = []
  const unknownStale: string[] = []
  for (const m of ws.members) {
    if (staleOf(m)) stale.push(m.branchName)
    else if (!stalenessKnownOf(m)) unknownStale.push(m.branchName)
  }
  if (stale.length > 0) {
    warnings.push(`Pinned contributions are behind their worktrees for: ${stale.join(', ')}. The bench holds the PINNED work, not the current work in those worktrees.`)
  }
  if (unknownStale.length > 0) {
    warnings.push(`Pin freshness is unknown for: ${unknownStale.join(', ')} (the record carries no tree hashes to compare).`)
  }

  for (const m of ws.members) {
    if (m.merge === 'conflicted') {
      let w = `Member ${m.branchName} last merged with CONFLICTS`
      if (m.conflictsWith?.length) w += ' against ' + m.conflictsWith.join(', ')
      if (m.conflictPaths?.length) w += ' in ' + m.conflictPaths.join(', ')
      warnings.push(w + '.')
    }
    if (m.mergeResolution === 'replayed') {
      warnings.push(`Member ${m.branchName} merged only because a recorded conflict resolution was replayed; that is deterministic but not the same fact as a clean merge.`)
    }
    if (emptyContributionOf(m)) {
      warnings.push(`Member ${m.branchName} contributes nothing: its pinned range is empty, so it has committed no work of its own.`)
    }
  }
  return warnings
}

/**
 * Render the context as prose for a system prompt.
 *
 * One least-opinionated default over the struct: facts plus the invariant the
 * machinery enforces, no workflow prescription. A consumer wanting different
 * phrasing reads the struct.
 */
function format(bc: BenchContext): string {
  let b = BENCH_CONTEXT_MARKER + '\n\n'
  b += `This conversation is working in the integration bench ${bc.benchPath}`
  if (bc.benchBranch) b += ` on branch ${bc.benchBranch}`
  b += `. It is assembled from the source branch ${bc.sourceBranch} of ${bc.repoPath}`
  if (bc.baseSha) b += ` at ${bc.baseSha}`
  b += ", with each member's pinned contribution merged on top.\n"

  b += '\nThe bench is disposable: its branch is recreated from scratch on every assembly, so a file written here and a commit made here are both destroyed by the next assembly and reach nobody. File writes and history-writing git commands are refused in the bench for that reason. Reading, building, testing, and staging are unaffected — running the assembled combination is what the bench is for.\n'

  if (bc.members.length > 0) {
    b += '\nMembers, in merge order — each owns the content its pinned range contributed:\n'
    bc.members.forEach((m, i) => { b += `${i + 1}. ${formatLine(m)}\n` })
  } else {
    b += '\nNo members: this bench currently holds only its source branch.\n'
  }

  if (bc.lastAssembly) {
    b += `\nLast assembly: ${bc.lastAssembly}`
    if (bc.lastAssemblyError) b += ` — ${bc.lastAssemblyError}`
    b += '\n'
  }

  if (bc.warnings.length > 0) {
    b += '\nFacts that change how observations made here should be read:\n'
    for (const w of bc.warnings) b += `- ${w}\n`
  }

  // The tools, named in the order a conflict is actually worked: who owns it,
  // what was decided about it before, what each owner's version says. This is
  // the ONE place a model learns they exist, so all three are named together;
  // listing only attribution left the other two undiscoverable and the work
  // was done by hand instead.
  b += '\nThree read-only tools answer questions about this bench without shelling out:\n'
  b += '- WorkspaceAttribution — which member contributed a file, or a specific line range. Answers from the recorded pinned ranges rather than from "who last touched this file", and reports every candidate when more than one member changed the same file, including the specific lines each one changed.\n'
  b += '- BenchResolutionHistory — conflict resolutions previously recorded for these files, newest first, with the reasoning behind each. The same file frequently conflicts once per member, and git rerere cannot replay across members because its key is the conflict text; this carries what rerere cannot. Advisory context, not a resolution to apply.\n'
  b += "- BenchMemberFile — a file as a member's PINNED contribution has it, or as the bench base has it. Prefer this over reading a member worktree directly: that directory holds work done since the pin, which is not what this bench merges.\n"
  return b
}

function formatLine(m: MemberContext): string {
  let b = m.branchName || m.worktreePath
  b += ` at ${m.worktreePath}`
  if (m.pinnedRange) b += `, pinned range ${m.pinnedRange}`
  else if (m.pinnedSha) b += `, pinned at ${m.pinnedSha} with an unknown range start`
  if (m.title) b += ` — ${m.title}`
  const flags: string[] = []
  if (m.emptyContribution) flags.push('empty contribution')
  if (m.stale) flags.push('pin behind worktree')
  else if (!m.stalenessKnown) flags.push('pin freshness unknown')
  if (m.pin) flags.push('pin=' + m.pin)
  if (m.merge) flags.push('merge=' + m.merge)
  if (m.mergeResolution) flags.push('resolution=' + m.mergeResolution)
  if (m.review) flags.push('review=' + m.review)
  if (flags.length > 0) b += ` [${flags.join('; ')}]`
  return b
}

/**
 * Render the bench prompt context for a directory, or '' when the directory
 * is not inside an integration bench (or the record is missing/corrupt —
 * fail open, log at debug).
 */
export function benchPromptContext(cwd: string): string {
  if (!cwd) return ''
  try {
    const ws = workspaceContaining(cwd)
    if (!ws) {
      debug('no bench contains directory, injecting nothing', { cwd })
      return ''
    }
    return format(benchContext(ws))
  } catch (err) {
    // loadWorkspaces already treats a missing or corrupt record as empty, so
    // reaching here is unusual. Fail OPEN: a missing context section is a
    // briefly less-informed prompt, while throwing here would break every
    // prompt dispatched from the directory.
    debug('bench prompt context failed, injecting nothing', { cwd, error: String(err) })
    return ''
  }
}

/**
 * Build a ClientWorkspaceContext for an integration bench, or null when
 * the directory is not inside one. The engine routes this through
 * system_inject and context_inject hooks, then appends the text to the
 * system prompt -- replacing the previous appendSystemPrompt injection.
 */
export function benchClientWorkspaceContext(cwd: string): ClientWorkspaceContext | null {
  if (!cwd) return null
  try {
    const ws = workspaceContaining(cwd)
    if (!ws) {
      debug('benchClientWorkspaceContext: no bench contains directory', { cwd })
      return null
    }
    const ctx = benchContext(ws)
    return {
      kind: 'bench',
      cwd,
      bench: ctx as unknown as Record<string, unknown>,
      text: format(ctx),
    }
  } catch (err) {
    debug('benchClientWorkspaceContext: failed, returning null', { cwd, error: String(err) })
    return null
  }
}
