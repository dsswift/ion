import { describe, expect, it, vi } from 'vitest'

vi.mock('../logger', () => ({ log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }))

import { resolveTarget } from './targets'

/** A page stub that records the selector each locator() call receives. */
function fakePage() {
  const selectors: string[] = []
  return {
    selectors,
    page: { locator: (selector: string) => { selectors.push(selector); return {} } } as never,
  }
}

describe('snapshot ref targeting', () => {
  it('routes a bare ref through the aria-ref engine', () => {
    const { page, selectors } = fakePage()
    const resolved = resolveTarget(page, 'e12')
    expect(typeof resolved).not.toBe('string')
    expect(selectors).toEqual(['aria-ref=e12'])
  })

  it('routes a frame-prefixed ref through aria-ref unchanged', () => {
    // A long-lived connection (which the browser runtime holds) emits refs like
    // f2e6. Rejecting them here made every ref-targeted action fail with "no
    // element matched"; Playwright resolves the fN prefix to its frame itself.
    const { page, selectors } = fakePage()
    const resolved = resolveTarget(page, 'f2e6')
    expect(typeof resolved).not.toBe('string')
    expect(selectors).toEqual(['aria-ref=f2e6'])
  })

  it('treats a lookalike as an ordinary selector', () => {
    // Not a ref: must not be smuggled into the aria-ref engine, where it would
    // fail confusingly instead of matching a real element named this way.
    const { page, selectors } = fakePage()
    resolveTarget(page, 'e12x')
    resolveTarget(page, 'f2')
    expect(selectors).toEqual(["'e12x'".replaceAll("'", ''), 'f2'])
  })

  it('keeps engine-prefixed selectors intact', () => {
    const { page, selectors } = fakePage()
    resolveTarget(page, 'text=Sign in')
    expect(selectors).toEqual(['text=Sign in'])
  })

  it('refuses an empty target', () => {
    const { page } = fakePage()
    expect(resolveTarget(page, '   ')).toBe('target must not be empty')
  })
})
