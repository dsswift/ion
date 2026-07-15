import { describe, it, expect } from 'vitest'
import { diffSnapshots, eventIntents } from '../mapping'
import type { AgentStateUpdate, NormalizedEvent } from '../../../../shared/types'

function agent(name: string, status: string, metadata: Record<string, unknown> = {}): AgentStateUpdate {
  return { name, status, metadata } as unknown as AgentStateUpdate
}

describe('snapshot diffing', () => {
  it('a newly running root agent gets a manager delivery plus working', () => {
    expect(diffSnapshots([], [agent('dev', 'running')])).toEqual([
      { kind: 'deliver', from: 'manager', toAgent: 'dev' },
      { kind: 'agent-working', agent: 'dev' },
    ])
  })

  it('a newly running NESTED agent is delivered by its owning lead', () => {
    const lead = agent('dev-lead', 'running', {
      dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'c', status: 'running' }],
    })
    const specialist = agent('backend-dev', 'running', { dispatchDepth: 2, dispatchParentId: 'd1' })
    const intents = diffSnapshots([lead], [lead, specialist])
    expect(intents).toEqual([
      { kind: 'deliver', from: 'dev-lead', toAgent: 'backend-dev' },
      { kind: 'agent-working', agent: 'backend-dev' },
    ])
  })

  it('a nested agent with an unknown owner falls back to the manager', () => {
    const orphan = agent('backend-dev', 'running', { dispatchDepth: 2, dispatchParentId: 'd-gone' })
    expect(diffSnapshots([], [orphan])).toEqual([
      { kind: 'deliver', from: 'manager', toAgent: 'backend-dev' },
      { kind: 'agent-working', agent: 'backend-dev' },
    ])
  })

  it('initial scene builds place working agents WITHOUT replaying deliveries', () => {
    expect(diffSnapshots([], [agent('dev', 'running')], { initial: true })).toEqual([
      { kind: 'agent-working', agent: 'dev' },
    ])
  })

  it('emits nothing when status is unchanged (heartbeat re-emission)', () => {
    const snapshot = [agent('dev', 'running')]
    expect(diffSnapshots(snapshot, [agent('dev', 'running')])).toEqual([])
  })

  it('maps done, error, and idle transitions', () => {
    const prev = [agent('a', 'running'), agent('b', 'running'), agent('c', 'running')]
    const next = [agent('a', 'done'), agent('b', 'error'), agent('c', 'idle')]
    expect(diffSnapshots(prev, next)).toEqual([
      { kind: 'agent-done', agent: 'a' },
      { kind: 'agent-error', agent: 'b' },
      { kind: 'agent-idle', agent: 'c' },
    ])
  })
})

describe('event intents', () => {
  it('permission_request raises the wait bubble; a running status clears it and puts the manager to work', () => {
    const events: NormalizedEvent[] = [
      { type: 'permission_request', questionId: 'q', toolName: 'Bash', options: [] } as unknown as NormalizedEvent,
      { type: 'status', fields: { state: 'running' } } as unknown as NormalizedEvent,
    ]
    expect(eventIntents(events, [])).toEqual([
      { kind: 'permission-wait', bubble: 'permission' },
      { kind: 'permission-clear' },
      { kind: 'manager-working' },
    ])
  })

  it('attention artwork is classified by tool: plan ready vs question pending', () => {
    const plan = { type: 'permission_request', questionId: 'q1', toolName: 'ExitPlanMode', options: [] } as unknown as NormalizedEvent
    const question = { type: 'permission_request', questionId: 'q2', toolName: 'AskUserQuestion', options: [] } as unknown as NormalizedEvent
    expect(eventIntents([plan, question], [])).toEqual([
      { kind: 'permission-wait', bubble: 'plan' },
      { kind: 'permission-wait', bubble: 'question' },
    ])
  })

  it('an idle status stands the manager down', () => {
    expect(eventIntents([{ type: 'status', fields: { state: 'idle' } } as unknown as NormalizedEvent], [])).toEqual([
      { kind: 'manager-idle' },
    ])
  })

  it('tool activity resolves the dispatched agent by its dispatch id', () => {
    const dev = agent('backend-dev', 'running', {
      dispatches: [{ id: 'da-1', task: 't', model: 'm', conversationId: 'c', status: 'running' }],
    })
    const start = {
      type: 'dispatch_activity',
      dispatchAgentId: 'da-1',
      dispatchConversationId: 'c',
      dispatchActivityKind: 'tool_start',
      dispatchSeq: 1,
      toolName: 'Bash',
    } as NormalizedEvent
    const end = { ...start, dispatchActivityKind: 'tool_end' } as NormalizedEvent
    const textDelta = { ...start, dispatchActivityKind: 'text' } as NormalizedEvent
    expect(eventIntents([start, end, textDelta], [dev])).toEqual([
      { kind: 'agent-activity', agent: 'backend-dev', toolName: 'Bash' },
      { kind: 'agent-activity', agent: 'backend-dev', toolName: null },
    ])
  })

  it('dispatch_start is the PRIMARY delivery trigger: root → manager delivers', () => {
    const start = {
      type: 'dispatch_start',
      dispatchAgent: 'dev-lead',
      dispatchTask: 't',
      dispatchModel: 'm',
      dispatchSessionId: 's',
      dispatchDepth: 1,
      dispatchParentId: '',
      dispatchId: 'd1',
    } as NormalizedEvent
    expect(eventIntents([start], [])).toEqual([
      { kind: 'deliver', from: 'manager', toAgent: 'dev-lead' },
      { kind: 'agent-working', agent: 'dev-lead' },
    ])
  })

  it('nested dispatch_start (engine emits every depth on the root stream): owning lead delivers', () => {
    const lead = agent('dev-lead', 'running', {
      dispatches: [{ id: 'd1', task: 't', model: 'm', conversationId: 'c', status: 'running' }],
    })
    const nested = {
      type: 'dispatch_start',
      dispatchAgent: 'backend-dev',
      dispatchTask: 't',
      dispatchModel: 'm',
      dispatchSessionId: 's',
      dispatchDepth: 2,
      dispatchParentId: 'd1',
      dispatchId: 'd2',
    } as NormalizedEvent
    expect(eventIntents([nested], [lead])).toEqual([
      { kind: 'deliver', from: 'dev-lead', toAgent: 'backend-dev' },
      { kind: 'agent-working', agent: 'backend-dev' },
    ])
  })

  it('dispatch_end emits no intent (terminal status arrives via the snapshot)', () => {
    const end = {
      type: 'dispatch_end',
      dispatchAgent: 'dev',
      dispatchExitCode: 0,
      dispatchElapsed: 1,
      dispatchCost: 0,
      dispatchDepth: 1,
      dispatchParentId: '',
      dispatchId: 'd1',
    } as NormalizedEvent
    expect(eventIntents([end], [])).toEqual([])
  })
})
