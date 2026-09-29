/**
 * Chart schema tests — the parser is the gate every other layer trusts, so
 * these pin both halves of its contract: every supported shape is accepted,
 * and every malformed shape is refused with a message the model can act on.
 *
 * All data is synthetic (chart-scenario-fixtures.ts). Nothing here encodes a
 * real organisation, program, or figure.
 */
import { describe, expect, it } from 'vitest'
import {
  CHART_LIMITS,
  CHART_SCHEMA_VERSION,
  cumulativeSeries,
  datasetFormat,
  formatChartValue,
  isCartesianChart,
  isRadialChart,
  resolvedSeries,
  type ChartSpec,
} from '../chart-schema'
import { parseChartToolInput } from '../chart-parse'
import {
  CHART_SCENARIOS,
  asCreateInput,
  asUpdateInput,
  cloneSpec,
  multiLineScenario,
  cumulativeScenario,
  logarithmicScenario,
  pieScenario,
} from './chart-scenario-fixtures'

/** Parse a spec, failing the test with the parser's own message. */
function accept(spec: ChartSpec) {
  const result = parseChartToolInput(asCreateInput(spec))
  if (!result.ok) throw new Error(`expected accept, got: ${result.message}`)
  return result.request
}

/** Parse raw input expecting refusal, returning the message. */
function reject(input: unknown): string {
  const result = parseChartToolInput(input)
  if (result.ok) throw new Error('expected the parser to refuse this input')
  return result.message
}

describe('every synthetic scenario is valid', () => {
  for (const scenario of CHART_SCENARIOS) {
    it(`${scenario.id}: ${scenario.purpose}`, () => {
      const request = accept(scenario.spec)
      expect(request.operation).toBe('create')
      expect(request.spec.title).toBe(scenario.spec.title)
      expect(request.spec.datasets).toHaveLength(scenario.spec.datasets.length)
      expect(request.spec.labels).toEqual(scenario.spec.labels)
    })
  }
})

describe('multi-series preservation', () => {
  it('keeps every series with its own explicit color and order', () => {
    const request = accept(multiLineScenario)
    expect(request.spec.datasets.map((d) => d.label)).toEqual(['Series A', 'Series B', 'Series C'])
    expect(request.spec.datasets.map((d) => d.color)).toEqual(['#3366ff', '#ff8833', '#22aa77'])
  })

  it('preserves exact supplied values without rounding or coercion', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[0].data = [1234.5678, -0.25, 0, 999999, 0.001, 42]
    const request = accept(spec)
    expect(request.spec.datasets[0].data).toEqual([1234.5678, -0.25, 0, 999999, 0.001, 42])
  })

  it('refuses duplicate series labels', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[1].label = 'Series A'
    expect(reject(asCreateInput(spec))).toContain('duplicates an earlier series')
  })
})

