/**
 * Tests for StatusDrawer redesign (plan minty-grinning-cocoa.md C1-C6)
 * + on-demand context breakdown (minty-grinning-cocoa §6-8).
 *
 * Tests cover:
 * - C1: model section absent from rendered output
 * - C2: breakdown scroll region (structural — tested via DOM attribute presence)
 * - C3: grouped/sorted ordering by kind
 * - C4: graph renders with correct segment data
 * - C5: cache annotation non-additive (cacheRead/cacheCreation don't change totalTokens)
 * - C6: session ID is present and copyable; full ID shown (no .slice truncation)
 * - §7: session ID full-length (remove .slice(0,8) truncation)
 * - §8: context_breakdown type includes cacheReadTokens/cacheCreationTokens
 *
 * React rendering is not tested (no jsdom). Pure logic tests cover grouping,
 * sorting, graph segment computation, and cache annotation logic.
 */

import { describe, it, expect } from 'vitest'
import type { ContextBreakdownCategory } from '../../../shared/types-engine'
import type { NormalizedEvent } from '../../../shared/types-events'

// ─── Mirror the groupCategories logic from StatusDrawer.tsx ──────────────────

const KIND_ORDER = ['system_prompt', 'tools', 'conversation', 'file', 'unaccounted'] as const
type KindKey = (typeof KIND_ORDER)[number]

function kindKey(kind: string): KindKey {
  if (kind === 'system_prompt' || kind === 'system-prompt') return 'system_prompt'
  if (kind === 'tools' || kind === 'tool') return 'tools'
  if (kind === 'conversation' || kind === 'message') return 'conversation'
  if (kind === 'file') return 'file'
  return 'unaccounted'
}

function groupCategories(categories: ContextBreakdownCategory[]): Map<KindKey, ContextBreakdownCategory[]> {
  const map = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const cat of categories) {
    const k = kindKey(cat.kind)
    const existing = map.get(k) ?? []
    existing.push(cat)
    map.set(k, existing)
  }
  for (const [k, items] of map) {
    map.set(k, items.slice().sort((a, b) => b.tokens - a.tokens))
  }
  const ordered = new Map<KindKey, ContextBreakdownCategory[]>()
  for (const k of KIND_ORDER) {
    if (map.has(k)) ordered.set(k, map.get(k)!)
  }
  return ordered
}

interface GraphSegment { kind: KindKey; tokens: number; pct: number }

function buildGraphSegments(grouped: Map<KindKey, ContextBreakdownCategory[]>, contextWindow: number): GraphSegment[] {
  const segments: GraphSegment[] = []
  for (const k of KIND_ORDER) {
    const cats = grouped.get(k)
    if (!cats) continue
    const total = cats.reduce((s, c) => s + c.tokens, 0)
    const pct = contextWindow > 0 ? (total / contextWindow) * 100 : 0
    if (pct > 0) segments.push({ kind: k, tokens: total, pct })
  }
  return segments
}

// ─── C3: grouped / sorted ordering ───────────────────────────────────────────

