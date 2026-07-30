// ion-meta bench briefing.
//
// Builds the system-prompt addition for a conversation whose cwd is inside an
// integration bench. Injected by index.ts's `before_prompt` handler alongside
// the persona.
//
// Why proactive, when the write gate already refuses bench edits
// --------------------------------------------------------------
// The gate is reactive: it fires AFTER the model has planned an edit against a
// bench path, which means a plan-mode session can produce an entire plan whose
// every edit targets the bench — wrong before implementation starts, and the
// operator has to intervene twice (once to explain the bench, once to redo the
// plan). This happened verbatim in a live bench conversation. The briefing
// puts the bench's nature, its member composition, and the routing rule into
// the system prompt at turn one, so plans are born targeting member worktrees
// and the gate returns to being a net, not the primary teacher.
//
// Why this is harness code, not engine code
// -----------------------------------------
// The bench is a desktop/harness-level concern — the engine has no concept of
// one (docs/engine-grounding.md § 1). ion-meta already owns every bench gate
// and the workspace-reading code; the briefing is the same knowledge pointed
// forward in time.
//
// Freshness: the briefing is rebuilt per prompt from the live workspace file
// (no caching, unlike the persona). Members are added, updated, and retired
// mid-session by the operator, and a briefing describing last hour's bench
// would misroute edits — the exact failure it exists to prevent. The file is
// tiny (<4KB) and before_prompt already tolerates this cost for gates.

import { resolveWorkspaceFor, type BenchWorkspace } from './bench-write-gate'

/**
 * The briefing for a bench conversation, or null when `cwd` is not inside any
 * integration bench. Fail-open posture matches the gates: an unreadable
 * workspace file yields null (no briefing) rather than an error — the write
 * gate still stands behind it.
 */
export function buildBenchBriefing(cwd: string): string | null {
  if (!cwd) return null
  const ws = resolveWorkspaceFor(cwd)
  if (!ws) return null
  return formatBriefing(ws)
}

/**
 * Format the briefing from a workspace record.
 *
 * Ordered by operational importance: what this place is, the one hard rule,
 * where edits belong, the tools that answer routing questions, and the
 * plan-mode corollary (plans must be born targeting member paths).
 */
function formatBriefing(ws: BenchWorkspace): string {
  const members = (ws.members ?? []).filter((m) => m.enabled !== false)
  const memberLines = members.length > 0
    ? members
      .map((m) => {
        const label = m.label || m.branchName
        const pin = m.pinnedSha ? m.pinnedSha.slice(0, 7) : 'unpinned'
        return `- **${label}** — branch \`${m.branchName}\`, worktree \`${m.worktreePath}\`, integrated at \`${pin}\``
      })
      .join('\n')
    : '- (no enabled members — the bench currently equals the source branch)'

  return [
    '## Integration bench context',
    '',
    `You are working inside an INTEGRATION BENCH at \`${ws.benchPath}\`. A bench is a disposable, rebuildable combination of in-flight worktrees layered onto the \`${ws.sourceBranch}\` branch. It is recreated from scratch on every rebuild.`,
    '',
    '**Never plan or make edits inside the bench.** Write and Edit calls targeting bench paths are refused by a deterministic gate, and any change that slipped through would be destroyed by the next rebuild. The bench exists for reading, building, and testing the combined work — nothing else.',
    '',
    '**Every fix belongs in the member worktree that owns the file.** Diagnose in the bench, then make the change in the owning member worktree, commit it there, and update that member in the bench. Writing to a member worktree path from this conversation is allowed and is the correct way to fix anything found here.',
    '',
    'Members currently layered onto this bench:',
    memberLines,
    '',
    'Tools available in bench conversations:',
    '- `ion_bench_locate` — which member worktree owns a file (with changed line ranges). Use it BEFORE deciding where an edit goes.',
    '- `ion_bench_info` — this bench\'s live composition (source branch, base, members and their status).',
    '',
    'When writing a plan, every edit in the plan must already target member-worktree paths (or the base repo for base-branch fixes) — a plan that edits bench paths is wrong before implementation starts.',
  ].join('\n')
}
