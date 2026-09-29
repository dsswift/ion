import { describe, expect, it } from 'vitest'
import { STUDIO_BROWSER_TOOL_DECLARATIONS, studioBrowserToolDeclaration } from './tool-declarations'

/**
 * The declaration list is what the server advertises to the engine, so it is
 * checked on its own, without the desktop: a server can be attached to no
 * desktop at all and must still advertise a well-formed set.
 */
describe('STUDIO_BROWSER_TOOL_DECLARATIONS', () => {
  it('is non-empty with unique names', () => {
    const names = STUDIO_BROWSER_TOOL_DECLARATIONS.map((tool) => tool.name)
    expect(names.length).toBeGreaterThan(0)
    expect(new Set(names).size).toBe(names.length)
  })

  it('gives every tool a browser_ name, a description, and an object input schema', () => {
    for (const tool of STUDIO_BROWSER_TOOL_DECLARATIONS) {
      expect(tool.name, tool.name).toMatch(/^browser_[a-z_]+$/)
      expect(tool.description?.trim().length ?? 0, tool.name).toBeGreaterThan(0)
      expect(tool.inputSchema?.type, tool.name).toBe('object')
      expect(tool.inputSchema?.additionalProperties, tool.name).toBe(false)
      expect(typeof tool.inputSchema?.properties, tool.name).toBe('object')
    }
  })

  it('never accepts ownership arguments', () => {
    // The tool-gate responder supplies the session key; a model must not be
    // able to name a conversation, an instance, or a tab.
    for (const tool of STUDIO_BROWSER_TOOL_DECLARATIONS) {
      const props = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>)
      expect(props, tool.name).not.toContain('conversationId')
      expect(props, tool.name).not.toContain('instanceId')
      expect(props, tool.name).not.toContain('tabId')
    }
  })

  it('does not advertise browser_run_code_unsafe', () => {
    // Upstream it evaluates arbitrary JavaScript in the Playwright server
    // process, which in Ion is the desktop main process — an RCE surface
    // reachable from a model. browser_evaluate covers the page sandbox.
    expect(studioBrowserToolDeclaration('browser_run_code_unsafe')).toBeUndefined()
  })

  it('looks declarations up by name', () => {
    expect(studioBrowserToolDeclaration('browser_navigate')?.inputSchema).toMatchObject({ required: ['url'] })
    expect(studioBrowserToolDeclaration('browser_snapshot')?.planModeSafe).toBe(true)
    expect(studioBrowserToolDeclaration('no_such_tool')).toBeUndefined()
  })
})
