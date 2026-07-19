/**
 * Behavioral tests for projectRemoteTabStates — the extracted renderer-side
 * snapshot projection (formerly the ~300-line executeJavaScript IIFE in
 * main/remote/snapshot.ts).
 *
 * These are the DIRECT-output replacements for the source-regex assertions
 * the snapshot-*-parity suites used to run against the IIFE string: the
 * projection is now an importable pure function, so every contract that was
 * previously pinned by scanning stringified code is pinned here by feeding
 * store-state fixtures and asserting the projected fields.
 *
 * Contracts covered (each maps to a legacy source-pin):
 *   - stale-denial suppression on running/connecting tabs (HR-2 / suppression fix)
 *   - tab-type-agnostic denial promotion on idle/completed (HR-2)
 *   - instanceId stamping for extension-hosted tabs only (HR-2 scoping)
 *   - backgroundAgents fold via effectiveRunningChildrenCount (max, not sum)
 *   - engineProfileId projection (harness badge parity)
 *   - permissionMode / thinkingEffort from the active instance (WI-002)
 *   - uniform t.status projection, no tab-type fork (WI-001/WI-003)
 *   - cost/token cold-start parity (statusFields → lastResult precedence)
 *   - model-fallback per-instance projection
 *   - lastActivityTs max-across-all-roles scan; lastMessage user/assistant-only
 *   - convFingerprint routed through store.computeConvFingerprint
 *   - resource manifest projection with read-state
 */

import { describe, it, expect, vi } from 'vitest'

// TabStripShared re-exports icon presets referencing @phosphor-icons; stub the
// icon graph so the projection import stays node-pure (same pattern as
// TabStripShared-running-children.test.ts).
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

import { projectRemoteTabStates, projectResourceManifest } from '../remote-projection'
import type { ProjectionStoreState } from '../remote-projection'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInstance(overrides: Record<string, unknown> = {}): any {
  return {
    id: 'main',
    label: 'main',
    messages: [],
    messageCount: 0,
    modelOverride: null,
    sessionModel: null,
    permissionMode: 'auto',
    permissionDenied: null,
    permissionQueue: [],
    elicitationQueue: [],
    conversationIds: [],
    draftInput: '',
    agentStates: [],
    statusFields: null,
    planFilePath: null,
    dispatchTelemetry: [],
    contextBreakdown: null,
    ...overrides,
  }
}

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
    hasFileActivity: false,
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

function makeState(
  tabs: any[],
  panes: Array<[string, { instances: any[]; activeInstanceId: string | null }]> = [],
  extra: Partial<ProjectionStoreState> = {},
): ProjectionStoreState {
  return {
    tabs,
    terminalPanes: new Map(),
    conversationPanes: new Map(panes),
    resources: {},
    readResourceIds: new Set(),
    engineModelFallbacks: new Map(),
    computeConvFingerprint: () => '',
    ...extra,
  }
}

const denied = (toolName: string, toolUseId: string) => ({
  tools: [{ toolName, toolUseId, toolInput: { plan: 'x' } }],
})

// ─── Stale-denial suppression (running/connecting) ────────────────────────────

