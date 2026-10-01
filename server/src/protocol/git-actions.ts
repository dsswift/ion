/**
 * `git.*` `studio_action`s — the wire face of `git/git-api.ts`.
 *
 * The table there is channel-keyed (it is a verbatim relocation of the
 * Electron handlers); this maps each studio_action name onto its channel, so
 * the wire vocabulary is `git.status`-style rather than the raw IPC strings.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 * Reads are `conversations:read`. Everything that writes to the repository
 * or the index — commit, stage, discard, branch mutation, stash, rebase,
 * cherry-pick, revert, reset, conflict resolution, fetch/pull/push — takes
 * `git:write`. `git:write` exists for exactly this and is the scope the
 * server's own OIDC role map already grants to Studio.User and Studio.Admin.
 *
 * `git.fetch` counts as a write despite reading from the remote: it mutates
 * refs in the local repository, and a client that may not change the
 * repository should not be able to move its remote-tracking branches.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { IPC } from '@ion/shared/types'
import { GIT_HANDLERS } from '../git/git-api'
import { subscribeGit, unsubscribeGit } from '../git/git-subscriptions'
import { warn as _warn } from '../logger'
import type { Connection } from './connection'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('git-actions', msg, fields)
}

export type GitActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface GitActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<GitActionOutcome>
}

/** studio_action name -> [IPC channel the shared table is keyed by, scope]. */
const GIT_ACTION_MAP: Record<string, [string, Scope]> = {
  // ── Reads ──
  'git.isRepo': [IPC.GIT_IS_REPO, 'conversations:read'],
  'git.graph': [IPC.GIT_GRAPH, 'conversations:read'],
  'git.commitDetail': [IPC.GIT_COMMIT_DETAIL, 'conversations:read'],
  'git.commitFiles': [IPC.GIT_COMMIT_FILES, 'conversations:read'],
  'git.commitFileDiff': [IPC.GIT_COMMIT_FILE_DIFF, 'conversations:read'],
  'git.ignoredFiles': [IPC.GIT_IGNORED_FILES, 'conversations:read'],
  'git.changes': [IPC.GIT_CHANGES, 'conversations:read'],
  'git.branches': [IPC.GIT_BRANCHES, 'conversations:read'],
  'git.diff': [IPC.GIT_DIFF, 'conversations:read'],
  'git.stashList': [IPC.GIT_STASH_LIST, 'conversations:read'],
  'git.blame': [IPC.GIT_BLAME, 'conversations:read'],

  // ── Writes ──
  'git.commit': [IPC.GIT_COMMIT, 'git:write'],
  'git.fetch': [IPC.GIT_FETCH, 'git:write'],
  'git.pull': [IPC.GIT_PULL, 'git:write'],
  'git.push': [IPC.GIT_PUSH, 'git:write'],
  'git.checkout': [IPC.GIT_CHECKOUT, 'git:write'],
  'git.createBranch': [IPC.GIT_CREATE_BRANCH, 'git:write'],
  'git.deleteBranch': [IPC.GIT_DELETE_BRANCH, 'git:write'],
  'git.stage': [IPC.GIT_STAGE, 'git:write'],
  'git.unstage': [IPC.GIT_UNSTAGE, 'git:write'],
  'git.discard': [IPC.GIT_DISCARD, 'git:write'],
  'git.stashSave': [IPC.GIT_STASH_SAVE, 'git:write'],
  'git.stashPop': [IPC.GIT_STASH_POP, 'git:write'],
  'git.stashDrop': [IPC.GIT_STASH_DROP, 'git:write'],
  'git.cherryPick': [IPC.GIT_CHERRY_PICK, 'git:write'],
  'git.revert': [IPC.GIT_REVERT, 'git:write'],
  'git.reset': [IPC.GIT_RESET, 'git:write'],
  'git.resolveConflict': [IPC.GIT_RESOLVE_CONFLICT, 'git:write'],

  // ── Operations (git-api-ops) ──
  'git.refresh': [IPC.GIT_REFRESH, 'conversations:read'],
  'git.showFile': [IPC.GIT_SHOW_FILE, 'conversations:read'],
  'git.commitSignature': [IPC.GIT_COMMIT_SIGNATURE, 'conversations:read'],
  'git.recentRefs': [IPC.GIT_RECENT_REFS, 'conversations:read'],
  'git.opState': [IPC.GIT_OP_STATE, 'conversations:read'],
  'git.conflictStages': [IPC.GIT_CONFLICT_STAGES, 'conversations:read'],
  'git.rebaseTodo': [IPC.GIT_REBASE_TODO, 'conversations:read'],

  'git.applyPatch': [IPC.GIT_APPLY_PATCH, 'git:write'],
  'git.tagCreate': [IPC.GIT_TAG_CREATE, 'git:write'],
  'git.conflictAccept': [IPC.GIT_CONFLICT_ACCEPT, 'git:write'],
  'git.rebaseExec': [IPC.GIT_REBASE_EXEC, 'git:write'],
  'git.rebaseAbort': [IPC.GIT_REBASE_ABORT, 'git:write'],
  'git.rebaseContinue': [IPC.GIT_REBASE_CONTINUE, 'git:write'],

  // ── Worktree verbs behind the same gitDirect gate ──
  'git.worktreeAppraise': [IPC.GIT_WORKTREE_APPRAISE, 'conversations:read'],
  'git.worktreeRetirePreview': [IPC.GIT_WORKTREE_RETIRE_PREVIEW, 'conversations:read'],
  'git.worktreeRebase': [IPC.GIT_WORKTREE_REBASE, 'git:write'],
  'git.worktreeSetTitle': [IPC.GIT_WORKTREE_SET_TITLE, 'git:write'],
}

