import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
vi.mock('../studio-browser-views', () => ({
  ensureBrowserView: vi.fn(),
  isBrowserViewVisible: vi.fn(() => false),
}))

import { STUDIO_PLAYWRIGHT_TOOLS } from './tools'

/**
 * Compatibility with the Playwright MCP server agents were trained against.
 *
 * Ion replaced an externally installed @playwright/mcp server with built-in
 * tools. Agents already know that server's tool and argument names, so the
 * overlap must keep matching by name — otherwise every existing skill, prompt,
 * and habit silently degrades into failed calls.
 *
 * The fixture is a checked-in transcription, not a runtime dependency: nothing
 * here imports the MCP package, so removing it from the operator's config
 * cannot break this test.
 */
interface Fixture {
  source: { package: string; version: string }
  tools: Record<string, { parameters: Record<string, { type: string; required: boolean; default?: unknown }> }>
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, 'testdata', 'playwright-mcp-contract.json'), 'utf8'),
) as Fixture

function ionTool(name: string) {
  return STUDIO_PLAYWRIGHT_TOOLS.find((tool) => tool.name === name)
}

function properties(name: string): Record<string, { type?: string }> {
  const schema = ionTool(name)?.inputSchema as { properties?: Record<string, { type?: string }> } | undefined
  return schema?.properties ?? {}
}

function requiredOf(name: string): string[] {
  const schema = ionTool(name)?.inputSchema as { required?: string[] } | undefined
  return schema?.required ?? []
}

/**
 * Tools Ion deliberately does not implement, with the reason.
 *
 * Listing them here rather than omitting them silently means a future fixture
 * refresh surfaces the decision instead of looking like an oversight.
 */
const INTENTIONALLY_ABSENT: Record<string, string> = {
  // Evaluates arbitrary JavaScript in the Playwright server process, which in
  // Ion is the desktop main process. browser_evaluate covers the page sandbox.
  browser_run_code_unsafe: 'RCE-equivalent in the desktop main process',
  // Ion's browser is one visible tab per conversation; a drop needs a source
  // outside the page that Ion has no trusted way to supply.
  browser_drop: 'no external drag source in the Studio browser surface',
}

describe('playwright-mcp compatibility', () => {
  it('records which package version the fixture was transcribed from', () => {
    // A silent drift between the fixture and upstream is worse than a stale
    // fixture, so the version is part of the contract.
    expect(fixture.source.package).toBe('@playwright/mcp')
    expect(fixture.source.version).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('implements every compatible tool, or records why not', () => {
    const missing = Object.keys(fixture.tools).filter((name) => !ionTool(name) && !(name in INTENTIONALLY_ABSENT))
    expect(missing).toEqual([])
  })

  it('keeps the upstream argument names for every implemented tool', () => {
    const drift: string[] = []
    for (const [name, spec] of Object.entries(fixture.tools)) {
      if (!ionTool(name)) continue
      const props = properties(name)
      for (const argument of Object.keys(spec.parameters)) {
        // A renamed argument is the worst kind of break: the call is
        // well-formed and still does nothing the agent intended.
        if (!(argument in props)) drift.push(`${name}.${argument}`)
      }
    }
    expect(drift).toEqual([])
  })

  it('keeps upstream required arguments required', () => {
    const drift: string[] = []
    for (const [name, spec] of Object.entries(fixture.tools)) {
      if (!ionTool(name)) continue
      const required = requiredOf(name)
      for (const [argument, meta] of Object.entries(spec.parameters)) {
        // Upstream marks some defaulted arguments required (scale, static,
        // level). Ion defaults them instead, which is strictly more forgiving
        // and cannot break a call that used to work — so only a required
        // argument WITHOUT a default has to stay required.
        if (meta.required && meta.default === undefined && !required.includes(argument)) {
          drift.push(`${name}.${argument}`)
        }
      }
    }
    expect(drift).toEqual([])
  })

  it('never accepts ownership arguments the upstream server needed', () => {
    // Upstream addresses tabs by index because it owns a whole browser. Ion
    // resolves the conversation's single linked tab from the session key, so
    // these must not appear even though upstream has an equivalent.
    for (const tool of STUDIO_PLAYWRIGHT_TOOLS) {
      const props = Object.keys(properties(tool.name))
      expect(props).not.toContain('conversationId')
      expect(props).not.toContain('instanceId')
    }
  })

  it('documents Ion-only extensions as additive', () => {
    // Present in Ion, absent upstream. Additive by construction: an agent that
    // never sends them behaves exactly as it did against the MCP server.
    expect(ionTool('browser_emulate')).toBeDefined()
    expect(ionTool('browser_scroll')).toBeDefined()
    expect(ionTool('browser_network_state_set')).toBeDefined()
    expect(Object.keys(properties('browser_take_screenshot'))).toContain('clip')
    expect(Object.keys(properties('browser_network_requests'))).toContain('all')
    expect(Object.keys(properties('browser_console_messages'))).toContain('all')
  })
})
