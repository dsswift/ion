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

const studioToolsMock = vi.hoisted(() => ({
  STUDIO_PLAYWRIGHT_TOOLS: [
    {
      name: 'browser_snapshot',
      description: 'list Studio browsers',
      inputSchema: { type: 'object' },
      planModeSafe: true,
      execute: vi.fn(async (): Promise<{ content: string; isError: boolean; images?: unknown[] }> => ({ content: 'snapshot', isError: false })),
    },
  ],
}))
vi.mock('./studio-playwright/tools', () => studioToolsMock)

const chartToolMock = vi.hoisted(() => ({
  RENDER_CHART_TOOL: {
    name: 'RenderChart',
    description: 'render a chart on ONE chart with null gaps and update support',
    inputSchema: { type: 'object' },
    planModeSafe: true,
  },
  RENDER_CHART_TOOL_NAME: 'RenderChart',
  executeRenderChart: vi.fn(),
}))
vi.mock('./studio-chart-tool', () => chartToolMock)

const chartPublishMock = vi.hoisted(() => ({
  publishChartResource: vi.fn(async () => undefined),
  publishChartResourceRemoval: vi.fn(async () => undefined),
}))
vi.mock('./chart-resource-publish', () => chartPublishMock)

// The session registry now rides on the bridge the responder is wired to,
// which is what keeps `./state` (and the live EngineBridge it constructs at
// import time) out of this module's import graph.
const activeSessions = new Map<string, { conversationId?: string }>()

const settingsMock = vi.hoisted(() => ({
  readSettings: vi.fn(() => ({ activeUi: 'studio', studioPlaywrightEnabled: true })),
}))
vi.mock('./settings-store', () => settingsMock)

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
  activeSessions = activeSessions
  request = vi.fn(async () => ({ ok: true }))
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
    expect(cfg.clientTools?.map((t) => t.name)).toEqual(['BenchMemberFile', 'browser_snapshot', 'RenderChart', 'AskUserQuestions'])
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

  it('executes the matching client tool and returns its result', async () => {
    execute.mockReturnValue({ content: 'file body', isError: false })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'BenchMemberFile', gateToolInput: { file: 'x' } }))
    await Promise.resolve()
    expect(execute).toHaveBeenCalledWith({ file: 'x' }, '/b')
    expect(bridge.sent[0]).toMatchObject({
      cmd: 'tool_gate_response',
      gateRequestId: 'tool-gate-1',
      gateContent: 'file body',
      gateIsError: false,
    })
  })

  it('returns a tool error for an unknown tool name', async () => {
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'NotATool' }))
    await Promise.resolve()
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('NotATool')
  })

  it('fails CLOSED (tool error) when the handler throws', async () => {
    execute.mockImplementation(() => { throw new Error('git exploded') })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'BenchMemberFile' }))
    await Promise.resolve()
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('git exploded')
  })
})

describe('wireToolGateResponder — browser tool context', () => {
  let bridge: FakeBridge
  const browserExecute = studioToolsMock.STUDIO_PLAYWRIGHT_TOOLS[0].execute
  beforeEach(() => {
    bridge = new FakeBridge()
    wireToolGateResponder(bridge)
    browserExecute.mockClear()
    browserExecute.mockResolvedValue({ content: 'snapshot', isError: false })
  })

  it('injects the session key, cwd, and origin rather than trusting input', async () => {
    // Ownership is the responder's to state. If it came from gateToolInput a
    // model could name another conversation's browser.
    bridge.fire('tab-7', gateEvent({
      gateKind: 'tool',
      gateToolName: 'browser_snapshot',
      gateToolInput: { sessionKey: 'tab-999', origin: 'extension' },
      gateCwd: '/repo',
      gateOrigin: 'extension',
    }))
    await Promise.resolve()
    await Promise.resolve()
    expect(browserExecute).toHaveBeenCalledWith(
      { sessionKey: 'tab-999', origin: 'extension' },
      { sessionKey: 'tab-7', cwd: '/repo', origin: 'extension' },
    )
  })

  it('defaults the origin to model when the engine omits it', async () => {
    // An older engine does not send gateOrigin. Defaulting to the LESS
    // privileged origin keeps the isolation rule safe by default.
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'browser_snapshot', gateCwd: '/repo' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(browserExecute).toHaveBeenCalledWith({ file_path: '/b/x' }, expect.objectContaining({ origin: 'model' }))
  })

  it('forwards browser image results to the engine', async () => {
    browserExecute.mockResolvedValue({
      content: 'shot',
      isError: false,
      images: [{ media_type: 'image/png', data: 'AAAA' }],
    })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'browser_snapshot' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.sent[0]).toMatchObject({
      gateIsError: false,
      gateImages: [{ media_type: 'image/png', data: 'AAAA' }],
    })
  })

  it('advertises only tools it can execute', () => {
    // A declared-but-unexecutable tool is discovered by the model only when it
    // fails, so the two lists come from one computation.
    const declared = toolGateSessionConfig().clientTools?.map((tool) => tool.name) ?? []
    for (const name of declared) {
      if (name === 'AskUserQuestions') continue
      const executable = [...toolsMock.BENCH_CLIENT_TOOLS, ...studioToolsMock.STUDIO_PLAYWRIGHT_TOOLS]
        .some((tool) => tool.name === name) || name === chartToolMock.RENDER_CHART_TOOL_NAME
      expect(executable).toBe(true)
    }
  })
})

