import { describe, expect, it, vi } from 'vitest'

/**
 * A browser tool is a server-side declaration joined by name to a desktop-side
 * execute body. This pins the join: the two lists must name exactly the same
 * tools, once each, and the joined array the desktop executes from must carry
 * the declarations in the order the server advertises them.
 *
 * `tools.ts` already throws at module load on a mismatch; this test exists so
 * the mismatch is a red test with a readable diff rather than a stack trace at
 * desktop start-up.
 */
vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('electron', () => ({ app: {}, shell: {}, session: { fromPartition: vi.fn() } }))
vi.mock('../studio-browser-views', () => ({ ensureBrowserView: vi.fn(), isBrowserViewVisible: vi.fn(() => false) }))

import { STUDIO_BROWSER_TOOL_DECLARATIONS } from '@ion/server/studio-playwright/tool-contracts'
import { STUDIO_BROWSER_TOOL_BODIES, STUDIO_PLAYWRIGHT_TOOLS, studioBrowserTool, studioBrowserToolBody } from './tools'

describe('browser tool declarations and bodies', () => {
  it('gives every declaration exactly one body', () => {
    const bodyNames = STUDIO_BROWSER_TOOL_BODIES.map((body) => body.name)
    for (const declaration of STUDIO_BROWSER_TOOL_DECLARATIONS) {
      expect(bodyNames.filter((name) => name === declaration.name), declaration.name).toHaveLength(1)
    }
  })

  it('gives every body a declaration', () => {
    const declared = new Set(STUDIO_BROWSER_TOOL_DECLARATIONS.map((declaration) => declaration.name))
    const orphans = STUDIO_BROWSER_TOOL_BODIES.map((body) => body.name).filter((name) => !declared.has(name))
    expect(orphans).toEqual([])
  })

  it('joins into one array in declaration order', () => {
    expect(STUDIO_PLAYWRIGHT_TOOLS.map((tool) => tool.name)).toEqual(
      STUDIO_BROWSER_TOOL_DECLARATIONS.map((declaration) => declaration.name),
    )
  })

  it('carries each declaration and its body through the join unchanged', () => {
    for (const tool of STUDIO_PLAYWRIGHT_TOOLS) {
      const declaration = STUDIO_BROWSER_TOOL_DECLARATIONS.find((candidate) => candidate.name === tool.name)
      expect(declaration).toBeDefined()
      expect(tool.description).toBe(declaration!.description)
      expect(tool.inputSchema).toEqual(declaration!.inputSchema)
      expect(tool.planModeSafe).toBe(declaration!.planModeSafe)
      expect(tool.execute).toBe(studioBrowserToolBody(tool.name)!.execute)
      expect(studioBrowserTool(tool.name)).toBe(tool)
    }
  })
})
