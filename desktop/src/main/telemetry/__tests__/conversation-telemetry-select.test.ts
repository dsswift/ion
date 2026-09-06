import { describe, expect, it } from 'vitest'
import { mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RegistryEntry } from '../../worktree/registry'
import { MAX_CONVERSATIONS, selectConversations, worktreeForCwd } from '../conversation-telemetry-select'

const WORKTREE_CREATED_AT = 1_700_000_000_000

function registryEntry(worktreePath: string): RegistryEntry {
  return {
    worktreePath,
    repoPath: '/repo',
    branchName: 'wt/x',
    sourceBranch: 'main',
    createdAt: WORKTREE_CREATED_AT,
  } as RegistryEntry
}

/**
 * Write a conversation whose header names `workingDirectory`, and stamp its
 * mtime. The mtime is what the sweep prunes on, so a fixture that does not set
 * it would pass for the wrong reason.
 */
function writeConversation(
  dir: string,
  id: string,
  workingDirectory: string,
  mtimeMs: number,
  parentId?: string,
): void {
  const tree = join(dir, `${id}.tree.jsonl`)
  writeFileSync(tree, JSON.stringify({ meta: true, id, leafId: 'e0', version: 2, workingDirectory }) + '\n'
    + JSON.stringify({ id: 'e0', parentId: null, type: 'message', timestamp: mtimeMs, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } }) + '\n')
  writeFileSync(
    join(dir, `${id}.llm.jsonl`),
    JSON.stringify({ meta: true, id, version: 2, createdAt: mtimeMs, model: 'm', ...(parentId ? { parentId } : {}) }) + '\n',
  )
  const seconds = mtimeMs / 1000
  utimesSync(tree, seconds, seconds)
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ion-telemetry-select-'))
}

describe('conversation telemetry selection', () => {
  it('resolves a worktree from a path inside it, and the innermost when nested', () => {
    const registry = [registryEntry('/wt/outer'), registryEntry('/wt/outer/inner')]
    expect(worktreeForCwd('/wt/outer/src', registry)?.worktreePath).toBe('/wt/outer')
    expect(worktreeForCwd('/wt/outer/inner/src', registry)?.worktreePath).toBe('/wt/outer/inner')
    // A sibling that merely shares a prefix is not inside it.
    expect(worktreeForCwd('/wt/outer-other', registry)).toBeNull()
    expect(worktreeForCwd('/plain/repo', registry)).toBeNull()
  })

  it('returns every conversation in the worktree and nothing else', () => {
    const dir = tempDir()
    const after = WORKTREE_CREATED_AT + 60_000
    writeConversation(dir, '100-aaa', '/wt/work', after)
    writeConversation(dir, '200-bbb', '/wt/work', after + 1000)
    writeConversation(dir, '300-ccc', '/wt/other', after)
    writeConversation(dir, '400-ddd', '/plain/repo', after)

    const selection = selectConversations('/wt/work/src', '100-aaa', { conversationsDir: dir }, [registryEntry('/wt/work')])

    expect(selection.scope).toBe('worktree')
    expect(selection.worktree?.worktreePath).toBe('/wt/work')
    // Oldest first, so the progression through a piece of work reads in order.
    expect(selection.conversationIds).toEqual(['100-aaa', '200-bbb'])
  })

  it('keeps a member last written before the entry was registered', () => {
    const dir = tempDir()
    // A registry entry can name a directory older than its registration — a
    // plain checkout registered as work, or a worktree re-registered with a
    // fresh createdAt. Skipping files older than createdAt would look safe and
    // would silently drop this conversation.
    writeConversation(dir, '050-old', '/wt/work', WORKTREE_CREATED_AT - 86_400_000)
    writeConversation(dir, '100-new', '/wt/work', WORKTREE_CREATED_AT + 1000)

    const selection = selectConversations('/wt/work', '100-new', { conversationsDir: dir }, [registryEntry('/wt/work')])

    expect(selection.conversationIds).toEqual(['050-old', '100-new'])
    expect(selection.truncated).toBe(false)
  })

  it('caps a large checkout at the most recently active, and says that it did', () => {
    const dir = tempDir()
    const total = MAX_CONVERSATIONS + 5
    for (let i = 0; i < total; i += 1) {
      // Zero-padded so id order and activity order agree, which makes the
      // dropped set predictable: the five least recently active.
      writeConversation(dir, `c${String(i).padStart(3, '0')}`, '/wt/work', WORKTREE_CREATED_AT + i * 1000)
    }

    const selection = selectConversations('/wt/work', 'c000', { conversationsDir: dir }, [registryEntry('/wt/work')])

    expect(selection.conversationIds).toHaveLength(MAX_CONVERSATIONS)
    expect(selection.matchedCount).toBe(total)
    expect(selection.truncated).toBe(true)
    // The oldest five are the ones left out, and the survivors read oldest first.
    expect(selection.conversationIds[0]).toBe('c005')
    expect(selection.conversationIds.at(-1)).toBe(`c${String(total - 1).padStart(3, '0')}`)
  })

  it('refuses to widen outside a worktree and returns the cleared-and-continued chain', () => {
    const dir = tempDir()
    const now = WORKTREE_CREATED_AT
    writeConversation(dir, '100-parent', '/plain/repo', now)
    writeConversation(dir, '200-child', '/plain/repo', now + 1000, '100-parent')
    // A neighbour in the same plain directory belongs to nobody in particular.
    writeConversation(dir, '300-other', '/plain/repo', now + 2000)

    const selection = selectConversations('/plain/repo', '200-child', { conversationsDir: dir }, [registryEntry('/wt/work')])

    expect(selection.scope).toBe('self')
    expect(selection.conversationIds).toEqual(['100-parent', '200-child'])
  })

  it('falls back to the calling chain when a worktree sweep finds nothing', () => {
    const dir = tempDir()
    writeConversation(dir, '100-self', '/somewhere/else', WORKTREE_CREATED_AT + 1000)

    const selection = selectConversations('/wt/empty', '100-self', { conversationsDir: dir }, [registryEntry('/wt/empty')])

    expect(selection.scope).toBe('worktree')
    expect(selection.conversationIds).toEqual(['100-self'])
  })
})
