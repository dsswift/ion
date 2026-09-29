import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }))

import { STUDIO_BROWSER_TOOLS, STUDIO_REQUIRED_ERROR, setBrowserToolExecutor } from './tool-executor'
import { STUDIO_BROWSER_TOOL_DECLARATIONS } from './tool-contracts'

const ctx = { sessionKey: 'tab-1', cwd: '/repo', origin: 'model' as const }

beforeEach(() => setBrowserToolExecutor(null))

describe('STUDIO_BROWSER_TOOLS', () => {
  it('is every declaration, executable', () => {
    expect(STUDIO_BROWSER_TOOLS.map((t) => t.name)).toEqual(STUDIO_BROWSER_TOOL_DECLARATIONS.map((d) => d.name))
    for (const tool of STUDIO_BROWSER_TOOLS) expect(typeof tool.execute).toBe('function')
  })

  it('fails with the Studio-required error when no desktop is attached', async () => {
    const result = await STUDIO_BROWSER_TOOLS[0]!.execute({}, ctx)
    expect(result).toEqual({ content: STUDIO_REQUIRED_ERROR, isError: true })
  })

  it('routes a call to the installed executor by name and returns its result', async () => {
    const run = vi.fn(async () => ({ content: 'ok', isError: false }))
    setBrowserToolExecutor(run)
    const tool = STUDIO_BROWSER_TOOLS.find((t) => t.name === 'browser_navigate')!
    await expect(tool.execute({ url: 'https://x' }, ctx)).resolves.toEqual({ content: 'ok', isError: false })
    expect(run).toHaveBeenCalledWith('browser_navigate', { url: 'https://x' }, ctx)
  })

  it('turns a rejected round trip (no capable client, timeout) into the Studio-required error', async () => {
    setBrowserToolExecutor(async () => { throw new Error('Studio required') })
    const result = await STUDIO_BROWSER_TOOLS[0]!.execute({}, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toBe(STUDIO_REQUIRED_ERROR)
  })
})
