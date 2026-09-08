/**
 * Live compaction indicator (iOS send-disable parity).
 *
 * isCompacting is live-only, never persisted — same category as `status`. iOS
 * reads it to disable its own send button and to refuse a submit locally
 * (SessionViewModel+Submit.swift), the same way the desktop InputBar does.
 * Without this projection, iOS had no way to know a compaction was running at
 * all: its send button stayed active and a submitted prompt vanished silently
 * once the desktop's authoritative guard refused it.
 *
 * Split from remote-projection.test.ts (file-size cap) — see that file for
 * the full projectRemoteTabStates contract suite.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@phosphor-icons/react', () => ({
  Diamond: () => null, Square: () => null, StarFour: () => null,
  Triangle: () => null, Heart: () => null, Hexagon: () => null,
  Lightning: () => null, Terminal: () => null,
  DeviceMobile: () => null, Monitor: () => null, Gear: () => null,
}))
vi.mock('../../stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ conversationPanes: new Map() }) },
}))
vi.mock('../../preferences', () => ({
  usePreferencesStore: { getState: () => ({ uiZoom: 1, gitOpsMode: 'standard' }) },
}))

import { projectRemoteTabStates } from '../remote-projection'
import type { ProjectionStoreState } from '../remote-projection'

function makeTab(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'tab-1',
    conversationId: null,
    historicalSessionIds: [],
    lastKnownSessionId: null,
    status: 'idle',
    activeRequestId: null,
    lastEventAt: null,
    hasUnread: false,
    currentActivity: '',
    attachments: [],
    title: 'Tab One',
    customTitle: null,
    lastResult: null,
    sessionTools: [],
    sessionMcpServers: [],
    sessionSkills: [],
    sessionVersion: null,
    queuedPrompts: [],
    workingDirectory: '/proj',
    hasChosenDirectory: true,
    additionalDirs: [],
    bashResults: [],
    bashExecuting: false,
    bashExecId: null,
    pillColor: null,
    pillIcon: null,
    forkedFromSessionId: null,
    worktree: null,
    pendingWorktreeSetup: false,
    groupId: null,
    groupPinned: false,
    contextTokens: null,
    contextPercent: null,
    contextWindow: null,
    isTerminalOnly: false,
    engineProfileId: null,
    ...overrides,
  }
}

function makeState(tabs: any[]): ProjectionStoreState {
  return {
    tabs,
    terminalPanes: new Map(),
    conversationPanes: new Map(),
    resources: {},
    readResourceIds: new Set(),
    engineModelFallbacks: new Map(),
    computeConvFingerprint: () => '',
  }
}

describe('projectRemoteTabStates — live compaction indicator', () => {
  it('projects isCompacting when the engine is compacting this conversation', () => {
    const s = makeState([makeTab({ isCompacting: true })])
    expect(projectRemoteTabStates(s).tabs[0].isCompacting).toBe(true)
  })

  it('omits the field when not compacting', () => {
    const s = makeState([makeTab({ isCompacting: false })])
    expect(projectRemoteTabStates(s).tabs[0].isCompacting).toBeUndefined()
  })
})