describe('projectRemoteTabStates — denial promotion guard', () => {
  it('does NOT promote permissionDenied on a running tab (stale-residue suppression)', () => {
    const s = makeState(
      [makeTab({ id: 't-run', status: 'running' })],
      [['t-run', { instances: [makeInstance({ permissionDenied: denied('ExitPlanMode', 'toolu_run1') })], activeInstanceId: 'main' }]],
    )
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].permissionQueue).toHaveLength(0)
  })

  it('does NOT promote permissionDenied on a connecting tab', () => {
    const s = makeState(
      [makeTab({ id: 't-conn', status: 'connecting' })],
      [['t-conn', { instances: [makeInstance({ permissionDenied: denied('AskUserQuestion', 'toolu_c1') })], activeInstanceId: 'main' }]],
    )
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].permissionQueue).toHaveLength(0)
  })

  it('does NOT promote on failed/dead tabs', () => {
    for (const status of ['failed', 'dead']) {
      const s = makeState(
        [makeTab({ id: 't-x', status })],
        [['t-x', { instances: [makeInstance({ permissionDenied: denied('ExitPlanMode', 'toolu_f1') })], activeInstanceId: 'main' }]],
      )
      expect(projectRemoteTabStates(s).tabs[0].permissionQueue).toHaveLength(0)
    }
  })

  it('promotes denials on an idle tab as denied-* entries', () => {
    const s = makeState(
      [makeTab({ id: 't-idle', status: 'idle' })],
      [['t-idle', { instances: [makeInstance({ permissionDenied: denied('ExitPlanMode', 'toolu_abc123') })], activeInstanceId: 'main' }]],
    )
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].permissionQueue).toHaveLength(1)
    expect(tabs[0].permissionQueue[0].questionId).toBe('denied-toolu_abc123')
    expect(tabs[0].permissionQueue[0].toolName).toBe('ExitPlanMode')
    expect(tabs[0].permissionQueue[0].toolTitle).toBe('ExitPlanMode')
    expect(tabs[0].permissionQueue[0].options).toEqual([])
  })

  it('promotes non-plan denials on a completed plain tab (tab-type-agnostic, HR-2)', () => {
    // A plain conversation's background sub-agents can produce non-plan tool
    // denials; a completed plain tab must still surface them to iOS.
    const s = makeState(
      [makeTab({ id: 't-done', status: 'completed', engineProfileId: null })],
      [['t-done', { instances: [makeInstance({ permissionDenied: denied('Bash', 'toolu_bash9') })], activeInstanceId: 'main' }]],
    )
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].permissionQueue).toHaveLength(1)
    expect(tabs[0].permissionQueue[0].questionId).toBe('denied-toolu_bash9')
  })

  it('stamps instanceId on promoted denials for extension-hosted tabs only (HR-2 scoping)', () => {
    const ext = makeState(
      [makeTab({ id: 't-ext', status: 'idle', engineProfileId: 'cos' })],
      [['t-ext', { instances: [makeInstance({ id: 'inst-1', permissionDenied: denied('AskUserQuestion', 'toolu_q1') })], activeInstanceId: 'inst-1' }]],
    )
    expect(projectRemoteTabStates(ext).tabs[0].permissionQueue[0].instanceId).toBe('inst-1')

    const plain = makeState(
      [makeTab({ id: 't-plain', status: 'idle', engineProfileId: null })],
      [['t-plain', { instances: [makeInstance({ permissionDenied: denied('AskUserQuestion', 'toolu_q2') })], activeInstanceId: 'main' }]],
    )
    expect(plain && projectRemoteTabStates(plain).tabs[0].permissionQueue[0].instanceId).toBeUndefined()
  })

  it('appends promoted denials AFTER live interactive queue entries', () => {
    const live = { questionId: 'q-live', toolTitle: 'Bash', options: [{ optionId: 'allow', label: 'Allow' }] }
    const s = makeState(
      [makeTab({ id: 't-mix', status: 'idle' })],
      [['t-mix', { instances: [makeInstance({ permissionQueue: [live], permissionDenied: denied('ExitPlanMode', 'toolu_p') })], activeInstanceId: 'main' }]],
    )
    const q = projectRemoteTabStates(s).tabs[0].permissionQueue
    expect(q.map((e) => e.questionId)).toEqual(['q-live', 'denied-toolu_p'])
  })
})

// ─── Background-agents fold ───────────────────────────────────────────────────

