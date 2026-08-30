/**
 * chart-revisions tests — one full card, markers elsewhere, and branch-aware
 * derivation.
 *
 * The derivation is what makes rewind correct, so the rewind case is tested by
 * building the SAME message list minus the later rows: exactly what the store
 * hands the renderer after a branch change.
 *
 * ── Identifiers here are deliberately DIFFERENT from each other ─────────────
 * A tool row's id is the engine's tool-use id (`toolu_…`); a chart's id is
 * minted in the main process from the tool-gate request id
 * (`tool-gate-<nanos>-<seq>`). They never match in the running system.
 *
 * An earlier version of this file used the SAME short string (`t1`) as both
 * the row id and the chart id, which made the renderer's since-removed
 * "derive the chart id from the row id" rule look correct. It was not: every
 * update row failed to find its timeline and was silently dropped, so a
 * chart's revision badge and previous/next controls never appeared. The
 * fixtures below keep the two identifier families distinct so that class of
 * defect cannot pass again.
 */
import { describe, expect, it } from 'vitest'
import {
  chartRendersForRows,
  chartRowRenders,
  deriveChartTimelines,
  hasSeveralRevisions,
  revisionStatus,
} from './chart-revisions'
import {
  asCreateInput,
  asUpdateInput,
  cloneSpec,
  groupedBarScenario,
  multiLineScenario,
} from '../../../shared/__tests__/chart-scenario-fixtures'
import type { ChartSpec } from '../../../shared/chart-schema'
import { formatChartResultSummary } from '../../../shared/chart-result'
import type { Message } from '../../../shared/types'

/** An engine tool-use id, in the shape a real transcript row carries. */
function rowId(n: number): string {
  return `toolu_01AbCdEfGhIjKlMnOpQr${String(n).padStart(2, '0')}`
}

/** A chart id, in the shape the main process actually mints. */
function chartIdFor(n: number): string {
  return `tool-gate-178786470216446100${n}-${n}`
}

/**
 * A completed chart tool row.
 *
 * `content` is built by the SHARED formatter, because that string is the only
 * place a chart's identity is stated — the renderer reads the id back out of
 * it. A fixture that wrote arbitrary prose here would test nothing about the
 * real identity channel.
 */
function chartRow(
  id: string,
  input: Record<string, unknown>,
  chartId: string,
  overrides: Partial<Message> = {},
): Message {
  const spec = input as { title?: string; kind?: string; labels?: unknown[]; datasets?: unknown[] }
  return {
    id,
    role: 'tool',
    content: formatChartResultSummary({
      operation: (input as { operation?: 'create' | 'update' }).operation ?? 'create',
      chartId,
      title: spec.title ?? '',
      kind: spec.kind ?? 'line',
      datasets: spec.datasets?.length ?? 0,
      points: spec.labels?.length ?? 0,
      revision: 1,
    }),
    toolName: 'RenderChart',
    toolId: id,
    toolInput: JSON.stringify(input),
    toolStatus: 'completed',
    timestamp: 1,
    ...overrides,
  }
}

const R1 = rowId(1)
const R2 = rowId(2)
const R3 = rowId(3)
const C1 = chartIdFor(1)
const C2 = chartIdFor(2)

function userRow(id: string): Message {
  return { id, role: 'user', content: 'do the thing', timestamp: 1 }
}

function createRow(id: string, spec: ChartSpec, chartId: string): Message {
  return chartRow(id, asCreateInput(spec), chartId)
}

function updateRow(id: string, spec: ChartSpec, chartId: string, expectedTitle: string): Message {
  return chartRow(id, asUpdateInput(spec, chartId, expectedTitle), chartId)
}

describe('single chart', () => {
  it('derives one timeline with one revision', () => {
    const timelines = deriveChartTimelines([userRow('u1'), createRow(R1, multiLineScenario, C1)])
    expect(timelines).toHaveLength(1)
    expect(timelines[0].revisions).toHaveLength(1)
    expect(timelines[0].title).toBe(multiLineScenario.title)
    expect(timelines[0].currentMessageId).toBe(R1)
  })

  it('renders the only revision as the current card', () => {
    const renders = chartRowRenders([createRow(R1, multiLineScenario, C1)])
    expect(renders.get(R1)?.kind).toBe('current')
  })

  it('reports no revision chrome for a single revision', () => {
    const [timeline] = deriveChartTimelines([createRow(R1, multiLineScenario, C1)])
    expect(hasSeveralRevisions(timeline)).toBe(false)
    expect(revisionStatus(timeline, 0)).toBe('only')
  })
})

