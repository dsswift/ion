import { existsSync, readFileSync } from 'fs'
import { TABS_FILE } from '../settings-store'
import { getMachineIdentity } from '../machine-identity'
import { warn as _warn } from '../logger'
import { lookupWorktreeRegistration } from '../worktree/inventory'
import { projectRendererTab } from './snapshot-project'
import { settlingIsPermanent } from '../../shared/worktree-conversations'
import type { RemoteTabState } from './protocol'

/**
 * Read settled history from the durable tab file. Settled records are not in
 * the renderer's active-tab projection, but iOS needs them before its first
 * Inbox render and before an owner renderer has hydrated.
 */
export function settledTabsSnapshot(): RemoteTabState[] {
  try {
    if (!existsSync(TABS_FILE)) return []
    const parsed = JSON.parse(readFileSync(TABS_FILE, 'utf-8')) as { settledHistory?: Array<Record<string, unknown>> }
    const machine = getMachineIdentity()
    return (parsed.settledHistory ?? [])
      .filter((tab): tab is Record<string, unknown> => typeof tab.id === 'string')
      .map((tab) => {
        const worktree = tab.worktree as { worktreePath?: unknown; branchName?: unknown; sourceBranch?: unknown; repoPath?: unknown; landedAt?: unknown } | null | undefined
        const worktreePath = typeof worktree?.worktreePath === 'string' ? worktree.worktreePath : null
        const tabRole = tab.tabRole === 'bench-conversation' || tab.tabRole === 'conflict-auto-fix'
          || tab.tabRole === 'verification-analysis'
          ? tab.tabRole
          : null
        // An ephemeral role settles permanently, whatever the filesystem says:
        // a bench checkout is rebuilt from its members' pins and a machine
        // conversation was never typeable. Read from the persisted role so the
        // answer survives the bench being torn down.
        const canRestoreSettled = !settlingIsPermanent(tabRole)
          && (worktreePath == null
            || (lookupWorktreeRegistration(worktreePath) != null && existsSync(worktreePath)))
        return projectRendererTab({
          id: tab.id as string,
          title: typeof tab.title === 'string' ? tab.title : 'Settled conversation',
          customTitle: typeof tab.customTitle === 'string' ? tab.customTitle : null,
          status: 'idle',
          workingDirectory: typeof tab.workingDirectory === 'string' ? tab.workingDirectory : '',
          executionHost: machine?.host,
          executionMachineId: machine?.machineId || undefined,
          permissionMode: 'auto',
          contextTokens: null,
          contextWindow: null,
          messageCount: 0,
          queuedPrompts: [],
          inputLocked: true,
          inputLockReason: 'settled',
          hasEngineExtension: tab.hasEngineExtension === true,
          engineProfileId: typeof tab.engineProfileId === 'string' ? tab.engineProfileId : null,
          conversationId: typeof tab.conversationId === 'string' ? tab.conversationId : null,
          lastActivityTs: typeof tab.lastMessageAt === 'number' ? tab.lastMessageAt : 0,
          createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : undefined,
          // Settled records keep their worktree identity so the settled shelf
          // and search results attribute them to the right project on iOS.
          worktree: worktreePath && typeof worktree?.branchName === 'string'
            && typeof worktree.sourceBranch === 'string' && typeof worktree.repoPath === 'string'
            ? {
                worktreePath,
                branchName: worktree.branchName,
                sourceBranch: worktree.sourceBranch,
                repoPath: worktree.repoPath,
                landedAt: typeof worktree.landedAt === 'number' ? worktree.landedAt : undefined,
              }
            : undefined,
          // Retained so a client can name the record's provenance, and so this
          // projection's permanence rule is auditable against its input.
          tabRole: tabRole ?? undefined,
          inboxState: 'settled',
          settledAt: typeof tab.settledAt === 'number' ? tab.settledAt : null,
          settledOverride: tab.settledOverride === 'auto' ? 'auto' : 'settled',
          canRestoreSettled,
          pillColor: null,
          pillIcon: null,
        }, { lastMessage: typeof tab.lastMessagePreview === 'string' ? tab.lastMessagePreview : null, permissionQueue: [] })
      })
  } catch (err) {
    // A corrupt persistence file must not block the active snapshot.
    _warn('desktop_snapshot', 'settled history read failed', { error: String(err) })
    return []
  }
}
