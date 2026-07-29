/**
 * tab-slice-next-active — pure next-active selection unit tests.
 *
 * Pins the group-aware selection rules pickNextActiveTab follows when closeTab
 * needs to choose which remaining tab to activate:
 *   - in-group sibling preferred (the tab after the closed one, else before)
 *   - cross-group fallback only when the closed tab's group is emptied
 *   - flat ('off') mode behaves as nearest-by-flat-index
 *   - single remaining tab is selected
 *   - closing the only tab returns null (caller builds a fresh blank tab)
 */

import { describe, it, expect } from 'vitest'
import { pickNextActiveTab, type NextActiveGroupContext } from '../tab-slice-next-active'
import type { TabState, TabGroup } from '../../../../shared/types'

// Minimal TabState factory — only the fields the helper reads (id,
// workingDirectory, groupId) carry meaning; the rest satisfy the type.
function makeTab(over: Partial<TabState> & { id: string }): TabState {
  return {
    title: 'Tab',
    customTitle: null,
    workingDirectory: '/home/user',
    hasChosenDirectory: true,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    permissionQueue: [],
    permissionDenied: null,
    attachments: [],
    draftInput: '',
    messages: [],
    queuedPrompts: [],
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    bashExecuting: false,
    bashExecId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    additionalDirs: [],
    permissionMode: 'auto',
    planFilePath: null,
    bashResults: [],
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isCompacting: false,
    isTerminalOnly: false,
    sessionModel: null,
    modelOverride: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    conversationId: null,
    lastResult: null,
    lastMessagePreview: null,
    ...over,
  } as TabState
}

function group(id: string, isDefault = false): TabGroup {
  return { id, label: id, isDefault, order: 0, collapsed: false }
}

const MANUAL_GROUPS: TabGroup[] = [group('planning', true), group('inprogress')]
const manualCtx: NextActiveGroupContext = { mode: 'manual', groups: MANUAL_GROUPS }
const autoCtx: NextActiveGroupContext = { mode: 'auto', groups: [] }
const offCtx: NextActiveGroupContext = { mode: 'off', groups: [] }

describe('pickNextActiveTab — manual mode', () => {
  it('prefers the in-group sibling AFTER the closed tab', () => {
    const tabs = [
      makeTab({ id: 'a', groupId: 'planning' }),
      makeTab({ id: 'b', groupId: 'planning' }), // closed
      makeTab({ id: 'c', groupId: 'planning' }), // expected (after)
      makeTab({ id: 'd', groupId: 'inprogress' }),
    ]
    expect(pickNextActiveTab('b', tabs, manualCtx)).toBe('c')
  })

  it('falls to the in-group sibling BEFORE when none follows', () => {
    const tabs = [
      makeTab({ id: 'a', groupId: 'planning' }), // expected (before)
      makeTab({ id: 'b', groupId: 'planning' }), // closed (last in group)
      makeTab({ id: 'c', groupId: 'inprogress' }),
    ]
    expect(pickNextActiveTab('b', tabs, manualCtx)).toBe('a')
  })

  it('falls back across groups ONLY when the closed tab is the last in its group', () => {
    const tabs = [
      makeTab({ id: 'a', groupId: 'inprogress' }),
      makeTab({ id: 'b', groupId: 'planning' }), // closed — sole planning tab
      makeTab({ id: 'c', groupId: 'inprogress' }),
    ]
    // Group 'planning' is emptied → nearest-by-flat-index. closedIndex=1,
    // remaining=[a,c]; min(1, 1)=1 → 'c'.
    expect(pickNextActiveTab('b', tabs, manualCtx)).toBe('c')
  })

  it('treats an unknown/absent groupId as the default group', () => {
    const tabs = [
      makeTab({ id: 'a', groupId: null }),        // → default ('planning')
      makeTab({ id: 'b', groupId: 'planning' }),  // closed
      makeTab({ id: 'c', groupId: null }),        // → default ('planning'), expected (after)
    ]
    expect(pickNextActiveTab('b', tabs, manualCtx)).toBe('c')
  })
})

describe('pickNextActiveTab — auto mode (by workingDirectory)', () => {
  it('prefers the same-directory sibling after the closed tab', () => {
    const tabs = [
      makeTab({ id: 'a', workingDirectory: '/repo/x' }),
      makeTab({ id: 'b', workingDirectory: '/repo/x' }), // closed
      makeTab({ id: 'c', workingDirectory: '/repo/x' }), // expected
      makeTab({ id: 'd', workingDirectory: '/repo/y' }),
    ]
    expect(pickNextActiveTab('b', tabs, autoCtx)).toBe('c')
  })

  it('falls back across directories when the directory is emptied', () => {
    const tabs = [
      makeTab({ id: 'a', workingDirectory: '/repo/y' }),
      makeTab({ id: 'b', workingDirectory: '/repo/x' }), // closed — sole /repo/x tab
      makeTab({ id: 'c', workingDirectory: '/repo/y' }),
    ]
    // closedIndex=1, remaining=[a,c], min(1,1)=1 → 'c'.
    expect(pickNextActiveTab('b', tabs, autoCtx)).toBe('c')
  })
})

describe('pickNextActiveTab — off mode (flat)', () => {
  it('selects nearest-by-flat-index', () => {
    const tabs = [makeTab({ id: 'a' }), makeTab({ id: 'b' }), makeTab({ id: 'c' })]
    // close 'b': closedIndex=1, remaining=[a,c], min(1,1)=1 → 'c'.
    expect(pickNextActiveTab('b', tabs, offCtx)).toBe('c')
  })

  it('clamps to the last remaining tab when closing the final tab', () => {
    const tabs = [makeTab({ id: 'a' }), makeTab({ id: 'b' })]
    // close 'b': closedIndex=1, remaining=[a], min(1,0)=0 → 'a'.
    expect(pickNextActiveTab('b', tabs, offCtx)).toBe('a')
  })
})

describe('pickNextActiveTab — degenerate cases', () => {
  it('selects the single remaining tab', () => {
    const tabs = [makeTab({ id: 'a', groupId: 'planning' }), makeTab({ id: 'b', groupId: 'inprogress' })]
    expect(pickNextActiveTab('a', tabs, manualCtx)).toBe('b')
  })

  it('returns null when closing the only tab', () => {
    const tabs = [makeTab({ id: 'a', groupId: 'planning' })]
    expect(pickNextActiveTab('a', tabs, manualCtx)).toBeNull()
  })

  it('returns null when the closing id is not present', () => {
    const tabs = [makeTab({ id: 'a' }), makeTab({ id: 'b' })]
    expect(pickNextActiveTab('zzz', tabs, offCtx)).toBeNull()
  })
})
