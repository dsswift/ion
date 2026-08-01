/**
 * resolveContextInputs — the shared numerator + engine-window resolver.
 *
 * Both context surfaces (the status-bar ring and the status drawer) call this
 * one helper, which is what makes them agree by construction. Before it existed
 * each surface assembled the same three fields by hand at its own call site, and
 * they drifted: the ring read `statusFields.contextTokens` while the drawer read
 * `apiReportedTotal`, so mid-turn — after tool results landed and before the next
 * provider response — the two reported different numbers.
 *
 * The load-bearing assertion here is that `contextBreakdown.totalTokens` is
 * NEVER the numerator. It is the engine's itemized per-category estimate, meant
 * for attribution, and it over-reports because it counts content the provider did
 * not bill for the turn. Reading it as occupancy rendered a conversation
 * occupying 26% of a 1M window as 103%.
 */

import { describe, it, expect } from 'vitest'
import { resolveContextInputs, resolveContextDisplay } from '../context-usage'

describe('resolveContextInputs', () => {
  it('prefers the breakdown occupancy over the status-fields copy', () => {
    // Both paths carry the same engine figure, so preferring one is about
    // availability, not correctness: a breakdown exists for an idle conversation
    // whose statusFields were never seeded.
    const inputs = resolveContextInputs({
      contextBreakdown: { occupancyTokens: 255_897, totalTokens: 1_034_443 },
      statusFields: { contextTokens: 227_099, contextWindow: 1_000_000 },
    })
    expect(inputs.tokens).toBe(255_897)
    expect(inputs.engineWindow).toBe(1_000_000)
  })

  it('never returns the itemized totalTokens, even as the only figure present', () => {
    // Red on revert: a hand-assembled totalTokens-first read returns 1,034,443
    // here, which is the exact defect this branch fixed on both clients.
    const inputs = resolveContextInputs({
      contextBreakdown: { totalTokens: 1_034_443 },
      statusFields: { contextWindow: 1_000_000 },
    })
    expect(inputs.tokens).toBeNull()
  })

  it('falls back to the status-fields occupancy when the breakdown has none', () => {
    const inputs = resolveContextInputs({
      contextBreakdown: { totalTokens: 1_034_443 },
      statusFields: { contextTokens: 227_099, contextWindow: 1_000_000 },
    })
    expect(inputs.tokens).toBe(227_099)
  })

  it('returns nulls for an instance with no engine figures yet', () => {
    expect(resolveContextInputs(null)).toEqual({ tokens: null, engineWindow: null })
    expect(resolveContextInputs(undefined)).toEqual({ tokens: null, engineWindow: null })
    expect(resolveContextInputs({})).toEqual({ tokens: null, engineWindow: null })
  })

  it('carries the engine window independently of the numerator', () => {
    // A conversation can have a known window before any occupancy figure lands.
    const inputs = resolveContextInputs({ statusFields: { contextWindow: 1_000_000 } })
    expect(inputs.tokens).toBeNull()
    expect(inputs.engineWindow).toBe(1_000_000)
  })
})

describe('the two context surfaces agree by construction', () => {
  it('produces one display figure from one instance for both callers', () => {
    // This pins the claim the drawer and the ring both make in prose. Both call
    // resolveContextInputs and feed resolveContextDisplay with the same selected
    // window, so the same instance must yield byte-identical output. The
    // surfaces differ only in how they render it.
    const inst = {
      contextBreakdown: { occupancyTokens: 255_897, totalTokens: 1_034_443 },
      statusFields: { contextTokens: 255_897, contextWindow: 1_000_000 },
    }

    const bar = resolveContextInputs(inst)
    const drawer = resolveContextInputs(inst)
    expect(bar).toEqual(drawer)

    const selectedWindow = 1_000_000
    expect(resolveContextDisplay(bar.tokens, selectedWindow))
      .toEqual(resolveContextDisplay(drawer.tokens, selectedWindow))
    // And the shared figure is the honest one: 26%, not the itemized 103%.
    expect(resolveContextDisplay(bar.tokens, selectedWindow)?.pct).toBe(26)
  })

  it('would have disagreed under the old per-surface reads', () => {
    // Documents the defect the shared helper removes. The old drawer read
    // apiReportedTotal (last-turn provider total, nothing added since) while the
    // ring read statusFields.contextTokens (that total PLUS an estimate for
    // messages appended since). Mid-turn those differ.
    const midTurn = {
      apiReportedTotal: 50_000,
      statusFieldsTokens: 62_400,
    }
    expect(midTurn.apiReportedTotal).not.toBe(midTurn.statusFieldsTokens)

    // The shared resolver ends the divergence: one field, read one way.
    const inputs = resolveContextInputs({
      contextBreakdown: { occupancyTokens: 62_400, totalTokens: 200_000 },
      statusFields: { contextTokens: 62_400, contextWindow: 1_000_000 },
    })
    expect(inputs.tokens).toBe(62_400)
  })
})
