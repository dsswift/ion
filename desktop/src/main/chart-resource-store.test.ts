/**
 * Chart resource store tests.
 *
 * These drive the REAL filesystem under an isolated HOME rather than mocking
 * `fs`: the store's whole job is durable state, and a mocked write proves
 * nothing about what survives a restart. `setup-globals.ts` already points
 * HOME at a per-worker temp dir; each test additionally scopes itself to its
 * own conversation id so records cannot leak between cases.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

import {
  CHART_RESOURCE_KIND,
  chartIdFromToolCallId,
  chartResourceItem,
  commitChartRequest,
  loadChartRecords,
  parseChartRecord,
  rebuildFromHistory,
  type ChartHistoryRow,
} from './chart-resource-store'
import { parseChartToolInput } from '../shared/chart-parse'
import { formatChartResultSummary } from '../shared/chart-result'
import type { ChartRequest, ChartSpec } from '../shared/chart-schema'
import {
  asCreateInput,
  asUpdateInput,
  cloneSpec,
  groupedBarScenario,
  multiLineScenario,
} from '../shared/__tests__/chart-scenario-fixtures'

let conversationId: string
let counter = 0

function conversationDir(id: string): string {
  return join(homedir(), '.ion', 'resources', id)
}

beforeEach(() => {
  counter += 1
  conversationId = `conv-chart-${Date.now()}-${counter}`
  mkdirSync(conversationDir(conversationId), { recursive: true })
})

afterEach(() => {
  rmSync(conversationDir(conversationId), { recursive: true, force: true })
})

/** Build a validated request from a fixture spec. */
function createRequest(spec: ChartSpec): ChartRequest {
  const parsed = parseChartToolInput(asCreateInput(spec))
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.request
}

function updateRequest(spec: ChartSpec, chartId: string, expectedTitle: string): ChartRequest {
  const parsed = parseChartToolInput(asUpdateInput(spec, chartId, expectedTitle))
  if (!parsed.ok) throw new Error(parsed.message)
  return parsed.request
}

function commit(request: ChartRequest, toolCallId: string) {
  return commitChartRequest(request, { conversationId, toolCallId })
}

describe('create', () => {
  it('persists a new chart at revision 1 and reports the create op', () => {
    const result = commit(createRequest(multiLineScenario), 'tool-gate-aaa')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.op).toBe('create')
    expect(result.record.revision).toBe(1)
    expect(result.record.title).toBe(multiLineScenario.title)
    expect(result.record.toolMessageId).toBe('tool-gate-aaa')
    expect(result.record.spec.datasets).toHaveLength(3)
  })

  it('writes a file that reloads with the exact same values', () => {
    // Exactness is the entire product promise: a reloaded chart must carry the
    // numbers the model supplied, not a re-derived approximation.
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[0].data = [1234.5678, -0.25, 0, 999999, 0.001, 42]
    const created = commit(createRequest(spec), 'tool-gate-exact')
    expect(created.ok).toBe(true)

    const reloaded = loadChartRecords(conversationId)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0].spec.datasets[0].data).toEqual([1234.5678, -0.25, 0, 999999, 0.001, 42])
  })

  it('derives the chart id from the tool-call id', () => {
    const result = commit(createRequest(multiLineScenario), 'tool-gate-1730000000000-7')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.chartId).toBe(chartIdFromToolCallId('tool-gate-1730000000000-7'))
  })

  it('refuses a duplicate title and names the existing chart to update', () => {
    const first = commit(createRequest(multiLineScenario), 'tool-gate-first')
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const second = commit(createRequest(multiLineScenario), 'tool-gate-second')
    expect(second.ok).toBe(false)
    if (second.ok) return
    // The refusal must be actionable: it tells the model the id and the exact
    // call shape that would update the chart instead.
    expect(second.message).toContain(first.record.chartId)
    expect(second.message).toContain('operation: "update"')
  })

  it('refuses to save when the conversation has no durable id', () => {
    const result = commitChartRequest(createRequest(multiLineScenario), {
      conversationId: '',
      toolCallId: 'tool-gate-x',
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('no durable id')
  })
})

