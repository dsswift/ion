// ion-meta bench tools — the proactive half of bench routing.
//
// The bench gates (bench-gate.ts, bench-write-gate.ts) are reactive: they
// refuse a wrong write after the model has already planned it. These tools are
// the forward-looking counterpart, registered for bench conversations only
// (index.ts suppresses them elsewhere):
//
//   - ion_bench_info:   what is this bench made of (source branch, base,
//                       members and their pins/status).
//   - ion_bench_locate: which member worktree OWNS a file, with changed line
//                       ranges — the same per-member diff attribution the
//                       write gate uses for refusals, exposed so the model
//                       routes an edit BEFORE trying it.
//
// Both are planModeSafe: routing decisions are made while planning, which is
// exactly when the live incident's second intervention happened (a finished
// plan whose every edit targeted bench paths).
//
// All bench knowledge delegates to bench-write-gate.ts exports — one reader,
// one attribution algorithm, no second copy to drift.

import { isAbsolute, join, resolve } from 'node:path'
import type { ToolDef } from '../../sdk/ion-sdk/types'
import {
  loadWorkspaces,
  resolveWorkspaceFor,
  attributeToMembers,
  type BenchWorkspace,
} from '../bench-write-gate'

/** The workspace for a cwd, or every workspace when cwd is not in a bench. */
function workspaceForCwd(cwd: string): BenchWorkspace | null {
  return cwd ? resolveWorkspaceFor(cwd) : null
}

export const benchInfoTool: ToolDef = {
  name: 'ion_bench_info',
  description:
    'Describe the integration bench this conversation is running in: the source branch it is built on, ' +
    'its base commit, and every member worktree layered onto it (label, branch, worktree path, pinned ' +
    'commit, enabled state). Use it to (re)orient before routing edits — edits belong in member ' +
    'worktrees, never in the bench itself.',
  parameters: { type: 'object', properties: {} },
  planModeSafe: true,
  execute: async (_params, ctx) => {
    const ws = workspaceForCwd(ctx.cwd)
    if (!ws) {
      // Suppression should prevent this call outside a bench, but the tool
      // answers honestly rather than erroring — a respawned host may race the
      // suppression, and "not a bench" is the truthful answer either way.
      return { content: `This conversation's working directory (${ctx.cwd}) is not inside an integration bench.` }
    }
    const members = (ws.members ?? []).map((m) => {
      const pin = m.pinnedSha ? m.pinnedSha.slice(0, 7) : 'unpinned'
      const state = m.enabled === false ? 'DISABLED (not in the current build)' : 'enabled'
      return `- ${m.label || m.branchName}: branch ${m.branchName}, worktree ${m.worktreePath}, integrated at ${pin}, ${state}`
    })
    return {
      content: [
        `Integration bench at ${ws.benchPath}`,
        `Built on source branch: ${ws.sourceBranch}${ws.baseSha ? ` (base ${ws.baseSha.slice(0, 7)})` : ''}`,
        'The bench is recreated from scratch on every rebuild; never edit here.',
        '',
        members.length > 0 ? 'Members:' : 'No members enrolled — the bench currently equals the source branch.',
        ...members,
      ].join('\n'),
    }
  },
}

export const benchLocateTool: ToolDef = {
  name: 'ion_bench_locate',
  description:
    'Find which member worktree OWNS a file in this integration bench — i.e. which in-flight branch ' +
    'contributes changes to it. Returns the owning worktree path(s) with changed line ranges. Use it ' +
    'BEFORE editing: the fix for anything diagnosed in the bench is made in the owning member worktree, ' +
    'committed there, and then updated in the bench. Accepts a path relative to the bench root or absolute.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path to attribute — relative to the bench root, or absolute.',
      },
    },
    required: ['path'],
  },
  planModeSafe: true,
  execute: async (params, ctx) => {
    const rawPath = typeof params?.path === 'string' ? params.path.trim() : ''
    if (!rawPath) {
      return { content: 'ion_bench_locate needs a file path.', isError: true }
    }

    const ws = workspaceForCwd(ctx.cwd)
    if (!ws) {
      return { content: `This conversation's working directory (${ctx.cwd}) is not inside an integration bench.` }
    }

    // Resolve against the BENCH ROOT, not the raw cwd: the model reasons in
    // repo-relative paths (`desktop/src/...`) regardless of which subdirectory
    // the conversation happens to sit in.
    const absolute = isAbsolute(rawPath) ? resolve(rawPath) : join(ws.benchPath, rawPath)
    const owners = attributeToMembers(ws, absolute)

    if (owners.length === 0) {
      return {
        content: [
          `No enrolled member changes \`${rawPath}\` — it comes from the base branch \`${ws.sourceBranch}\`.`,
          `A fix to this file belongs in a worktree cut from \`${ws.sourceBranch}\` (or in the member that should own it), not in the bench.`,
        ].join(' '),
      }
    }

    if (owners.length === 1) {
      const o = owners[0]
      const memberPath = absolute.startsWith(ws.benchPath)
        ? join(o.worktreePath, absolute.slice(ws.benchPath.length + 1))
        : o.worktreePath
      return {
        content: [
          `\`${rawPath}\` is owned by member ${o.label} (branch ${o.branchName})${o.hunks.length ? `, which changes ${o.hunks.join(', ')}` : ''}.`,
          `Make the change at ${memberPath}, commit it in that worktree, then update the member in the bench.`,
        ].join(' '),
      }
    }

    // Multi-owner: report the true owning set with line ranges — naming one
    // would be a guess (same rule as the write gate's refusal).
    const lines = owners.map((o) =>
      `- ${o.label} (${o.branchName}) changes ${o.hunks.length ? o.hunks.join(', ') : 'unknown lines'} → ${o.worktreePath}`)
    return {
      content: [
        `${owners.length} members change \`${rawPath}\`; the owner depends on which lines you are editing:`,
        ...lines,
        'Edit in the member that owns the lines you are changing, commit there, then update that member in the bench.',
      ].join('\n'),
    }
  },
}

/**
 * True when `cwd` is inside any integration bench. Used by index.ts's
 * session_start to decide whether to suppress the bench tools.
 */
export function isBenchCwd(cwd: string): boolean {
  if (!cwd) return false
  return resolveWorkspaceFor(cwd) !== null
}

/** Every known bench path — exported for logging the suppression decision. */
export function knownBenchPaths(): string[] {
  return loadWorkspaces().map((w) => w.benchPath)
}