describe('wireToolGateResponder — chart tool', () => {
  let bridge: FakeBridge
  beforeEach(() => {
    bridge = new FakeBridge()
    wireToolGateResponder(bridge)
    chartToolMock.executeRenderChart.mockReset()
    chartPublishMock.publishChartResource.mockClear()
    activeSessions.clear()
    settingsMock.readSettings.mockReturnValue({ activeUi: 'studio', studioPlaywrightEnabled: true })
  })

  it('executes RenderChart with the conversation the session owns', async () => {
    // A chart belongs to a conversation, so ownership is resolved from the
    // bridge's session registry — never from the model's arguments.
    activeSessions.set('tab-7', { conversationId: 'conv-abc' })
    chartToolMock.executeRenderChart.mockReturnValue({ content: 'Chart rendered.', isError: false })

    bridge.fire('tab-7', gateEvent({
      gateKind: 'tool',
      gateToolName: 'RenderChart',
      gateToolInput: { schemaVersion: 1, conversationId: 'conv-SPOOFED' },
      gateRequestId: 'tool-gate-chart-1',
    }))
    await Promise.resolve()
    await Promise.resolve()

    expect(chartToolMock.executeRenderChart).toHaveBeenCalledWith(
      { schemaVersion: 1, conversationId: 'conv-SPOOFED' },
      { sessionKey: 'tab-7', conversationId: 'conv-abc', toolCallId: 'tool-gate-chart-1' },
    )
    expect(bridge.sent[0]).toMatchObject({
      cmd: 'tool_gate_response',
      gateRequestId: 'tool-gate-chart-1',
      gateContent: 'Chart rendered.',
      gateIsError: false,
    })
  })

  it('publishes the resource only after a successful commit', async () => {
    const record = { chartId: 'c1', conversationId: 'conv-abc' }
    chartToolMock.executeRenderChart.mockReturnValue({
      content: 'ok', isError: false, publish: { op: 'create', record },
    })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'RenderChart' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(chartPublishMock.publishChartResource).toHaveBeenCalledWith(bridge, 'tab-1', 'create', record)
  })

  it('does not publish when the tool refused the input', async () => {
    // A refusal leaves no record, so announcing one would show a card that
    // vanishes on restart.
    chartToolMock.executeRenderChart.mockReturnValue({ content: 'Chart rejected: bad', isError: true })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'RenderChart' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(chartPublishMock.publishChartResource).not.toHaveBeenCalled()
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
  })

  it('refuses RenderChart when the Overlay is the active presentation', async () => {
    // Previously saved charts still render in the Overlay; creating a NEW one
    // is Studio-only, and the responder must agree with the declaration.
    settingsMock.readSettings.mockReturnValue({ activeUi: 'overlay', studioPlaywrightEnabled: true })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'RenderChart' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(chartToolMock.executeRenderChart).not.toHaveBeenCalled()
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('not provided by this desktop')
  })

  it('omits RenderChart from the declaration outside Studio', () => {
    settingsMock.readSettings.mockReturnValue({ activeUi: 'overlay', studioPlaywrightEnabled: true })
    const names = toolGateSessionConfig().clientTools?.map((t) => t.name) ?? []
    expect(names).not.toContain('RenderChart')
    expect(names).toContain('AskUserQuestions')
  })

  it('declares RenderChart even when browser tools are disabled', () => {
    // A chart is not a browser artifact: the Playwright setting must not gate it.
    settingsMock.readSettings.mockReturnValue({ activeUi: 'studio', studioPlaywrightEnabled: false })
    const names = toolGateSessionConfig().clientTools?.map((t) => t.name) ?? []
    expect(names).toContain('RenderChart')
    expect(names).not.toContain('browser_snapshot')
  })

  it('fails CLOSED when the chart executor throws', async () => {
    chartToolMock.executeRenderChart.mockImplementation(() => { throw new Error('disk exploded') })
    bridge.fire('tab-1', gateEvent({ gateKind: 'tool', gateToolName: 'RenderChart' }))
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.sent[0]).toMatchObject({ gateIsError: true })
    expect(String(bridge.sent[0].gateContent)).toContain('disk exploded')
  })
})