describe('updates', () => {
  function revisedSpec(): ChartSpec {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[0].data = [500, 510, 520, 530, 540, 550]
    return spec
  }

  it('collects every revision in branch order', () => {
    const timelines = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      userRow('u1'),
      updateRow(R2, revisedSpec(), C1, multiLineScenario.title),
    ])
    expect(timelines).toHaveLength(1)
    expect(timelines[0].revisions.map((r) => r.messageId)).toEqual([R1, R2])
    expect(timelines[0].revisions.map((r) => r.revision)).toEqual([1, 2])
  })

  it('moves the current card to the newest revision', () => {
    const renders = chartRowRenders([
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, revisedSpec(), C1, multiLineScenario.title),
    ])
    // The original location keeps its place in history but stops drawing a
    // full (now wrong) chart.
    expect(renders.get(R1)).toMatchObject({ kind: 'moved', targetMessageId: R2 })
    expect(renders.get(R2)?.kind).toBe('current')
  })

  it('keeps the moved marker pointing at the newest revision after three edits', () => {
    const renders = chartRowRenders([
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, revisedSpec(), C1, multiLineScenario.title),
      updateRow(R3, revisedSpec(), C1, multiLineScenario.title),
    ])
    expect(renders.get(R1)).toMatchObject({ kind: 'moved', targetMessageId: R3 })
    expect(renders.get(R2)).toMatchObject({ kind: 'moved', targetMessageId: R3 })
    expect(renders.get(R3)?.kind).toBe('current')
  })

  it('follows a rename onto the marker and the timeline', () => {
    const renamed = cloneSpec(multiLineScenario)
    renamed.title = 'Renamed comparison'
    const messages = [
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, renamed, C1, multiLineScenario.title),
    ]
    expect(deriveChartTimelines(messages)[0].title).toBe('Renamed comparison')
    expect(chartRowRenders(messages).get(R1)).toMatchObject({ title: 'Renamed comparison' })
  })

  it('labels pages current and outdated only when several revisions exist', () => {
    const [timeline] = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, revisedSpec(), C1, multiLineScenario.title),
    ])
    expect(hasSeveralRevisions(timeline)).toBe(true)
    expect(revisionStatus(timeline, 0)).toBe('outdated')
    expect(revisionStatus(timeline, 1)).toBe('current')
  })

  it('keeps each revision spec intact for paging', () => {
    // Paging back must show what that revision actually said, not the newest
    // data drawn under an old label.
    const [timeline] = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, revisedSpec(), C1, multiLineScenario.title),
    ])
    expect(timeline.revisions[0].spec.datasets[0].data).toEqual(multiLineScenario.datasets[0].data)
    expect(timeline.revisions[1].spec.datasets[0].data).toEqual([500, 510, 520, 530, 540, 550])
  })
})

describe('branch awareness', () => {
  it('drops revisions the branch no longer contains after a rewind', () => {
    const revised = cloneSpec(multiLineScenario)
    revised.datasets[0].data = [900, 900, 900, 900, 900, 900]
    const full = [
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, revised, C1, multiLineScenario.title),
    ]
    expect(deriveChartTimelines(full)[0].revisions).toHaveLength(2)

    // After a rewind the store hands the renderer the shorter list.
    const rewound = deriveChartTimelines([full[0]])
    expect(rewound[0].revisions).toHaveLength(1)
    expect(rewound[0].currentMessageId).toBe(R1)
    expect(rewound[0].revisions[0].spec.datasets[0].data).toEqual(multiLineScenario.datasets[0].data)
    // The rewound branch renders a full card again, not a marker pointing at a
    // revision it cannot show.
    expect(chartRowRenders([full[0]]).get(R1)?.kind).toBe('current')
  })

  it('ignores an update whose create is not on this branch', () => {
    const orphan = updateRow(R2, multiLineScenario, C1, multiLineScenario.title)
    expect(deriveChartTimelines([orphan])).toHaveLength(0)
    expect(chartRowRenders([orphan]).size).toBe(0)
  })
})

describe('non-contributing rows', () => {
  it('ignores a failed chart call so a refusal cannot change the current chart', () => {
    const failed = chartRow(R2, asCreateInput(groupedBarScenario), C2, { toolStatus: 'error' })
    const timelines = deriveChartTimelines([createRow(R1, multiLineScenario, C1), failed])
    expect(timelines).toHaveLength(1)
    expect(timelines[0].title).toBe(multiLineScenario.title)
  })

  it('ignores a still-running row', () => {
    const running = chartRow(R1, asCreateInput(multiLineScenario), C1, { toolStatus: 'running' })
    expect(deriveChartTimelines([running])).toHaveLength(0)
  })

  it('ignores partial streamed JSON', () => {
    const partial: Message = {
      id: R1, role: 'tool', content: '', toolName: 'RenderChart', toolId: R1,
      toolInput: '{"schemaVersion":1,"kind":"li', toolStatus: 'completed', timestamp: 1,
    }
    expect(deriveChartTimelines([partial])).toHaveLength(0)
  })

  it('ignores rows from other tools and non-tool roles', () => {
    const other: Message = {
      id: 'x1', role: 'tool', content: 'ok', toolName: 'Read', toolId: 'x1',
      toolInput: '{"file_path":"/tmp/a"}', toolStatus: 'completed', timestamp: 1,
    }
    expect(deriveChartTimelines([other, userRow('u1')])).toHaveLength(0)
  })

  it('ignores input this build cannot render', () => {
    const future = chartRow(R1, { ...asCreateInput(multiLineScenario), schemaVersion: 99 }, C1)
    expect(deriveChartTimelines([future])).toHaveLength(0)
  })
})