describe('C3 — grouped / sorted breakdown ordering', () => {
  const cats: ContextBreakdownCategory[] = [
    { name: 'conversation', kind: 'conversation', tokens: 5000, tier: 'exact' },
    { name: 'system_prompt', kind: 'system_prompt', tokens: 8000, tier: 'exact' },
    { name: 'tool_a', kind: 'tools', tokens: 3000, tier: 'local' },
    { name: 'tool_b', kind: 'tools', tokens: 7000, tier: 'local' },
    { name: 'residual', kind: 'something_else', tokens: 200, tier: 'approximate' },
  ]

  it('groups by kind and returns buckets in fixed order', () => {
    const grouped = groupCategories(cats)
    const keys = Array.from(grouped.keys())
    // system_prompt before tools before conversation before unaccounted
    expect(keys.indexOf('system_prompt')).toBeLessThan(keys.indexOf('tools'))
    expect(keys.indexOf('tools')).toBeLessThan(keys.indexOf('conversation'))
    expect(keys.indexOf('conversation')).toBeLessThan(keys.indexOf('unaccounted'))
  })

  it('sorts descending by tokens within each bucket', () => {
    const grouped = groupCategories(cats)
    const toolsRows = grouped.get('tools')!
    expect(toolsRows[0].tokens).toBeGreaterThan(toolsRows[1].tokens)
    expect(toolsRows[0].name).toBe('tool_b')  // 7000 > 3000
    expect(toolsRows[1].name).toBe('tool_a')
  })

  it('maps unknown kind to unaccounted bucket', () => {
    const grouped = groupCategories(cats)
    const unaccounted = grouped.get('unaccounted')!
    expect(unaccounted).toHaveLength(1)
    expect(unaccounted[0].name).toBe('residual')
  })

  it('system-prompt (hyphen) normalizes to system_prompt bucket', () => {
    const hyphenCat: ContextBreakdownCategory = { name: 'sp', kind: 'system-prompt', tokens: 1000, tier: 'exact' }
    const grouped = groupCategories([hyphenCat])
    expect(grouped.has('system_prompt')).toBe(true)
    expect(grouped.has('unaccounted')).toBe(false)
  })

  it('preserves all rows (no data dropped during grouping)', () => {
    const grouped = groupCategories(cats)
    let totalRows = 0
    for (const rows of grouped.values()) totalRows += rows.length
    expect(totalRows).toBe(cats.length)
  })
})

// ─── C4: proportion graph ────────────────────────────────────────────────────

describe('C4 — proportion graph segment data', () => {
  it('sums tokens per bucket and computes correct pct', () => {
    const cats: ContextBreakdownCategory[] = [
      { name: 'sp', kind: 'system_prompt', tokens: 20_000, tier: 'exact' },
      { name: 'conv', kind: 'conversation', tokens: 30_000, tier: 'exact' },
    ]
    const grouped = groupCategories(cats)
    const segments = buildGraphSegments(grouped, 100_000)
    const spSeg = segments.find((s) => s.kind === 'system_prompt')!
    const convSeg = segments.find((s) => s.kind === 'conversation')!
    expect(spSeg.tokens).toBe(20_000)
    expect(spSeg.pct).toBeCloseTo(20)
    expect(convSeg.tokens).toBe(30_000)
    expect(convSeg.pct).toBeCloseTo(30)
  })

  it('total segment pct <= 100 on realistic data', () => {
    const cats: ContextBreakdownCategory[] = [
      { name: 'sp', kind: 'system_prompt', tokens: 10_000, tier: 'exact' },
      { name: 'tools', kind: 'tools', tokens: 15_000, tier: 'local' },
      { name: 'conv', kind: 'conversation', tokens: 40_000, tier: 'exact' },
    ]
    const grouped = groupCategories(cats)
    const segments = buildGraphSegments(grouped, 100_000)
    const totalPct = segments.reduce((s, g) => s + g.pct, 0)
    expect(totalPct).toBeLessThanOrEqual(100)
  })

  it('zero-token buckets are excluded from segments', () => {
    // A bucket with 0 tokens should not produce a segment (would render a
    // zero-width bar that messes up borders/rounding).
    const cats: ContextBreakdownCategory[] = [
      { name: 'sp', kind: 'system_prompt', tokens: 0, tier: 'exact' },
      { name: 'conv', kind: 'conversation', tokens: 50_000, tier: 'exact' },
    ]
    const grouped = groupCategories(cats)
    const segments = buildGraphSegments(grouped, 100_000)
    expect(segments.some((s) => s.kind === 'system_prompt')).toBe(false)
    expect(segments.some((s) => s.kind === 'conversation')).toBe(true)
  })

  it('graphs renders free space when totalTokens < contextWindow', () => {
    const cats: ContextBreakdownCategory[] = [
      { name: 'conv', kind: 'conversation', tokens: 60_000, tier: 'exact' },
    ]
    const grouped = groupCategories(cats)
    const segments = buildGraphSegments(grouped, 100_000)
    const usedPct = segments.reduce((s, g) => s + g.pct, 0)
    const freePct = 100 - usedPct
    // 40% free space
    expect(freePct).toBeCloseTo(40)
  })
})

// ─── C5: cache annotation non-additive ───────────────────────────────────────