describe('envelope and operation', () => {
  it('defaults to create when operation is omitted', () => {
    expect(accept(multiLineScenario).operation).toBe('create')
  })

  it('accepts an update carrying id and expected title', () => {
    const result = parseChartToolInput(asUpdateInput(multiLineScenario, 'chart-1', 'Three-series line comparison'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.operation).toBe('update')
    if (result.request.operation !== 'update') return
    expect(result.request.chartId).toBe('chart-1')
    expect(result.request.expectedTitle).toBe('Three-series line comparison')
  })

  it('refuses an update with no chartId', () => {
    const input = { ...asCreateInput(multiLineScenario), operation: 'update', expectedTitle: 'x' }
    expect(reject(input)).toContain('chartId is required')
  })

  it('refuses an update with no expectedTitle', () => {
    // Without the title confirmation a hallucinated id would silently
    // overwrite an unrelated chart.
    const input = { ...asCreateInput(multiLineScenario), operation: 'update', chartId: 'chart-1' }
    expect(reject(input)).toContain('expectedTitle is required')
  })

  it('refuses chartId on a create', () => {
    const input = { ...asCreateInput(multiLineScenario), chartId: 'chart-1' }
    expect(reject(input)).toContain('only valid when operation is "update"')
  })

  it('refuses a wrong schema version', () => {
    const input = { ...asCreateInput(multiLineScenario), schemaVersion: 2 }
    expect(reject(input)).toContain(`schemaVersion must be ${CHART_SCHEMA_VERSION}`)
  })
})

describe('strictness', () => {
  it('refuses unknown top-level fields instead of ignoring them', () => {
    // A silently-dropped field is the worst outcome: the model believes it
    // asked for something the user never sees.
    const input = { ...asCreateInput(multiLineScenario), animate: true }
    expect(reject(input)).toContain('unsupported field(s): animate')
  })

  it('refuses unknown dataset fields', () => {
    const input = asCreateInput(multiLineScenario) as Record<string, unknown>
    ;(input.datasets as Array<Record<string, unknown>>)[0].borderWidth = 4
    expect(reject(input)).toContain('unsupported field(s): borderWidth')
  })

  it('refuses unknown axis fields', () => {
    const input = asCreateInput(multiLineScenario) as Record<string, unknown>
    input.leftAxis = { title: 'Units', beginAtZero: true }
    expect(reject(input)).toContain('unsupported field(s): beginAtZero')
  })

  it('refuses a non-object input', () => {
    expect(reject('a line chart of costs')).toContain('must be a JSON object')
  })
})

describe('structural limits', () => {
  it('refuses more datasets than the cap', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets = Array.from({ length: CHART_LIMITS.maxDatasets + 1 }, (_, i) => ({
      label: `Series ${i}`,
      data: spec.labels.map(() => 1),
    }))
    expect(reject(asCreateInput(spec))).toContain(`at most ${CHART_LIMITS.maxDatasets} series`)
  })

  it('refuses more points than the cap', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.labels = Array.from({ length: CHART_LIMITS.maxPoints + 1 }, (_, i) => `L${i}`)
    spec.datasets = [{ label: 'Series A', data: spec.labels.map(() => 1) }]
    expect(reject(asCreateInput(spec))).toContain(`at most ${CHART_LIMITS.maxPoints} categories`)
  })

  it('refuses a dataset whose length does not match labels', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[0].data = [1, 2, 3]
    expect(reject(asCreateInput(spec))).toContain('must align with labels')
  })

  it('refuses empty labels and empty datasets', () => {
    const noLabels = cloneSpec(multiLineScenario)
    noLabels.labels = []
    expect(reject(asCreateInput(noLabels))).toContain('at least one category')

    const noData = cloneSpec(multiLineScenario)
    noData.datasets = []
    expect(reject(asCreateInput(noData))).toContain('at least one series')
  })

  it('refuses a non-finite value', () => {
    const input = asCreateInput(multiLineScenario) as Record<string, unknown>
    ;(input.datasets as Array<Record<string, unknown>>)[0].data = ['12', 1, 1, 1, 1, 1]
    expect(reject(input)).toContain('must be a finite number or null')
  })

  it('refuses an over-long title', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.title = 'x'.repeat(CHART_LIMITS.maxTitleChars + 1)
    expect(reject(asCreateInput(spec))).toContain(`at most ${CHART_LIMITS.maxTitleChars} characters`)
  })
})

describe('colors', () => {
  it('refuses a non-hex series color', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.datasets[0].color = 'red'
    expect(reject(asCreateInput(spec))).toContain('"#RRGGBB"')
  })

  it('refuses slice colors that do not match the label count', () => {
    const spec = cloneSpec(pieScenario)
    spec.sliceColors = ['#112233']
    expect(reject(asCreateInput(spec))).toContain('one color per slice')
  })

  it('refuses sliceColors on a Cartesian chart', () => {
    const spec = cloneSpec(multiLineScenario)
    ;(spec as ChartSpec).sliceColors = ['#112233']
    expect(reject(asCreateInput(spec))).toContain('only valid on pie or doughnut')
  })
})

describe('axis semantics', () => {
  it('refuses a declared rightAxis no dataset uses', () => {
    // An orphan axis renders an empty scale the user cannot explain.
    const spec = cloneSpec(multiLineScenario)
    spec.rightAxis = { title: 'Unused' }
    expect(reject(asCreateInput(spec))).toContain('no dataset binds to it')
  })

  it('refuses a non-positive value on a logarithmic axis', () => {
    const spec = cloneSpec(logarithmicScenario)
    spec.datasets[0].data = [1, 0, 10, 100, 1000]
    expect(reject(asCreateInput(spec))).toContain('must be positive')
  })

  it('refuses a null on a logarithmic axis, naming the gap index', () => {
    const spec = cloneSpec(logarithmicScenario)
    spec.datasets[0].data = [1, null, 10, 100, 1000]
    const message = reject(asCreateInput(spec))
    expect(message).toContain('cannot contain null')
    expect(message).toContain('index 1')
  })

  it('refuses min >= max', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.leftAxis = { min: 100, max: 100 }
    expect(reject(asCreateInput(spec))).toContain('must be less than')
  })

  it('refuses axes on a radial chart', () => {
    const spec = cloneSpec(pieScenario)
    ;(spec as ChartSpec).leftAxis = { title: 'Nope' }
    expect(reject(asCreateInput(spec))).toContain('axes are only valid')
  })
})

