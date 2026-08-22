import { describe, expect, it } from 'vitest'
import { buildWorktreeMenuEntries } from './WorktreeRowMenu.items'
import type { IntegrationMember, WorktreeInventoryEntry } from '../../shared/types'

const entry = { worktreePath: '/worktrees/one', branchName: 'wt/one', label: 'one', sourceBranch: 'main', head: '', lastCommitSubject: '', isDirty: false, unlandedCommitCount: 0, needsSync: false, safeToDiscard: false } as WorktreeInventoryEntry
const membership = { worktreePath: entry.worktreePath, branchName: entry.branchName, pin: 'current', merge: 'unbuilt', pinnedSha: '', pinnedTreeHash: '', pinnedBaseSha: '', currentTreeHash: '' } as IntegrationMember
const actions = { onNewConversation() {}, onBeginRename() {}, onAddToBench() {}, onRemoveFromBench() {}, onMoveInBench() {}, onSync() {}, onLandAndRetire() {}, onReveal() {}, onReprovision() {}, onRequestDiscardRecordings() {},  }
const colors = new Proxy({}, { get: () => '#000' }) as never

describe('WorktreeRowMenu bench membership', () => {
  it('offers explicit removal for an enrolled worktree', () => {
    const entries = buildWorktreeMenuEntries({ entry, colors, strategy: 'merge-ff', enrolled: { membership, sourceBranch: 'main' }, benchIndex: 0, benchSize: 1, alreadyInBench: true, hasOpenConversations: false, actions })
    expect(entries.some((item) => item.type === 'action' && item.id === 'remove-from-bench' && item.label === 'Remove from integration bench')).toBe(true)
    expect(entries.some((item) => item.type === 'action' && item.id === 'add-to-bench')).toBe(false)
  })
})