describe('update', () => {
  it('replaces the spec wholesale and increments the revision', () => {
    const created = commit(createRequest(multiLineScenario), 'tool-gate-c1')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const revised = cloneSpec(multiLineScenario)
    revised.datasets[0].data = [200, 210, 220, 230, 240, 250]
    const updated = commit(
      updateRequest(revised, created.record.chartId, created.record.title),
      'tool-gate-c2',
    )
    expect(updated.ok).toBe(true)
    if (!updated.ok) return

    expect(updated.op).toBe('update')
    expect(updated.record.revision).toBe(2)
    expect(updated.record.chartId).toBe(created.record.chartId)
    // The anchor moves to the newest tool row: that is what the attachments
    // panel jumps to.
    expect(updated.record.toolMessageId).toBe('tool-gate-c2')
    expect(updated.record.spec.datasets[0].data).toEqual([200, 210, 220, 230, 240, 250])
    // createdAt is preserved so the chart keeps its original age.
    expect(updated.record.createdAt).toBe(created.record.createdAt)
  })

  it('leaves exactly one record on disk after an update', () => {
    const created = commit(createRequest(multiLineScenario), 'tool-gate-one')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    commit(updateRequest(multiLineScenario, created.record.chartId, created.record.title), 'tool-gate-two')

    // The store holds CURRENT state, not a revision log — history lives in the
    // conversation's tool rows.
    expect(loadChartRecords(conversationId)).toHaveLength(1)
    expect(loadChartRecords(conversationId)[0].revision).toBe(2)
  })

  it('refuses an unknown chart id and lists the known charts', () => {
    const created = commit(createRequest(multiLineScenario), 'tool-gate-known')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const result = commit(updateRequest(multiLineScenario, 'not-a-chart', multiLineScenario.title), 'tool-gate-bad')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('No chart with id "not-a-chart"')
    expect(result.message).toContain(created.record.chartId)
  })

  it('refuses a title mismatch rather than overwriting the wrong chart', () => {
    // This is the guard that makes a hallucinated id safe: without it, a wrong
    // id plus a plausible spec would silently replace an unrelated chart.
    const created = commit(createRequest(multiLineScenario), 'tool-gate-guard')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const result = commit(
      updateRequest(multiLineScenario, created.record.chartId, 'A completely different title'),
      'tool-gate-guard2',
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('is currently titled')
    // The original record is untouched.
    expect(loadChartRecords(conversationId)[0].revision).toBe(1)
  })

  it('refuses a rename that collides with another chart title', () => {
    const first = commit(createRequest(multiLineScenario), 'tool-gate-a')
    const second = commit(createRequest(groupedBarScenario), 'tool-gate-b')
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    const renamed = cloneSpec(groupedBarScenario)
    renamed.title = multiLineScenario.title
    const result = commit(updateRequest(renamed, second.record.chartId, second.record.title), 'tool-gate-c')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.message).toContain('already titled')
  })

  it('allows a rename to a free title', () => {
    const created = commit(createRequest(multiLineScenario), 'tool-gate-r1')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const renamed = cloneSpec(multiLineScenario)
    renamed.title = 'Renamed comparison'
    const result = commit(updateRequest(renamed, created.record.chartId, created.record.title), 'tool-gate-r2')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.record.title).toBe('Renamed comparison')
    expect(result.record.chartId).toBe(created.record.chartId)
  })
})

describe('multiple charts', () => {
  it('keeps distinct charts side by side', () => {
    commit(createRequest(multiLineScenario), 'tool-gate-m1')
    commit(createRequest(groupedBarScenario), 'tool-gate-m2')
    const records = loadChartRecords(conversationId)
    expect(records).toHaveLength(2)
    expect(records.map((r) => r.title).sort()).toEqual(
      [groupedBarScenario.title, multiLineScenario.title].sort(),
    )
  })
})

describe('durability', () => {
  it('skips a corrupt file without hiding its siblings', () => {
    commit(createRequest(multiLineScenario), 'tool-gate-good')
    writeFileSync(join(conversationDir(conversationId), 'chart-broken.json'), '{ not json', 'utf-8')

    // One unreadable record must not blank the attachments panel.
    const records = loadChartRecords(conversationId)
    expect(records).toHaveLength(1)
    expect(records[0].title).toBe(multiLineScenario.title)
  })

  it('rejects a record whose spec this build cannot render', () => {
    // Same strictness as the tool boundary, so a future-schema record degrades
    // to "absent" rather than rendering half-understood.
    const record = parseChartRecord({
      chartId: 'c1', title: 'x', revision: 1, toolMessageId: 't',
      createdAt: 'now', updatedAt: 'now',
      spec: { schemaVersion: 99, kind: 'line', title: 'x', labels: ['a'], datasets: [] },
    }, conversationId)
    expect(record).toBeNull()
  })

  it('returns an empty list for a conversation with no directory', () => {
    expect(loadChartRecords(`missing-${Date.now()}`)).toEqual([])
  })
})

