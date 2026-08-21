/**
 * worktreeRowState — the one-slot priority chain, and what stays visible.
 */
import { describe, it, expect } from 'vitest'
import { resolveRowState, resolveRowWords } from '../worktreeRowState'
import type { IntegrationMember, WorktreeInventoryEntry } from '../../../shared/types'

function entry(over: Partial<WorktreeInventoryEntry> = {}): WorktreeInventoryEntry {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
    label: 'a',
    sourceBranch: 'josh',
    head: 'aaa1111',
    lastCommitSubject: 'feat: a',
    isDirty: false,
    unlandedCommitCount: 0,
    needsSync: false,
    safeToDiscard: false,
    ...over,
  }
}

function member(over: Partial<IntegrationMember> = {}): IntegrationMember {
  return {
    worktreePath: '/wt/a',
    branchName: 'wt/a',
        pin: 'current',
    merge: 'merged',
    pinnedSha: 'aaa1111',
    pinnedTreeHash: 'tree-a',
    pinnedBaseSha: 'base-a',
    currentTreeHash: 'tree-a',
    ...over,
  }
}

describe('resolveRowState — one rung at a time', () => {
  it('shows nothing when nothing needs attention', () => {
    expect(resolveRowState({ entry: entry() }).kind).toBe('none')
  })

  it('shows an in-worktree conflicted operation above everything', () => {
    const state = resolveRowState({
      entry: entry({ operationState: 'rebasing', conflictedPaths: ['a.ts', 'b.ts'], needsSync: true }),
      membership: member({ merge: 'conflicted', pin: 'behind' }),
    })
    expect(state).toEqual({ kind: 'operation-conflict', operation: 'rebasing', conflictedCount: 2 })
  })

  it('shows a bench merge conflict above provisioning and freshness', () => {
    const state = resolveRowState({
      entry: entry({ provisionState: 'failed', needsSync: true }),
      membership: member({ merge: 'conflicted', pin: 'behind', conflictPaths: ['x.ts'], conflictsWith: ['wt/b'] }),
    })
    expect(state).toEqual({ kind: 'bench-conflict', paths: ['x.ts'], conflictsWith: ['wt/b'] })
  })

  it('shows a verification suspect above provisioning and freshness, but below an outright conflict', () => {
    const suspectOnly = resolveRowState({
      entry: entry({ provisionState: 'failed', needsSync: true }),
      membership: member(),
      verificationSuspect: { command: 'npm run typecheck' },
    })
    expect(suspectOnly).toEqual({ kind: 'bench-verification', command: 'npm run typecheck' })

    // A member absent from the tree entirely still outranks a suspect: the
    // conflict glyph wins when both facts are true of the same row.
    const bothTrue = resolveRowState({
      entry: entry(),
      membership: member({ merge: 'conflicted', conflictPaths: ['x.ts'] }),
      verificationSuspect: { command: 'npm run typecheck' },
    })
    expect(bothTrue.kind).toBe('bench-conflict')
  })

  it('carries "verify suspect" in the words when a higher-severity glyph is shown', () => {
    const words = resolveRowWords({
      entry: entry({ operationState: 'rebasing' }),
      membership: member(),
      verificationSuspect: { command: 'npm run typecheck' },
    })
    expect(words).toContain('verify suspect')
  })

  it('shows failed provisioning above a stale base', () => {
    const state = resolveRowState({
      entry: entry({ provisionState: 'failed', provisionError: 'npm ci failed', needsSync: true }),
    })
    expect(state).toEqual({ kind: 'provision-failed', reason: 'npm ci failed' })
  })

  it('shows a moved base ABOVE a behind pin, because sync rewrites the pin', () => {
    // The sequence bug this fixes: the row offered Update-pin first, so the
    // operator advanced the pin, paid a bench rebuild, then had to sync -- and
    // the rebase rewrote every commit, making the pin they just took stale.
    const state = resolveRowState({
      entry: entry({ needsSync: true }),
      membership: member({ pin: 'behind', pinnedSha: 'ccc3333' }),
    })
    // Ranked first, but the pin fact rides along rather than being dropped.
    expect(state).toEqual({ kind: 'needs-sync', blocked: false, syncing: false, pinAlsoBehind: true })
  })

  // The regression: a long-lived worktree is routinely BOTH behind its base and
  // ahead of its pin. Ranking alone made the pin completely invisible — the
  // slot showed sync, and the second line's `behind` word was suppressed
  // because it was gated on the slot not being the pin control, which it never
  // was in this state. An out-of-date pin with no surface at all is how a bench
  // silently held nine-hour-old content while the worktree kept committing.
  it('still reports the behind pin when the slot is showing sync', () => {
    const input = {
      entry: entry({ needsSync: true }),
      membership: member({ pin: 'behind', pinnedSha: 'ccc3333' }),
    }
    const state = resolveRowState(input)
    expect(state.kind).toBe('needs-sync')
    expect(state).toMatchObject({ pinAlsoBehind: true })
    expect(resolveRowWords(input)).toContain('behind')
  })

  it('does not claim a behind pin when the pin is current', () => {
    const state = resolveRowState({
      entry: entry({ needsSync: true }),
      membership: member({ pin: 'current' }),
    })
    expect(state).toEqual({ kind: 'needs-sync', blocked: false, syncing: false, pinAlsoBehind: undefined })
  })

  it('keeps sync ranked first even when it is blocked by a dirty worktree', () => {
    // Deliberately NOT reordered on dirty state: moving the control the operator
    // is reaching for based on a fact they may not have noticed is worse than
    // showing a disabled one. The correct sequence is the same either way --
    // clean, sync, then pin.
    const state = resolveRowState({
      entry: entry({ needsSync: true, isDirty: true }),
      membership: member({ pin: 'behind' }),
    })
    expect(state).toEqual({ kind: 'needs-sync', blocked: true, syncing: false, pinAlsoBehind: true })
  })

  it('shows the behind pin once the base is current', () => {
    const state = resolveRowState({
      entry: entry({ needsSync: false }),
      membership: member({ pin: 'behind', pinnedSha: 'ccc3333' }),
    })
    expect(state).toEqual({ kind: 'pin-behind', pinnedSha: 'ccc3333' })
  })

  it('marks a sync blocked when the worktree is dirty', () => {
    expect(resolveRowState({ entry: entry({ needsSync: true, isDirty: true }) }))
      .toEqual({ kind: 'needs-sync', blocked: true, syncing: false })
    expect(resolveRowState({ entry: entry({ needsSync: true }), syncing: true }))
      .toEqual({ kind: 'needs-sync', blocked: false, syncing: true })
  })

  it('never puts a work stage in the slot, whatever the stage', () => {
    // Operator markers used to occupy two rungs here, from when this slot was
    // the only place one could appear. The stage CHIP on line 2 is always
    // visible and already shows the state it sets, so a gutter copy would mark
    // every staged row twice -- two glyphs for one fact, which is what made a
    // list of reviewed rows hard to scan under the old verdict pair.
    for (const stage of ['verified', 'bug'] as const) {
      expect(resolveRowState({ entry: entry({ stage }), membership: member() }).kind)
        .toBe('none')
      // And it does not displace a real signal either.
      expect(resolveRowState({ entry: entry({ needsSync: true, stage }), membership: member() }).kind)
        .toBe('needs-sync')
    }
  })

  it('shows provisioning in flight last', () => {
    expect(resolveRowState({ entry: entry({ provisionState: 'building' }) }).kind).toBe('provisioning')
  })
})