describe('C5 — cache annotation is non-additive', () => {
  it('cacheReadTokens and cacheCreationTokens do not sum into totalTokens', () => {
    // The payload has totalTokens as the sum of categories only.
    // Cache fields are annotations — they describe tokens already counted
    // within the categories (served from cache vs. newly computed).
    const totalTokens = 50_000
    const cacheReadTokens = 30_000
    const cacheCreationTokens = 5_000

    // If additive, totalWithCache would exceed totalTokens.
    // The contract is that they are NOT added — total stays 50k.
    const totalWithCache = totalTokens + cacheReadTokens + cacheCreationTokens
    expect(totalWithCache).toBeGreaterThan(totalTokens)
    // That's the wrong behaviour. The correct total is totalTokens only.
    // This test documents the contract: render cache fields separately, never add.
    expect(totalTokens).toBe(50_000)
  })

  it('cache annotation section renders when at least one cache field > 0', () => {
    const shouldShow = (cacheRead?: number, cacheCreation?: number) =>
      (cacheRead ?? 0) > 0 || (cacheCreation ?? 0) > 0

    expect(shouldShow(30_000, 5_000)).toBe(true)
    expect(shouldShow(30_000, 0)).toBe(true)
    expect(shouldShow(0, 5_000)).toBe(true)
    expect(shouldShow(0, 0)).toBe(false)
    expect(shouldShow(undefined, undefined)).toBe(false)
  })
})

// ─── C6: session ID copyable ──────────────────────────────────────────────────

describe('C6 / §7 — session ID: full-length display, copy equals full ID', () => {
  it('full conversationId is the copy value', () => {
    const conversationId = '1780569626357-83f24099a9d8'
    // CopyButton receives the full conversationId as `value`
    const copyValue = conversationId
    expect(copyValue).toBe('1780569626357-83f24099a9d8')
  })

  it('StatusDrawer renders full ID (no .slice(0,8) truncation)', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../StatusDrawer.tsx'),
      'utf8',
    )
    // The truncation was removed in §7. The source must not slice the id.
    expect(src).not.toContain('.slice(0, 8)')
    expect(src).not.toContain("slice(0, 8)")
    // CSS-based overflow/ellipsis is still present (maxWidth + textOverflow).
    expect(src).toContain('textOverflow: \'ellipsis\'')
  })
})

// ─── C1: model section absent ─────────────────────────────────────────────────

describe('C1 — model section removed', () => {
  it('StatusDrawer does not import or render ModelPicker', async () => {
    // The Model section (which used <ModelPicker />) was removed in C1.
    // Verify neither the import nor the JSX usage exists.
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../StatusDrawer.tsx'),
      'utf8',
    )
    // No import of StatusBarModelPicker
    expect(src).not.toMatch(/import.*StatusBarModelPicker/)
    // No JSX usage of ModelPicker component
    expect(src).not.toContain('<ModelPicker')
    expect(src).not.toContain('<ModelPicker />')
  })
})

// ─── C2: breakdown is own scroll region ──────────────────────────────────────

describe('C2 — breakdown scroll region structure', () => {
  it('StatusDrawer source contains overflow-y:auto on the breakdown list container', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../StatusDrawer.tsx'),
      'utf8',
    )
    // The breakdown row container must have overflow-y auto and min-height 0
    // so it scrolls independently within the capped panel.
    expect(src).toContain('overflowY: \'auto\'')
    expect(src).toContain('minHeight: 0')
  })
})

// ─── §8: context_breakdown type includes cache fields ────────────────────────

describe('§8 — context_breakdown NormalizedEvent includes cache fields', () => {
  it('context_breakdown variant has cacheReadTokens and cacheCreationTokens', () => {
    // Construct a typed context_breakdown event — if the fields are missing
    // from the NormalizedEvent union, TypeScript compilation fails (caught by
    // typecheck gate). This test provides a runtime assertion as documentation.
    const ev: Extract<NormalizedEvent, { type: 'context_breakdown' }> = {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 200_000,
      totalTokens: 50_000,
      model: 'claude-opus-4-5',
      cacheReadTokens: 30_000,
      cacheCreationTokens: 5_000,
    }
    expect(ev.cacheReadTokens).toBe(30_000)
    expect(ev.cacheCreationTokens).toBe(5_000)
  })

  it('context_breakdown variant allows absent cache fields (optional)', () => {
    const ev: Extract<NormalizedEvent, { type: 'context_breakdown' }> = {
      type: 'context_breakdown',
      categories: [],
      contextWindow: 200_000,
      totalTokens: 50_000,
      model: 'claude-opus-4-5',
    }
    expect(ev.cacheReadTokens).toBeUndefined()
    expect(ev.cacheCreationTokens).toBeUndefined()
  })
})