describe('several charts', () => {
  it('keeps distinct charts independent', () => {
    const timelines = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      createRow(R2, groupedBarScenario, C2),
    ])
    expect(timelines).toHaveLength(2)
    expect(timelines.map((t) => t.title).sort()).toEqual(
      [groupedBarScenario.title, multiLineScenario.title].sort(),
    )
    // Updating one must not move the other's card.
    const renders = chartRowRenders([
      createRow(R1, multiLineScenario, C1),
      createRow(R2, groupedBarScenario, C2),
      updateRow(R3, multiLineScenario, C1, multiLineScenario.title),
    ])
    expect(renders.get(R1)?.kind).toBe('moved')
    expect(renders.get(R2)?.kind).toBe('current')
    expect(renders.get(R3)?.kind).toBe('current')
  })
})

describe('group scoping', () => {
  it('returns only the renders a group of rows owns', () => {
    const all = [
      createRow(R1, multiLineScenario, C1),
      userRow('u1'),
      createRow(R2, groupedBarScenario, C2),
    ]
    const owned = chartRendersForRows([all[2]], all)
    expect(owned).toHaveLength(1)
    expect(owned[0].messageId).toBe(R2)
  })

  it('resolves a marker whose current revision lives in another group', () => {
    // The whole message list is the input precisely so a group can learn its
    // row was superseded by a later turn.
    const all = [
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, multiLineScenario, C1, multiLineScenario.title),
    ]
    const owned = chartRendersForRows([all[0]], all)
    expect(owned[0].render).toMatchObject({ kind: 'moved', targetMessageId: R2 })
  })

  it('returns nothing for a group with no chart rows', () => {
    expect(chartRendersForRows([userRow('u1')], [userRow('u1')])).toHaveLength(0)
  })
})

/**
 * Identity comes from the row's RESULT, never from its id.
 *
 * These are the direct regression pins for the shipped defect: the main
 * process mints a chart id from the tool-gate request id, the renderer sees
 * only the engine's tool-use id, and the two never match. Deriving one from
 * the other dropped every update.
 */
describe('chart identity channel', () => {
  it('groups a create and its update even though row ids share nothing with the chart id', () => {
    // The exact production shape: row ids are `toolu_…`, the chart id is
    // `tool-gate-…`. No substring of either appears in the other.
    expect(R1.includes(C1)).toBe(false)
    expect(C1.includes(R1)).toBe(false)

    const timelines = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      updateRow(R2, multiLineScenario, C1, multiLineScenario.title),
    ])

    expect(timelines).toHaveLength(1)
    expect(timelines[0].chartId).toBe(C1)
    expect(timelines[0].revisions).toHaveLength(2)
    expect(timelines[0].currentMessageId).toBe(R2)
  })

  it('ignores a row whose result states no chart id', () => {
    // A row with prose that is not a chart result has no identity to group by,
    // so it must contribute nothing rather than invent an id.
    const noId = chartRow(R1, asCreateInput(multiLineScenario), C1, {
      content: 'Chart rendered.',
    })
    expect(deriveChartTimelines([noId])).toHaveLength(0)
  })

  it('trusts the committed result over a mismatched chartId argument', () => {
    // The `chartId` in an update's INPUT is the model's claim; the result is
    // what the main process actually committed. A stale or hallucinated
    // argument must not graft a revision onto a different chart.
    const timelines = deriveChartTimelines([
      createRow(R1, multiLineScenario, C1),
      createRow(R2, groupedBarScenario, C2),
      // Input claims C1, but this row's committed result says C2.
      chartRow(R3, asUpdateInput(multiLineScenario, C1, multiLineScenario.title), C2),
    ])

    const byId = new Map(timelines.map((t) => [t.chartId, t]))
    expect(byId.get(C1)?.revisions).toHaveLength(1)
    expect(byId.get(C2)?.revisions).toHaveLength(2)
    expect(byId.get(C2)?.currentMessageId).toBe(R3)
  })
})
