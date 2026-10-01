import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EnvironmentPhase, EnvironmentPhaseState } from '@ion/shared/types-environments'
import type { QuestionsStateSnapshot, QuestionsWorkflowState } from '@ion/shared/questions-state'

/**
 * These pin the Environment union (ADR-033). Guided Questions used to be a
 * single-Environment feature by accident: the broadcast listener defaulted to
 * the local Environment, hydration only ever asked the local server, and a
 * patch named a workflow rather than a tab so it routed local too. A question
 * parked on a visited server therefore never rendered, and would have been
 * answered at the wrong machine if it had.
 */
const h = vi.hoisted(() => {
  const snapshots = new Map<string, QuestionsStateSnapshot>()
  const targets: string[] = []
  let current = 'local'
  let stateListener: ((snapshot: QuestionsStateSnapshot, environmentId?: string) => void) | null = null
  let registryListener: ((states: Map<string, EnvironmentPhaseState>) => void) | null = null
  return {
    snapshots,
    targets,
    setCurrent: (id: string) => { current = id },
    currentTarget: () => current,
    questionsGetState: vi.fn(() => Promise.resolve(snapshots.get(current) ?? { workflows: [] })),
    questionsPatch: vi.fn(() => Promise.resolve({ actionId: 'a', accepted: true })),
    onQuestionsState: vi.fn((cb: (s: QuestionsStateSnapshot, e?: string) => void) => {
      stateListener = cb
      return () => { stateListener = null }
    }),
    emitState: (environmentId: string, snapshot: QuestionsStateSnapshot) => stateListener?.(snapshot, environmentId),
    subscribe: vi.fn((cb: (states: Map<string, EnvironmentPhaseState>) => void) => {
      registryListener = cb
      cb(new Map())
      return () => { registryListener = null }
    }),
    emitPhases: (phases: Record<string, EnvironmentPhase>) => {
      const map = new Map<string, EnvironmentPhaseState>()
      for (const [id, phase] of Object.entries(phases)) map.set(id, { phase })
      registryListener?.(map)
    },
  }
})

vi.mock('../host/host-instance', () => ({
  host: { shell: { questionsGetState: h.questionsGetState, questionsPatch: h.questionsPatch, onQuestionsState: h.onQuestionsState } },
}))
vi.mock('../studio/connection/registry', () => ({ registry: { subscribe: h.subscribe } }))
vi.mock('../studio/connection/tab-environment', () => ({
  withTargetEnvironment: <T,>(environmentId: string, fn: () => T): T => {
    h.targets.push(environmentId)
    const previous = h.currentTarget()
    h.setCurrent(environmentId)
    try {
      return fn()
    } finally {
      h.setCurrent(previous)
    }
  },
}))
vi.mock('../rendererLogger', () => ({ rWarn: vi.fn() }))

function workflow(id: string, tabId: string): QuestionsWorkflowState {
  return {
    workflowId: id,
    requestId: `${id}-req`,
    sessionKey: tabId,
    phase: 'collecting',
    request: { title: id, questions: [] } as QuestionsWorkflowState['request'],
    draft: [],
    history: [],
    revision: 1,
    startedAt: 1,
  }
}

async function load() {
  const mod = await import('./questions-store')
  mod.hydrateQuestions()
  return mod
}

beforeEach(() => {
  vi.resetModules()
  h.snapshots.clear()
  h.targets.length = 0
  h.setCurrent('local')
  h.questionsGetState.mockClear()
  h.questionsPatch.mockClear()
})

describe('hydrateQuestions', () => {
  it('pulls every reachable Environment, not just the local one', async () => {
    h.snapshots.set('local', { workflows: [workflow('w-local', 'tab-local')] })
    h.snapshots.set('devbox', { workflows: [workflow('w-devbox', 'tab-devbox')] })
    const { useQuestionsStore } = await load()

    h.emitPhases({ local: 'connected', devbox: 'connected' })
    await vi.waitFor(() => expect(useQuestionsStore.getState().workflows).toHaveLength(2))

    expect(h.targets).toContain('devbox')
    expect(useQuestionsStore.getState().workflows.map((w) => w.workflowId).sort()).toEqual(['w-devbox', 'w-local'])
  })

  it('does not pull an Environment that is not reachable', async () => {
    const { useQuestionsStore } = await load()
    h.emitPhases({ local: 'connected', devbox: 'offline' })
    await vi.waitFor(() => expect(h.questionsGetState).toHaveBeenCalledTimes(1))
    expect(h.targets).not.toContain('devbox')
    expect(useQuestionsStore.getState().byEnvironment.devbox).toBeUndefined()
  })

  it('keeps one Environment’s workflows when another publishes a snapshot', async () => {
    h.snapshots.set('local', { workflows: [workflow('w-local', 'tab-local')] })
    h.snapshots.set('devbox', { workflows: [workflow('w-devbox', 'tab-devbox')] })
    const { useQuestionsStore } = await load()
    h.emitPhases({ local: 'connected', devbox: 'connected' })
    await vi.waitFor(() => expect(useQuestionsStore.getState().workflows).toHaveLength(2))

    // devbox answers its own question: its list empties, local's must not.
    h.emitState('devbox', { workflows: [] })

    expect(useQuestionsStore.getState().workflows.map((w) => w.workflowId)).toEqual(['w-local'])
  })

  it('drops an Environment’s workflows when it stops being reachable', async () => {
    h.snapshots.set('devbox', { workflows: [workflow('w-devbox', 'tab-devbox')] })
    const { useQuestionsStore } = await load()
    h.emitPhases({ devbox: 'connected' })
    await vi.waitFor(() => expect(useQuestionsStore.getState().workflows).toHaveLength(1))

    h.emitPhases({ devbox: 'offline' })

    expect(useQuestionsStore.getState().workflows).toEqual([])
  })
})

describe('patchQuestions', () => {
  it('routes to the Environment holding the workflow, not the local one', async () => {
    h.snapshots.set('devbox', { workflows: [workflow('w-devbox', 'tab-devbox')] })
    const { patchQuestions, useQuestionsStore } = await load()
    h.emitPhases({ local: 'connected', devbox: 'connected' })
    await vi.waitFor(() => expect(useQuestionsStore.getState().workflows).toHaveLength(1))
    h.targets.length = 0

    await patchQuestions({
      workflowId: 'w-devbox',
      requestId: 'w-devbox-req',
      expectedRevision: 1,
      actionId: 'act-1',
      answers: [],
    })

    expect(h.targets).toEqual(['devbox'])
    expect(h.questionsPatch).toHaveBeenCalledTimes(1)
  })
})