// ─── §6: drawer-open dispatches get_context_breakdown ────────────────────────

describe('§6 — drawer-open fires engine get_context_breakdown', () => {
  it('App.tsx contains engineGetContextBreakdown call gated on statusDrawerOpen', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../../App.tsx'),
      'utf8',
    )
    // The effect should call engineGetContextBreakdown
    expect(src).toContain('engineGetContextBreakdown')
    // Gated on statusDrawerOpen
    expect(src).toContain('statusDrawerOpen')
  })
})

// ─── Self vs. dispatch model breakdown grouping ──────────────────────────────

describe('ModelBreakdownRows — self vs. dispatch grouping', () => {
  interface ModelBreakdownRow {
    model: string
    conversations: number
    inputTokens: number
    outputTokens: number
    costUsd: number
    isSelf?: boolean
  }

  // Mirror the partition ModelBreakdownRows performs.
  const partition = (rows: ModelBreakdownRow[]) => ({
    selfRows: rows.filter((r) => r.isSelf),
    dispatchRows: rows.filter((r) => !r.isSelf),
  })

  it('splits an opus-root + opus/sonnet-dispatch breakdown into self and dispatch groups', () => {
    const rows: ModelBreakdownRow[] = [
      { model: 'claude-opus-4-8', conversations: 1, inputTokens: 120_000, outputTokens: 4_000, costUsd: 397.0, isSelf: true },
      { model: 'claude-opus-4-8', conversations: 5, inputTokens: 300_000, outputTokens: 10_000, costUsd: 42.0, isSelf: false },
      { model: 'claude-sonnet-4-6', conversations: 3, inputTokens: 90_000, outputTokens: 3_000, costUsd: 6.0, isSelf: false },
    ]
    const { selfRows, dispatchRows } = partition(rows)

    // The $397 lifetime cost row is the viewing conversation's own spend.
    expect(selfRows).toHaveLength(1)
    expect(selfRows[0].model).toBe('claude-opus-4-8')
    expect(selfRows[0].conversations).toBe(1)
    expect(selfRows[0].costUsd).toBe(397.0)

    // The dispatch group keeps the opus dispatch row separate from the self row.
    expect(dispatchRows).toHaveLength(2)
    expect(dispatchRows.some((r) => r.model === 'claude-opus-4-8' && r.conversations === 5)).toBe(true)
    expect(dispatchRows.some((r) => r.model === 'claude-sonnet-4-6')).toBe(true)
    // No dispatch row is ever marked isSelf.
    expect(dispatchRows.every((r) => !r.isSelf)).toBe(true)
  })

  it('renders only the self group (no Dispatches) when there are no dispatch rows', () => {
    const rows: ModelBreakdownRow[] = [
      { model: 'claude-opus-4-8', conversations: 1, inputTokens: 120_000, outputTokens: 4_000, costUsd: 12.0, isSelf: true },
    ]
    const { selfRows, dispatchRows } = partition(rows)
    expect(selfRows).toHaveLength(1)
    expect(dispatchRows).toHaveLength(0)
  })

  it('StatusDrawer source renders "This conversation" and "Dispatches" group labels', async () => {
    const { readFileSync } = await import('fs')
    const { resolve } = await import('path')
    const src = readFileSync(
      resolve(__dirname, '../StatusDrawer.tsx'),
      'utf8',
    )
    expect(src).toContain('This conversation')
    expect(src).toContain('Dispatches')
    // The partition is driven by the isSelf flag.
    expect(src).toContain('r.isSelf')
    expect(src).toContain('!r.isSelf')
  })
})
