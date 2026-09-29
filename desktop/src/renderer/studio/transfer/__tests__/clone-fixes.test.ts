import { describe, expect, it, vi } from 'vitest'
import { cloneFixes, cloneTrustDetail } from '../clone-fixes'

describe('cloneFixes', () => {
  it('offers the plain verb when the repository declares nothing to run', async () => {
    const clone = vi.fn(async (_trust: boolean) => undefined)
    const fixes = cloneFixes(undefined, clone)
    expect(fixes.map((f) => f.label)).toEqual(['Clone it there'])
    await fixes[0].run()
    expect(clone).toHaveBeenCalledWith(false)
    expect(cloneTrustDetail(undefined)).toBe('')
  })

  it('asks trust with the clone and says exactly what it runs', async () => {
    const clone = vi.fn(async (_trust: boolean) => undefined)
    const fixes = cloneFixes({ builds: ['npm ci'] }, clone)
    expect(fixes.map((f) => f.label)).toEqual(['Clone and trust', 'Clone only'])
    await fixes[0].run()
    await fixes[1].run()
    expect(clone.mock.calls).toEqual([[true], [false]])
    expect(cloneTrustDetail({ builds: ['npm ci', 'uv sync'] })).toBe('Clone and trust lets its worktrees run npm ci, uv sync. Clone only runs none of its code.')
    expect(cloneTrustDetail({ setup: 'make bootstrap', builds: [] })).toBe('Clone and trust runs its setup, make bootstrap, as soon as it lands. Clone only runs none of its code.')
  })
})