describe('resolveRowState — landed worktree sealed', () => {
  it('does not surface stale status for a sealed landed worktree', () => {
    const state = resolveRowState({
      entry: entry({ landedAt: 1, needsSync: true, operationState: 'rebasing', conflictedPaths: ['a.ts'] }),
      membership: member({ merge: 'conflicted', pin: 'behind' }),
    })
    expect(state.kind).toBe('none')
    expect(resolveRowWords({ entry: entry({ landedAt: 1, needsSync: true }) })).toEqual([])
  })
})

describe('resolveRowState — concurrent member signals', () => {
  const input = {
    entry: entry({ needsSync: true }),
    membership: member({ pin: 'behind', merge: 'conflicted' }),
  }

  it('picks the most severe fact for the slot', () => {
    expect(resolveRowState(input).kind).toBe('bench-conflict')
  })

  it('still reports the hidden behind fact in the words', () => {
    expect(resolveRowWords(input)).toContain('behind')
  })
})

describe('resolveRowWords — pin vocabulary', () => {
  it('names an empty pin rather than claiming integration', () => {
    expect(resolveRowWords({ entry: entry(), membership: member({ pin: 'empty' }) }))
      .toContain('no commits yet')
  })

  it('names an absorbed pin', () => {
    expect(resolveRowWords({ entry: entry(), membership: member({ pin: 'absorbed' }) }))
      .toContain('landed')
  })

  it('names a gone worktree', () => {
    expect(resolveRowWords({ entry: entry(), membership: member({ pin: 'gone' }) }))
      .toContain('worktree gone')
  })

  it('keeps the dirty-sync refusal visible without hover', () => {
    expect(resolveRowWords({ entry: entry({ needsSync: true, isDirty: true }) }))
      .toContain('sync blocked')
  })

  it('says nothing for a clean unenrolled worktree', () => {
    expect(resolveRowWords({ entry: entry() })).toEqual([])
  })
})
