/**
 * Tool-gate responder tests — pins the desktop's half of the client tool
 * gate: every engine_tool_gate_request is answered (policy allow/deny, tool
 * result, unknown tool, handler crash), the response carries the correlator,
 * and the session declaration names the gated tools and the client tools.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const policyMock = vi.hoisted(() => ({
  evaluateToolGate: vi.fn(),
}))
vi.mock('./integration/bench-tool-policy', () => policyMock)

const toolsMock = vi.hoisted(() => ({
  BENCH_CLIENT_TOOLS: [
    {
      name: 'BenchMemberFile',
      description: 'read a member file',
      inputSchema: { type: 'object' },
      planModeSafe: true,
      execute: vi.fn(),
    },
  ],
}))
vi.mock('./integration/bench-agent-tools', () => toolsMock)

vi.mock('./logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

import {
  wireToolGateResponder,
  toolGateSessionConfig,
  GATED_TOOLS,
  type GateBridge,
} from './tool-gate-responder'
import type { EngineEvent } from '../shared/types'

class FakeBridge implements GateBridge {
  listener: ((key: string, event: EngineEvent) => void) | null = null
  sent: Array<Record<string, unknown>> = []
  on(_event: 'event', listener: (key: string, event: EngineEvent) => void): unknown {
    this.listener = listener
    return this
  }
  sendRaw(payload: Record<string, unknown>): void {
    this.sent.push(payload)
  }
  fire(key: string, event: EngineEvent): void {
    this.listener?.(key, event)
  }
}

function gateEvent(overrides: Record<string, unknown> = {}): EngineEvent {
  return {
    type: 'engine_tool_gate_request',
    gateRequestId: 'tool-gate-1',
    gateToolName: 'Write',
    gateToolInput: { file_path: '/b/x' },
    gateCwd: '/b',
    ...overrides,
  } as unknown as EngineEvent
}

describe('toolGateSessionConfig', () => {
  it('declares the gated tools, allow-on-timeout, and the client tools', () => {
    const cfg = toolGateSessionConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.tools).toEqual(GATED_TOOLS)
    expect(cfg.timeoutDecision).toBe('allow')
    expect(cfg.clientTools?.map((t) => t.name)).toEqual(['BenchMemberFile', 'AskUserQuestions'])
    expect(cfg.clientTools?.[0].planModeSafe).toBe(true)
    // The declaration must not carry the execute function — it crosses the wire.
    expect((cfg.clientTools?.[0] as unknown as Record<string, unknown>).execute).toBeUndefined()
    // The wizard tool is a plan-mode-safe HUMAN wait: the engine PARKS the
    // run when the model calls it (retained denial + idle), instead of the
    // finite blocking client-tool round-trip.
    const wizard = cfg.clientTools?.find((t) => t.name === 'AskUserQuestions')
    expect(wizard?.humanWait).toBe(true)
    expect(wizard?.planModeSafe).toBe(true)
    expect(wizard?.inputSchema).toBeDefined()
  })
})

describe('wireToolGateResponder — policy kind', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = new FakeBridge()
    wireToolGateResponder(bridge)
    policyMock.evaluateToolGate.mockReset()
  })

  it('answers allow when the policy passes', () => {
    policyMock.evaluateToolGate.mockReturnValue(null)
    bridge.fire('tab-1', gateEvent())
    expect(bridge.sent).toEqual([
      expect.objectContaining({
        cmd: 'tool_gate_response',
        key: 'tab-1',
        gateRequestId: 'tool-gate-1',
        gateDecision: 'allow',
      }),
    ])
  })

  it('answers deny with the policy reason', () => {
    policyMock.evaluateToolGate.mockReturnValue({ reason: 'bench edit refused' })
    bridge.fire('tab-1', gateEvent())
    expect(bridge.sent[0]).toMatchObject({
      gateDecision: 'deny',
      gateReason: 'bench edit refused',
    })
  })

  it('hands the policy the tool facts including siblings', () => {
    policyMock.evaluateToolGate.mockReturnValue(null)
    bridge.fire('tab-1', gateEvent({ gateSiblingTools: ['Read', 'Grep'] }))
    expect(policyMock.evaluateToolGate).toHaveBeenCalledWith({
      toolName: 'Write',
      input: { file_path: '/b/x' },
      cwd: '/b',
      siblingTools: ['Read', 'Grep'],
    })
  })

  it('fails OPEN when the policy throws', () => {
    policyMock.evaluateToolGate.mockImplementation(() => { throw new Error('boom') })
    bridge.fire('tab-1', gateEvent())
    expect(bridge.sent[0]).toMatchObject({ gateDecision: 'allow' })
  })

  it('ignores unrelated events', () => {
    bridge.fire('tab-1', { type: 'engine_status', fields: {} } as unknown as EngineEvent)
    expect(bridge.sent).toHaveLength(0)
  })
})

describe('wireToolGateResponder — tool kind', () => {
  let bridge: FakeBridge
  const execute = toolsMock.BENCH_CLIENT_TOOLS[0].execute
  beforeEach(() => {
    bridge = new FakeBridge()
    wireToolGateResponder(bridge)
    execute.mockReset()
  })

  it('executes the matching client tool and returns its result', () => {
    execute.mockReturnValue({ content: 'file body', isError: false })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'BenchMemberFile', gateToolInput: { file: 'x' } }))
    expect(execute).toHaveBeenCalledWith({ file: 'x' }, '/b')
    expect(bridge.sent[0]).toMatchObject({
      cmd: 'tool_gate_response',
      gateRequestId: 'tool-gate-1',
      gateContent: 'file body',
      gateIsError: false,
    })
  })

  it('returns a tool error for an unknown tool name', () => {
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'NotATool' }))
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('NotATool')
  })

  it('fails CLOSED (tool error) when the handler throws', () => {
    execute.mockImplementation(() => { throw new Error('git exploded') })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'BenchMemberFile' }))
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('git exploded')
  })
})