function spec(action: string, channel: string, requiredScope: Scope): GitActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      const handler = GIT_HANDLERS[channel]
      if (!handler) {
        // A mapping naming a channel the shared table does not define is a
        // wiring bug, not a caller error — surfaced rather than swallowed.
        warn('git action has no handler for its channel', { connection_id: conn.id, action, channel })
        return { ok: false, error: { code: 'git_action_unmapped', message: `${action} has no handler` } }
      }
      try {
        return { ok: true, value: (await handler(args[0])) ?? null }
      } catch (err) {
        warn('git action threw', { connection_id: conn.id, action, error: String(err) })
        return { ok: false, error: { code: 'git_action_failed', message: String(err) } }
      }
    },
  }
}

/**
 * Subscription verbs, which cannot go through the channel table: they key on
 * the CALLER's identity. The connection id is the subscriber, and repo
 * events reach it as `ion:git-event` studio_events on that one connection —
 * not a broadcast, since another client may be watching a different repo.
 */
const SUBSCRIPTION_ACTIONS: Record<string, GitActionSpec> = {
  'git.subscribe': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const directory = (args[0] as { directory?: unknown } | null)?.directory
      if (typeof directory !== 'string' || !directory) {
        return { ok: false, error: { code: 'git_action_failed', message: 'directory is required' } }
      }
      try {
        const snapshot = await subscribeGit(
          { id: conn.id, send: (event) => conn.send({ type: 'studio_event', channel: IPC.GIT_EVENT, payload: event }) },
          directory,
        )
        return { ok: true, value: { snapshot } }
      } catch (err) {
        warn('git subscribe failed', { connection_id: conn.id, directory, error: String(err) })
        return { ok: false, error: { code: 'git_action_failed', message: String(err) } }
      }
    },
  },
  'git.unsubscribe': {
    requiredScope: 'conversations:read',
    handler: async (conn, args) => {
      const directory = (args[0] as { directory?: unknown } | null)?.directory
      if (typeof directory === 'string' && directory) unsubscribeGit(conn.id, directory)
      return { ok: true, value: { ok: true } }
    },
  },
}

export const GIT_ACTIONS: Record<string, GitActionSpec> = {
  ...Object.fromEntries(
    Object.entries(GIT_ACTION_MAP).map(([action, [channel, scope]]) => [action, spec(action, channel, scope)]),
  ),
  ...SUBSCRIPTION_ACTIONS,
}
