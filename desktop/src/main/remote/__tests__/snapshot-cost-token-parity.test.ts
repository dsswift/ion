/**
 * Snapshot cold-start parity — regression guard for dropped cost/token fields.
 *
 * Pre-fix: projectRendererTab omitted totalCostUsd, inputTokens,
 * outputTokens, cacheReadTokens, and cacheCreationTokens from the wire
 * RemoteTabState. iOS cold-start had no cost or token data until a live
 * engine_status event arrived after the tab resumed.
 *
 * Post-Commit 3: the canonical field is runCostUsd (per-run, cache-aware).
 * conversationCostUsd carries the dispatch-tree cumulative. The legacy
 * totalCostUsd is still projected alongside runCostUsd for lockstep iOS
 * compat until the iOS side migrates (Commit 4).
 *
 * REGRESSION — this test MUST fail before the fix and pass after.
 * If it passes before the fix is applied, the guard is wrong.
 */

import { describe, it, expect } from 'vitest'
import { projectRendererTab } from '../snapshot-project'

const BASE = { lastMessage: null, permissionQueue: [] }

describe('snapshot cold-start parity: cost + token fields', () => {
  it('projects runCostUsd from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', runCostUsd: 0.0042 },
      BASE,
    )
    expect(result.runCostUsd).toBe(0.0042)
  })

  it('projects conversationCostUsd from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', runCostUsd: 0.0042, conversationCostUsd: 0.1234 },
      BASE,
    )
    expect(result.conversationCostUsd).toBe(0.1234)
  })

  it('projects totalCostUsd (compat alias for runCostUsd) from renderer tab', () => {
    // totalCostUsd is kept for lockstep iOS wire compat until iOS migrates
    // to runCostUsd. It should equal runCostUsd when projected.
    const result = projectRendererTab(
      { id: 't1', runCostUsd: 0.0042 },
      BASE,
    )
    expect(result.totalCostUsd).toBe(0.0042)
  })

  it('projects inputTokens from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', inputTokens: 1234 },
      BASE,
    )
    expect(result.inputTokens).toBe(1234)
  })

  it('projects outputTokens from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', outputTokens: 567 },
      BASE,
    )
    expect(result.outputTokens).toBe(567)
  })

  it('projects cacheReadTokens from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', cacheReadTokens: 8900 },
      BASE,
    )
    expect(result.cacheReadTokens).toBe(8900)
  })

  it('projects cacheCreationTokens from renderer tab', () => {
    const result = projectRendererTab(
      { id: 't1', cacheCreationTokens: 11 },
      BASE,
    )
    expect(result.cacheCreationTokens).toBe(11)
  })

  it('emits undefined (not 0) when cost fields are absent (clean cold-start)', () => {
    // A tab that has never had a run must not project 0-values as if it
    // had completed a turn. undefined tells iOS "no data yet" vs 0 which
    // tells iOS "the turn cost nothing".
    const result = projectRendererTab({ id: 't1' }, BASE)
    expect(result.runCostUsd).toBeUndefined()
    expect(result.conversationCostUsd).toBeUndefined()
    expect(result.totalCostUsd).toBeUndefined()
    expect(result.inputTokens).toBeUndefined()
    expect(result.outputTokens).toBeUndefined()
    expect(result.cacheReadTokens).toBeUndefined()
    expect(result.cacheCreationTokens).toBeUndefined()
  })

  it('projects runCostUsd + conversationCostUsd reaching iOS through snapshot projection', () => {
    // Parity test: both cost fields reach iOS through snapshot projection
    // so the iOS cost display has both run-scoped and conversation-scoped
    // values available on cold open.
    const result = projectRendererTab(
      {
        id: 'tab-cost',
        title: 'Test Tab',
        status: 'idle',
        runCostUsd: 1.234,
        conversationCostUsd: 2.345,
        inputTokens: 5000,
        outputTokens: 800,
        cacheReadTokens: 1200,
        cacheCreationTokens: 300,
        contextTokens: 7000,
        contextWindow: 200000,
      },
      BASE,
    )
    expect(result.runCostUsd).toBe(1.234)
    expect(result.conversationCostUsd).toBe(2.345)
    // compat alias still matches runCostUsd
    expect(result.totalCostUsd).toBe(1.234)
    expect(result.inputTokens).toBe(5000)
    expect(result.outputTokens).toBe(800)
    expect(result.cacheReadTokens).toBe(1200)
    expect(result.cacheCreationTokens).toBe(300)
    // Existing fields still project correctly.
    expect(result.contextTokens).toBe(7000)
    expect(result.contextWindow).toBe(200000)
  })
})