describe('resource item projection', () => {
  it('carries navigation metadata a metadata-only consumer can route on', () => {
    const created = commit(createRequest(multiLineScenario), 'tool-gate-proj')
    expect(created.ok).toBe(true)
    if (!created.ok) return

    const item = chartResourceItem(created.record)
    expect(item.kind).toBe(CHART_RESOURCE_KIND)
    expect(item.id).toBe(created.record.chartId)
    expect(item.title).toBe(created.record.title)
    expect(item.conversationId).toBe(conversationId)
    // iOS receives metadata without full content, so the fields it needs to
    // render and route a row must live in metadata, not only in content.
    expect(item.metadata).toMatchObject({
      chartRevision: 1,
      chartToolMessageId: 'tool-gate-proj',
      chartKind: 'line',
      chartSeriesCount: 3,
      chartPointCount: 6,
    })
    const parsedContent = JSON.parse(item.content)
    expect(parsedContent.spec.datasets).toHaveLength(3)
  })
})

describe('branch-aware rebuild', () => {
  /**
   * A branch row, in the shape the real system produces.
   *
   * The row id and the chart id are deliberately from DIFFERENT id spaces: a
   * transcript row is keyed by the engine's tool-use id (`toolu_…`), while a
   * chart id is minted from the tool-gate request id (`tool-gate-…`). Identity
   * therefore comes from the committed RESULT text, which is what these rows
   * carry — a fixture that reused one id as both would let a rebuild keyed on
   * the row id look correct while dropping every real update.
   */
  function row(
    toolMessageId: string,
    input: Record<string, unknown>,
    index: number,
    chartId: string,
  ): ChartHistoryRow {
    const spec = input as { title?: string; kind?: string; labels?: unknown[]; datasets?: unknown[] }
    return {
      toolMessageId,
      toolInput: JSON.stringify(input),
      resultText: formatChartResultSummary({
        operation: (input as { operation?: 'create' | 'update' }).operation ?? 'create',
        chartId,
        title: spec.title ?? '',
        kind: spec.kind ?? 'line',
        datasets: spec.datasets?.length ?? 0,
        points: spec.labels?.length ?? 0,
        revision: 1,
      }),
      index,
    }
  }

  const ROW_1 = 'toolu_01AbCdEfGhIjKlMnOpQr01'
  const ROW_2 = 'toolu_01AbCdEfGhIjKlMnOpQr02'
  const CHART_1 = 'tool-gate-1787864702164461001-1'

  it('rebuilds current state from the rows a branch can see', () => {
    const rows = [
      row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
      row(ROW_2, asUpdateInput(multiLineScenario, CHART_1, multiLineScenario.title), 1, CHART_1),
    ]
    const { records } = rebuildFromHistory(conversationId, rows)
    expect(records).toHaveLength(1)
    expect(records[0].chartId).toBe(CHART_1)
    expect(records[0].revision).toBe(2)
    expect(records[0].toolMessageId).toBe(ROW_2)
  })

  it('takes identity from the result text, never from the tool-use row id', () => {
    // The regression this pins: deriving the chart id from the row id produced
    // an id no update could match, so every revision orphaned silently.
    const { records } = rebuildFromHistory(conversationId, [
      row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
    ])
    expect(records[0].chartId).toBe(CHART_1)
    expect(records[0].chartId).not.toBe(chartIdFromToolCallId(ROW_1))
  })

  it('ignores a row whose result states no chart id', () => {
    // A refused call never committed a chart, so it must contribute nothing
    // rather than mint an identity the tool never wrote.
    const { records } = rebuildFromHistory(conversationId, [
      {
        toolMessageId: ROW_1,
        toolInput: JSON.stringify(asCreateInput(multiLineScenario)),
        resultText: 'Chart rejected: title is required.',
        index: 0,
      },
    ])
    expect(records).toHaveLength(0)
  })

  it('drops a revision the branch no longer contains after a rewind', () => {
    // This is the rewind guarantee: an abandoned future revision must not stay
    // current, or the user would see data their branch never produced.
    const revised = cloneSpec(multiLineScenario)
    revised.datasets[0].data = [900, 900, 900, 900, 900, 900]
    rebuildFromHistory(conversationId, [
      row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
      row(ROW_2, asUpdateInput(revised, CHART_1, multiLineScenario.title), 1, CHART_1),
    ])
    expect(loadChartRecords(conversationId)[0].revision).toBe(2)

    // Rewind: only the first row survives on this branch.
    const { records, updated } = rebuildFromHistory(conversationId, [
      row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
    ])
    expect(records).toHaveLength(1)
    expect(records[0].revision).toBe(1)
    expect(records[0].toolMessageId).toBe(ROW_1)
    expect(records[0].spec.datasets[0].data).toEqual(multiLineScenario.datasets[0].data)
    // The reverted record moved, so it must be published — a retained
    // classification here would leave every subscriber on the abandoned data.
    expect(updated.map((record) => record.chartId)).toEqual([CHART_1])
  })

  it('removes a chart whose creating row is gone from the branch', () => {
    commit(createRequest(multiLineScenario), 'tool-gate-orphan')
    expect(loadChartRecords(conversationId)).toHaveLength(1)

    const { records, removed } = rebuildFromHistory(conversationId, [])
    expect(records).toHaveLength(0)
    expect(removed).toHaveLength(1)
    // The file is gone, so the attachments panel cannot offer a dead jump.
    expect(existsSync(join(conversationDir(conversationId), `chart-${removed[0]}.json`))).toBe(false)
  })

  it('ignores a partially-streamed tool input', () => {
    // Mid-turn the input is incomplete JSON; it is not a revision yet.
    const { records } = rebuildFromHistory(conversationId, [
      { toolMessageId: ROW_1, toolInput: '{"schemaVersion":1,"kind":"li', resultText: '', index: 0 },
    ])
    expect(records).toHaveLength(0)
  })

  it('ignores an update whose target was never created on this branch', () => {
    const { records } = rebuildFromHistory(conversationId, [
      row(ROW_2, asUpdateInput(multiLineScenario, CHART_1, multiLineScenario.title), 0, CHART_1),
    ])
    expect(records).toHaveLength(0)
  })

  it('is idempotent when the branch has not changed', () => {
    const rows = [row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1)]
    const first = rebuildFromHistory(conversationId, rows)
    const firstBody = readFileSync(
      join(conversationDir(conversationId), `chart-${first.records[0].chartId}.json`), 'utf-8',
    )
    const second = rebuildFromHistory(conversationId, rows)
    const secondBody = readFileSync(
      join(conversationDir(conversationId), `chart-${second.records[0].chartId}.json`), 'utf-8',
    )
    expect(secondBody).toBe(firstBody)
  })

  /**
   * The partition is what stops a reconcile fanning no-op deltas.
   *
   * Every rewind rebuilds the whole conversation's index, so without this an
   * unrelated chart would be republished to the Overlay, the Studio mirror, and
   * iOS on every branch change.
   */
  describe('publish partition', () => {
    it('reports a first-time chart as created', () => {
      const { created, updated, retained, removed } = rebuildFromHistory(conversationId, [
        row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
      ])
      expect(created.map((record) => record.chartId)).toEqual([CHART_1])
      expect(updated).toHaveLength(0)
      expect(retained).toHaveLength(0)
      expect(removed).toHaveLength(0)
    })

    it('reports an unchanged chart as retained, never as created or updated', () => {
      const rows = [row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1)]
      rebuildFromHistory(conversationId, rows)
      const second = rebuildFromHistory(conversationId, rows)
      expect(second.retained.map((record) => record.chartId)).toEqual([CHART_1])
      expect(second.created).toHaveLength(0)
      expect(second.updated).toHaveLength(0)
    })

    it('reports a revised chart as updated', () => {
      rebuildFromHistory(conversationId, [row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1)])
      const { created, updated, retained } = rebuildFromHistory(conversationId, [
        row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1),
        row(ROW_2, asUpdateInput(multiLineScenario, CHART_1, multiLineScenario.title), 1, CHART_1),
      ])
      expect(updated.map((record) => record.chartId)).toEqual([CHART_1])
      expect(updated[0].revision).toBe(2)
      expect(created).toHaveLength(0)
      expect(retained).toHaveLength(0)
    })

    it('reports nothing for a conversation with no durable id', () => {
      const outcome = rebuildFromHistory('', [row(ROW_1, asCreateInput(multiLineScenario), 0, CHART_1)])
      expect(outcome.records).toHaveLength(0)
      expect(outcome.created).toHaveLength(0)
      expect(outcome.removed).toHaveLength(0)
    })
  })
})