describe('projectRemoteTabStates — running-children fold (backgroundAgents parity)', () => {
  it('plain tab: backgroundAgents-only source drives runningAgentCount + hasRunningChildren', () => {
    const inst = makeInstance({ agentStates: [], statusFields: { label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 0, backgroundAgents: 2 } })
    const s = makeState([makeTab({ id: 't-bg' })], [['t-bg', { instances: [inst], activeInstanceId: 'main' }]])
    const tab = projectRemoteTabStates(s).tabs[0]
    expect(tab.conversationInstances?.[0].runningAgentCount).toBe(2)
    expect(tab.hasRunningChildren).toBe(true)
  })

  it('takes the MAX of agentStates and backgroundAgents, not the sum', () => {
    const inst = makeInstance({
      agentStates: [{ name: 'a', status: 'running' }, { name: 'b', status: 'running' }, { name: 'c', status: 'done' }],
      statusFields: { label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 0, backgroundAgents: 1 },
    })
    const s = makeState([makeTab({ id: 't-max' })], [['t-max', { instances: [inst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].runningAgentCount).toBe(2)
  })

  it('omits runningAgentCount and hasRunningChildren when both sources are zero', () => {
    const inst = makeInstance({ agentStates: [{ name: 'a', status: 'done' }], statusFields: { label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 0, backgroundAgents: 0 } })
    const s = makeState([makeTab({ id: 't-zero' })], [['t-zero', { instances: [inst], activeInstanceId: 'main' }]])
    const tab = projectRemoteTabStates(s).tabs[0]
    expect(tab.conversationInstances?.[0].runningAgentCount).toBeUndefined()
    expect(tab.hasRunningChildren).toBeUndefined()
  })
})

// ─── Per-instance signals ─────────────────────────────────────────────────────

describe('projectRemoteTabStates — conversationInstances', () => {
  it('derives waitingState: question outranks plan-ready', () => {
    const inst = makeInstance({
      permissionDenied: { tools: [{ toolName: 'ExitPlanMode', toolUseId: 'a' }, { toolName: 'AskUserQuestion', toolUseId: 'b' }] },
    })
    const s = makeState([makeTab({ id: 't-ws', status: 'idle' })], [['t-ws', { instances: [inst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].waitingState).toBe('question')
  })

  it('derives waitingState plan-ready from an ExitPlanMode-only denial', () => {
    const inst = makeInstance({ permissionDenied: denied('ExitPlanMode', 'p1') })
    const s = makeState([makeTab({ id: 't-pr', status: 'idle' })], [['t-pr', { instances: [inst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].waitingState).toBe('plan-ready')
  })

  it('sets isRunning from statusFields.state (running/connecting/starting)', () => {
    for (const st of ['running', 'connecting', 'starting']) {
      const inst = makeInstance({ statusFields: { label: '', state: st, model: '', contextPercent: 0, contextWindow: 0 } })
      const s = makeState([makeTab({ id: 't-r' })], [['t-r', { instances: [inst], activeInstanceId: 'main' }]])
      expect(projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].isRunning).toBe(true)
    }
    const idleInst = makeInstance({ statusFields: { label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 0 } })
    const s2 = makeState([makeTab({ id: 't-i' })], [['t-i', { instances: [idleInst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s2).tabs[0].conversationInstances?.[0].isRunning).toBeUndefined()
  })

  it('projects the per-instance model fallback from engineModelFallbacks (strings only)', () => {
    const inst = makeInstance({ id: 'inst-1' })
    const fallbacks = new Map([[
      't-mf:inst-1',
      { requestedModel: 'claude-opus-4-6', fallbackModel: 'claude-sonnet-4-6', reason: 'overloaded', at: 123 },
    ]])
    const s = makeState([makeTab({ id: 't-mf' })], [['t-mf', { instances: [inst], activeInstanceId: 'inst-1' }]], { engineModelFallbacks: fallbacks })
    const mf = projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].modelFallback
    expect(mf).toEqual({ requestedModel: 'claude-opus-4-6', fallbackModel: 'claude-sonnet-4-6' })
    // reason/at are intentionally NOT forwarded
    expect(mf as any).not.toHaveProperty('reason')
  })

  it('omits modelFallback when no entry exists for the instance', () => {
    const inst = makeInstance()
    const s = makeState([makeTab({ id: 't-nf' })], [['t-nf', { instances: [inst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].conversationInstances?.[0].modelFallback).toBeUndefined()
  })
})

// ─── WI-001/002/003 uniform projections ───────────────────────────────────────

describe('projectRemoteTabStates — uniform status/mode projections', () => {
  it('projects t.status directly for plain and extension tabs (no tab-type fork)', () => {
    const s = makeState(
      [
        makeTab({ id: 't-a', status: 'running', engineProfileId: null }),
        makeTab({ id: 't-b', status: 'completed', engineProfileId: 'cos' }),
      ],
      [
        ['t-a', { instances: [makeInstance()], activeInstanceId: 'main' }],
        ['t-b', { instances: [makeInstance()], activeInstanceId: 'main' }],
      ],
    )
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].status).toBe('running')
    expect(tabs[1].status).toBe('completed')
  })

  it('reads permissionMode from the ACTIVE instance (WI-002), defaulting to auto', () => {
    const s = makeState(
      [makeTab({ id: 't-pm' })],
      [['t-pm', { instances: [makeInstance({ permissionMode: 'plan' })], activeInstanceId: 'main' }]],
    )
    expect(projectRemoteTabStates(s).tabs[0].permissionMode).toBe('plan')
    // No pane at all → auto
    const bare = makeState([makeTab({ id: 't-none' })])
    expect(projectRemoteTabStates(bare).tabs[0].permissionMode).toBe('auto')
  })

  it("omits thinkingEffort when 'off'/absent, projects it when set", () => {
    const s = makeState(
      [makeTab({ id: 't-te' })],
      [['t-te', { instances: [makeInstance({ thinkingEffort: 'high' })], activeInstanceId: 'main' }]],
    )
    expect(projectRemoteTabStates(s).tabs[0].thinkingEffort).toBe('high')
    const off = makeState(
      [makeTab({ id: 't-off' })],
      [['t-off', { instances: [makeInstance({ thinkingEffort: 'off' })], activeInstanceId: 'main' }]],
    )
    expect(projectRemoteTabStates(off).tabs[0].thinkingEffort).toBeUndefined()
  })

  it('projects engineProfileId (null for plain, id for extension, null for empty string)', () => {
    const s = makeState([
      makeTab({ id: 't-1', engineProfileId: 'profile-abc' }),
      makeTab({ id: 't-2', engineProfileId: null }),
      makeTab({ id: 't-3', engineProfileId: '' }),
    ])
    const { tabs } = projectRemoteTabStates(s)
    expect(tabs[0].engineProfileId).toBe('profile-abc')
    expect(tabs[0].hasEngineExtension).toBe(true)
    expect(tabs[1].engineProfileId).toBeNull()
    expect(tabs[1].hasEngineExtension).toBeUndefined()
    expect(tabs[2].engineProfileId).toBeNull()
    expect(tabs[2].hasEngineExtension).toBeUndefined()
  })
})

// ─── Message tail: preview, activity, fingerprint ─────────────────────────────

describe('projectRemoteTabStates — message tail projections', () => {
  it('lastMessageContent comes from the last user/assistant row, capped at 100 chars', () => {
    const msgs = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: 100 },
      { id: 'm2', role: 'assistant', content: 'x'.repeat(150), timestamp: 200 },
      { id: 'm3', role: 'tool', content: 'tool output', timestamp: 300 },
    ]
    const s = makeState([makeTab({ id: 't-lm' })], [['t-lm', { instances: [makeInstance({ messages: msgs })], activeInstanceId: 'main' }]])
    const tab = projectRemoteTabStates(s).tabs[0]
    expect(tab.lastMessageContent).toBe('x'.repeat(100))
  })

  it('lastActivityTs takes the max timestamp across ALL roles including a trailing tool run', () => {
    const msgs = [
      { id: 'm1', role: 'assistant', content: 'done?', timestamp: 100 },
      { id: 'm2', role: 'tool', content: 'still going', timestamp: 999 },
    ]
    const s = makeState([makeTab({ id: 't-ts' })], [['t-ts', { instances: [makeInstance({ messages: msgs })], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].lastActivityTs).toBe(999)
  })

  it('messageCount prefers live messages length, falls back to persisted messageCount', () => {
    const live = makeState([makeTab({ id: 't-mc' })], [['t-mc', { instances: [makeInstance({ messages: [{ id: 'm', role: 'user', content: 'x', timestamp: 1 }], messageCount: 40 })], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(live).tabs[0].messageCount).toBe(1)
    const skeleton = makeState([makeTab({ id: 't-sk' })], [['t-sk', { instances: [makeInstance({ messages: [], messageCount: 40 })], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(skeleton).tabs[0].messageCount).toBe(40)
  })

  it('routes convFingerprint through store.computeConvFingerprint per tab', () => {
    const s = makeState([makeTab({ id: 't-fp' })], [], {
      computeConvFingerprint: (tabId: string) => `fp-of-${tabId}`,
    })
    expect(projectRemoteTabStates(s).tabs[0].convFingerprint).toBe('fp-of-t-fp')
  })
})

// ─── Cost / token cold-start parity ───────────────────────────────────────────

describe('projectRemoteTabStates — cost/token precedence', () => {
  const sf = (over: Record<string, unknown>) => ({ label: '', state: 'idle', model: '', contextPercent: 0, contextWindow: 0, ...over })

  it('prefers live statusFields.runCostUsd over lastResult.totalCostUsd', () => {
    const inst = makeInstance({ statusFields: sf({ runCostUsd: 0.5 }) })
    const tab = makeTab({ id: 't-c', lastResult: { totalCostUsd: 9.9, durationMs: 1, numTurns: 1, usage: {}, sessionId: 's' } })
    const s = makeState([tab], [['t-c', { instances: [inst], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].runCostUsd).toBe(0.5)
  })

  it('falls back to lastResult.totalCostUsd when no live cost', () => {
    const tab = makeTab({ id: 't-f', lastResult: { totalCostUsd: 1.25, durationMs: 1, numTurns: 1, usage: {}, sessionId: 's' } })
    const s = makeState([tab], [['t-f', { instances: [makeInstance()], activeInstanceId: 'main' }]])
    expect(projectRemoteTabStates(s).tabs[0].runCostUsd).toBe(1.25)
  })

  it('emits undefined (not 0) for all cost/token fields on never-run tabs', () => {
    const s = makeState([makeTab({ id: 't-n' })])
    const tab = projectRemoteTabStates(s).tabs[0]
    expect(tab.runCostUsd).toBeUndefined()
    expect(tab.conversationCostUsd).toBeUndefined()
    expect(tab.conversationTurns).toBeUndefined()
    expect(tab.inputTokens).toBeUndefined()
    expect(tab.outputTokens).toBeUndefined()
    expect(tab.cacheReadTokens).toBeUndefined()
    expect(tab.cacheCreationTokens).toBeUndefined()
  })

  it('projects usage token fields from lastResult and conversationTurns with live precedence', () => {
    const inst = makeInstance({ statusFields: sf({ conversationTurns: 7, conversationCostUsd: 3.5 }) })
    const tab = makeTab({
      id: 't-u',
      lastResult: {
        totalCostUsd: 1, durationMs: 1, numTurns: 2, conversationTurns: 5, sessionId: 's',
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 },
      },
    })
    const s = makeState([tab], [['t-u', { instances: [inst], activeInstanceId: 'main' }]])
    const out = projectRemoteTabStates(s).tabs[0]
    expect(out.conversationTurns).toBe(7) // live wins
    expect(out.conversationCostUsd).toBe(3.5)
    expect(out.inputTokens).toBe(1000)
    expect(out.outputTokens).toBe(200)
    expect(out.cacheReadTokens).toBe(50)
    expect(out.cacheCreationTokens).toBe(25)
  })
})

// ─── Terminal instances + elicitations ────────────────────────────────────────

describe('projectRemoteTabStates — terminals and elicitations', () => {
  it('projects terminal instances with label/kind/readOnly/cwd defaults', () => {
    const s = makeState([makeTab({ id: 't-term', workingDirectory: '/w' })])
    s.terminalPanes.set('t-term', {
      instances: [{ id: 'sh1', label: '', kind: '', readOnly: false, cwd: '' } as any],
      activeInstanceId: null,
    })
    const tab = projectRemoteTabStates(s).tabs[0]
    expect(tab.terminalInstances).toEqual([{ id: 'sh1', label: 'Shell', kind: 'user', readOnly: false, cwd: '/w' }])
    expect(tab.activeTerminalInstanceId).toBe('sh1')
  })

  it('projects the active instance elicitationQueue', () => {
    const elicit = { requestId: 'r1', mode: 'approval', schema: { q: 'ok?' } }
    const s = makeState(
      [makeTab({ id: 't-el' })],
      [['t-el', { instances: [makeInstance({ elicitationQueue: [elicit] })], activeInstanceId: 'main' }]],
    )
    expect(projectRemoteTabStates(s).tabs[0].elicitationQueue).toEqual([elicit])
  })
})

// ─── Resource manifest ────────────────────────────────────────────────────────

describe('projectResourceManifest', () => {
  it('projects per-kind items with read state from readResourceIds', () => {
    const manifest = projectResourceManifest({
      resources: {
        briefing: [
          { id: 'r1', kind: 'briefing', title: 'Morning', createdAt: '2025-01-01', conversationId: 'c1' } as any,
          { id: 'r2', kind: 'briefing', title: '', createdAt: '2025-01-02' } as any,
        ],
      },
      readResourceIds: new Set(['r1']),
    })
    expect(manifest.briefing).toEqual([
      { id: 'r1', kind: 'briefing', title: 'Morning', createdAt: '2025-01-01', read: true, conversationId: 'c1' },
      { id: 'r2', kind: 'briefing', title: '', createdAt: '2025-01-02', read: false, conversationId: undefined },
    ])
  })

  it('returns an empty manifest for empty resources', () => {
    expect(projectResourceManifest({ resources: {}, readResourceIds: new Set() })).toEqual({})
  })
})
