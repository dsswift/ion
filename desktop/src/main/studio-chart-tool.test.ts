/**
 * RenderChart tool tests — the model-facing contract.
 *
 * Two things matter here and are tested separately: what the tool ACCEPTS
 * (every synthetic scenario, so the declared schema and the parser agree), and
 * what it TELLS the model (a short confirmation that carries the identity
 * needed for a later update, and a refusal that says how to fix the call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

vi.mock('./logger', () => ({
  log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
}))

import {
  RENDER_CHART_TOOL,
  RENDER_CHART_TOOL_NAME,
  executeRenderChart,
} from './studio-chart-tool'
import { loadChartRecords } from './chart-resource-store'
import { CHART_LIMITS, CHART_SCHEMA_VERSION } from '../shared/chart-schema'
import {
  CHART_SCENARIOS,
  asCreateInput,
  asUpdateInput,
  cloneSpec,
  comparisonOverlayScenario,
  cumulativeScenario,
  groupedBarScenario,
  logarithmicScenario,
  mixedDualAxisScenario,
  multiLineScenario,
  nullGapScenario,
  pieScenario,
} from '../shared/__tests__/chart-scenario-fixtures'

let conversationId: string
let counter = 0

function conversationDir(id: string): string {
  return join(homedir(), '.ion', 'resources', id)
}

function ctx(toolCallId: string) {
  return { sessionKey: 'tab-1', conversationId, toolCallId }
}

beforeEach(() => {
  counter += 1
  conversationId = `conv-tool-${Date.now()}-${counter}`
  mkdirSync(conversationDir(conversationId), { recursive: true })
})

afterEach(() => {
  rmSync(conversationDir(conversationId), { recursive: true, force: true })
})

describe('declaration', () => {
  it('advertises the tool the executor implements', () => {
    // A declared-but-unexecutable tool is discovered by the model only when it
    // fails, so the name is asserted against the executor's own constant.
    expect(RENDER_CHART_TOOL.name).toBe(RENDER_CHART_TOOL_NAME)
    expect(RENDER_CHART_TOOL.planModeSafe).toBe(true)
    expect(RENDER_CHART_TOOL.humanWait).toBeUndefined()
  })

  it('declares a schema whose required fields match the parser', () => {
    const schema = RENDER_CHART_TOOL.inputSchema as Record<string, unknown>
    expect(schema.required).toEqual(['schemaVersion', 'kind', 'title', 'labels', 'datasets'])
    expect(schema.additionalProperties).toBe(false)
    const props = schema.properties as Record<string, Record<string, unknown>>
    expect(props.schemaVersion.enum).toEqual([CHART_SCHEMA_VERSION])
    expect(props.datasets.maxItems).toBe(CHART_LIMITS.maxDatasets)
    expect(props.labels.maxItems).toBe(CHART_LIMITS.maxPoints)
  })

  it('tells the model that several series belong on one chart', () => {
    // The multi-series affordance is the whole point of the feature; if the
    // description does not say so the model renders one chart per series.
    expect(RENDER_CHART_TOOL.description).toContain('ONE chart')
    expect(RENDER_CHART_TOOL.description).toContain('null')
    expect(RENDER_CHART_TOOL.description).toContain('update')
  })
})

describe('accepting every supported shape', () => {
  for (const scenario of CHART_SCENARIOS) {
    it(`renders ${scenario.id}`, () => {
      const result = executeRenderChart(asCreateInput(scenario.spec), ctx(`tool-${scenario.id}`))
      expect(result.isError).toBe(false)
      expect(result.publish?.op).toBe('create')
      expect(result.publish?.record.spec.kind).toBe(scenario.spec.kind)
    })
  }
})

describe('rendered shapes carry their distinguishing features', () => {
  it('keeps three colored lines as three series', () => {
    const result = executeRenderChart(asCreateInput(multiLineScenario), ctx('tool-lines'))
    const spec = result.publish!.record.spec
    expect(spec.datasets).toHaveLength(3)
    expect(spec.datasets.map((d) => d.color)).toEqual(['#3366ff', '#ff8833', '#22aa77'])
  })

  it('keeps grouped bars unstacked with a currency axis', () => {
    const result = executeRenderChart(asCreateInput(groupedBarScenario), ctx('tool-bars'))
    const spec = result.publish!.record.spec
    expect(spec.kind).toBe('bar')
    expect(spec.stacked).toBeUndefined()
    expect(spec.leftAxis?.format).toMatchObject({ kind: 'currency', currency: 'USD' })
  })

  it('keeps a mixed chart bound to two axes', () => {
    const result = executeRenderChart(asCreateInput(mixedDualAxisScenario), ctx('tool-mixed'))
    const spec = result.publish!.record.spec
    expect(spec.datasets[0]).toMatchObject({ kind: 'bar', axis: 'left' })
    expect(spec.datasets[1]).toMatchObject({ kind: 'line', axis: 'right' })
    expect(spec.rightAxis?.scale ?? 'linear').toBe('linear')
  })

  it('keeps reference lines and range bands', () => {
    const result = executeRenderChart(asCreateInput(comparisonOverlayScenario), ctx('tool-overlay'))
    const spec = result.publish!.record.spec
    expect(spec.referenceLines).toHaveLength(1)
    expect(spec.rangeBands).toHaveLength(1)
  })

  it('stores cumulative as a flag, not as pre-summed data', () => {
    // Ion owns the arithmetic. Persisting the source values means a later
    // renderer change cannot disagree with a total baked in at write time.
    const result = executeRenderChart(asCreateInput(cumulativeScenario), ctx('tool-cumulative'))
    const spec = result.publish!.record.spec
    expect(spec.datasets[0].cumulative).toBe(true)
    expect(spec.datasets[0].data).toEqual([10, 20, null, 30, 40, 50])
  })

  it('keeps a logarithmic axis and explicit slice colors', () => {
    const log = executeRenderChart(asCreateInput(logarithmicScenario), ctx('tool-log'))
    expect(log.publish!.record.spec.leftAxis?.scale).toBe('logarithmic')

    const pie = executeRenderChart(asCreateInput(pieScenario), ctx('tool-pie'))
    expect(pie.publish!.record.spec.sliceColors).toHaveLength(4)
  })

  it('keeps null gaps intact', () => {
    const result = executeRenderChart(asCreateInput(nullGapScenario), ctx('tool-gaps'))
    expect(result.publish!.record.spec.datasets[0].data).toEqual([15, null, null, 22, 25, null])
  })
})

describe('the model-facing result', () => {
  it('confirms with the identity needed to update later, without echoing data', () => {
    const result = executeRenderChart(asCreateInput(multiLineScenario), ctx('tool-confirm'))
    expect(result.isError).toBe(false)
    const chartId = result.publish!.record.chartId
    expect(result.content).toContain(chartId)
    expect(result.content).toContain(multiLineScenario.title)
    expect(result.content).toContain('3 series')
    expect(result.content).toContain('6 points')
    // The dataset must NOT come back: it already sits in the call's input and
    // repeating it doubles the chart's cost in the model's context.
    expect(result.content).not.toContain('135')
    expect(result.content).not.toContain('[120')
  })

  it('reports the new revision after an update', () => {
    const created = executeRenderChart(asCreateInput(multiLineScenario), ctx('tool-u1'))
    const chartId = created.publish!.record.chartId
    const updated = executeRenderChart(
      asUpdateInput(multiLineScenario, chartId, multiLineScenario.title),
      ctx('tool-u2'),
    )
    expect(updated.isError).toBe(false)
    expect(updated.publish?.op).toBe('update')
    expect(updated.content).toContain('revision 2')
  })
})

describe('refusals', () => {
  it('refuses malformed input as a tool error with the parser message', () => {
    const result = executeRenderChart({ schemaVersion: 1, kind: 'line' }, ctx('tool-bad'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Chart rejected')
    expect(result.content).toContain('title is required')
    expect(result.publish).toBeUndefined()
  })

  it('refuses an unsupported field rather than dropping it', () => {
    const input = { ...asCreateInput(multiLineScenario), animation: 'ease' }
    const result = executeRenderChart(input, ctx('tool-strict'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('animation')
  })

  it('refuses a logarithmic axis with a zero value and says why', () => {
    const spec = cloneSpec(logarithmicScenario)
    spec.datasets[0].data = [0, 10, 100, 1000, 10000]
    const result = executeRenderChart(asCreateInput(spec), ctx('tool-log0'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('must be positive')
  })

  it('refuses a duplicate title and points at the update path', () => {
    executeRenderChart(asCreateInput(multiLineScenario), ctx('tool-dup1'))
    const result = executeRenderChart(asCreateInput(multiLineScenario), ctx('tool-dup2'))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('operation: "update"')
  })

  it('writes nothing when validation fails', () => {
    executeRenderChart({ schemaVersion: 1, kind: 'line' }, ctx('tool-nowrite'))
    expect(loadChartRecords(conversationId)).toHaveLength(0)
  })

  it('refuses when the conversation has no durable id', () => {
    const result = executeRenderChart(asCreateInput(multiLineScenario), {
      sessionKey: 'tab-1', conversationId: '', toolCallId: 'tool-noconv',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('no durable id')
  })
})
