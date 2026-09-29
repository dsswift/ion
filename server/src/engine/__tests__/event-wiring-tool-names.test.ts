import { describe, expect, it, vi, beforeEach } from 'vitest'

const logged = vi.hoisted(() => vi.fn())
vi.mock('../../logger', () => ({ log: logged }))

import { applyToolDisplayNames } from '../event-wiring-tool-names'

beforeEach(() => logged.mockClear())

const BRIDGED = 'mcp__ion-extensions__Bash'

describe('applyToolDisplayNames', () => {
  it('strips the bridge prefix from a tool start', () => {
    const event = { type: 'engine_tool_start', toolName: BRIDGED, toolId: 't1' }
    applyToolDisplayNames(event)
    expect(event.toolName).toBe('Bash')
  })

  it('strips it from a stalled tool and from dispatch activity', () => {
    const stalled = { type: 'engine_tool_stalled', toolName: BRIDGED }
    const dispatch = { type: 'engine_dispatch_activity', toolName: BRIDGED }
    applyToolDisplayNames(stalled)
    applyToolDisplayNames(dispatch)
    expect(stalled.toolName).toBe('Bash')
    expect(dispatch.toolName).toBe('Bash')
  })

  it('strips it from a permission request card', () => {
    const event = { type: 'engine_permission_request', permToolName: BRIDGED }
    applyToolDisplayNames(event)
    expect(event.permToolName).toBe('Bash')
  })

  it('strips it from every retained permission denial', () => {
    const event = {
      type: 'engine_status',
      fields: { permissionDenials: [{ toolName: BRIDGED }, { toolName: 'AskUserQuestion' }] },
    }
    applyToolDisplayNames(event)
    expect(event.fields.permissionDenials.map((d) => d.toolName)).toEqual(['Bash', 'AskUserQuestion'])
  })

  // Another MCP server's tools keep the prefix: the server is what tells the
  // reader whose tool it is.
  it("leaves another MCP server's tool name alone", () => {
    const event = { type: 'engine_tool_start', toolName: 'mcp__github__create_issue' }
    applyToolDisplayNames(event)
    expect(event.toolName).toBe('mcp__github__create_issue')
  })

  // The gate reads this name to decide, not to label; it normalizes it itself.
  it('does not touch the tool-gate name', () => {
    const event = { type: 'engine_tool_gate_request', gateToolName: BRIDGED }
    applyToolDisplayNames(event as never)
    expect(event.gateToolName).toBe(BRIDGED)
  })

  it('ignores events with no tool name and tolerates a status without denials', () => {
    expect(() => applyToolDisplayNames({ type: 'engine_status' })).not.toThrow()
    expect(() => applyToolDisplayNames({ type: 'engine_text_delta' })).not.toThrow()
  })

  // The engine keeps the wire name in engine.jsonl, but every server log line
  // after the strip carries the bare name. The strip itself must record what
  // arrived, or the server's logs cannot show a call went through the bridge.
  it('logs the wire name it stripped, with the tool id', () => {
    applyToolDisplayNames({ type: 'engine_tool_start', toolName: BRIDGED, toolId: 't9' })
    expect(logged).toHaveBeenCalledWith(
      'event-wiring-tool-names',
      'display name stripped from engine bridge tool',
      { type: 'engine_tool_start', tool_id: 't9', wire_names: BRIDGED },
    )
  })

  it('logs nothing when there was nothing to strip', () => {
    applyToolDisplayNames({ type: 'engine_tool_start', toolName: 'Read', toolId: 't1' })
    applyToolDisplayNames({ type: 'engine_tool_start', toolName: 'mcp__github__create_issue', toolId: 't2' })
    expect(logged).not.toHaveBeenCalled()
  })
})
