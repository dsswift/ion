import { describe, it, expect } from 'vitest'
import { mapPersistedMessages } from './persisted-message-map'

describe('mapPersistedMessages — engine bridge tool names', () => {
  // Tabs saved by an older build hold the CLI's bridge name verbatim; the
  // restored row must read like a live one.
  it('strips the engine bridge prefix from a restored tool row', () => {
    const restored = mapPersistedMessages([
      { role: 'tool', content: '', toolName: 'mcp__ion-extensions__Bash', toolId: 't1', timestamp: 1 },
    ])
    expect(restored[0].toolName).toBe('Bash')
  })

  it("keeps another MCP server's prefix and leaves non-tool rows alone", () => {
    const restored = mapPersistedMessages([
      { role: 'tool', content: '', toolName: 'mcp__github__create_issue', toolId: 't2', timestamp: 1 },
      { role: 'assistant', content: 'hi', timestamp: 2 },
    ])
    expect(restored[0].toolName).toBe('mcp__github__create_issue')
    expect(restored[1].toolName).toBeUndefined()
  })
})