describe('value formats', () => {
  it('requires a currency code for currency format', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.leftAxis = { format: { kind: 'currency' } }
    expect(reject(asCreateInput(spec))).toContain('ISO 4217')
  })

  it('refuses a currency code on a non-currency format', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.leftAxis = { format: { kind: 'decimal', currency: 'USD' } }
    expect(reject(asCreateInput(spec))).toContain('only valid when kind is "currency"')
  })

  it('refuses decimals outside 0-6', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.leftAxis = { format: { kind: 'decimal', decimals: 7 } }
    expect(reject(asCreateInput(spec))).toContain(`0 to ${CHART_LIMITS.maxDecimals}`)
  })

  it('formats decimal, percent, and currency distinctly', () => {
    expect(formatChartValue(1234.5, { kind: 'decimal', decimals: 1 })).toContain('1,234.5')
    // A percent value is supplied in percentage points, so 12.5 reads 12.5%.
    expect(formatChartValue(12.5, { kind: 'percent', decimals: 1 })).toBe('12.5%')
    const currency = formatChartValue(1500, { kind: 'currency', currency: 'USD', decimals: 0 })
    expect(currency).toContain('1,500')
    expect(currency).toMatch(/\$|USD/)
  })

  it('resolves a dataset format through the axis it binds to', () => {
    const spec = accept(CHART_SCENARIOS.find((s) => s.id === 'mixed-dual-axis')!.spec).spec
    expect(datasetFormat(spec, spec.datasets[0])?.kind).toBe('decimal')
    expect(datasetFormat(spec, spec.datasets[1])?.kind).toBe('percent')
  })
})

describe('annotations', () => {
  it('accepts reference lines and range bands on a Cartesian chart', () => {
    const spec = accept(CHART_SCENARIOS.find((s) => s.id === 'comparison-overlay')!.spec).spec
    expect(spec.referenceLines?.[0]).toMatchObject({ value: 150, label: 'Target', style: 'dashed' })
    expect(spec.rangeBands?.[0]).toMatchObject({ from: 130, to: 170, label: 'Expected range' })
  })

  it('refuses a band whose from is not below its to', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.rangeBands = [{ from: 200, to: 100 }]
    expect(reject(asCreateInput(spec))).toContain('must be less than')
  })

  it('refuses annotations on a radial chart', () => {
    const spec = cloneSpec(pieScenario)
    ;(spec as ChartSpec).referenceLines = [{ value: 10 }]
    expect(reject(asCreateInput(spec))).toContain('only valid on line, area, or bar')
  })
})

describe('cumulative transform', () => {
  it('accumulates and treats null as a gap that preserves the running total', () => {
    // The gap must not reset the total and must not invent a value: the next
    // real reading continues from where the series left off.
    expect(cumulativeSeries([10, 20, null, 30, 40, 50])).toEqual([10, 30, null, 60, 100, 150])
  })

  it('leaves a leading gap null rather than starting at zero', () => {
    expect(cumulativeSeries([null, 5, 5])).toEqual([null, 5, 10])
  })

  it('handles negative movements', () => {
    expect(cumulativeSeries([10, -4, 2])).toEqual([10, 6, 8])
  })

  it('is applied by resolvedSeries only when the dataset opts in', () => {
    const spec = accept(cumulativeScenario).spec
    expect(resolvedSeries(spec.datasets[0])).toEqual([10, 30, null, 60, 100, 150])
    const plain = accept(multiLineScenario).spec
    expect(resolvedSeries(plain.datasets[0])).toEqual(plain.datasets[0].data)
  })
})

describe('kind predicates', () => {
  it('classifies Cartesian and radial kinds', () => {
    expect(isCartesianChart('line')).toBe(true)
    expect(isCartesianChart('area')).toBe(true)
    expect(isCartesianChart('bar')).toBe(true)
    expect(isRadialChart('pie')).toBe(true)
    expect(isRadialChart('doughnut')).toBe(true)
    expect(isCartesianChart('pie')).toBe(false)
  })

  it('refuses several datasets on a radial chart', () => {
    const spec = cloneSpec(pieScenario)
    spec.datasets = [
      { label: 'A', data: [1, 1, 1, 1] },
      { label: 'B', data: [1, 1, 1, 1] },
    ]
    expect(reject(asCreateInput(spec))).toContain('takes exactly one dataset')
  })

  it('refuses a per-series kind override on a radial chart', () => {
    const spec = cloneSpec(pieScenario)
    spec.datasets[0].kind = 'bar'
    expect(reject(asCreateInput(spec))).toContain('only valid on line, area, or bar')
  })
})
