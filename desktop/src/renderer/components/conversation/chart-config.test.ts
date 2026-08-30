/**
 * chart-config tests — the Ion spec → Chart.js mapping.
 *
 * The mapper is pure, so these assert the produced configuration exactly:
 * which type, which datasets, which scale each series binds to, what a
 * formatter returns, and where an annotation lands. A chart that "looks right"
 * but binds a series to the wrong axis is the failure this catches.
 */
import { describe, expect, it } from 'vitest'
import { darkColors } from '../../theme/palette-dark'
import {
  buildAnnotations,
  buildChartConfig,
  chartJsType,
  chartValueRows,
  defaultSeriesColors,
  seriesColor,
  sliceColors,
} from './chart-config'
import { cloneSpec } from '../../../shared/__tests__/chart-scenario-fixtures'
import {
  CHART_SCENARIOS,
  comparisonOverlayScenario,
  cumulativeScenario,
  doughnutScenario,
  groupedBarScenario,
  labelledContextScenario,
  logarithmicScenario,
  mixedDualAxisScenario,
  multiLineScenario,
  nullGapScenario,
  pieScenario,
  stackedBarScenario,
  themeColorScenario,
} from '../../../shared/__tests__/chart-scenario-fixtures'
import type { ChartSpec } from '../../../shared/chart-schema'

const colors = darkColors

function build(spec: ChartSpec) {
  return buildChartConfig({ spec, colors })
}

function datasets(spec: ChartSpec): Array<Record<string, unknown>> {
  return build(spec).data.datasets as Array<Record<string, unknown>>
}

function scales(spec: ChartSpec): Record<string, Record<string, unknown>> {
  return (build(spec).options.scales ?? {}) as Record<string, Record<string, unknown>>
}

function plugins(spec: ChartSpec): Record<string, Record<string, unknown>> {
  return build(spec).options.plugins as Record<string, Record<string, unknown>>
}

describe('every scenario produces a renderable configuration', () => {
  for (const scenario of CHART_SCENARIOS) {
    it(`${scenario.id} maps without gaps`, () => {
      const config = build(scenario.spec)
      expect(['line', 'bar', 'pie', 'doughnut']).toContain(config.type)
      expect((config.data.labels as string[]).length).toBe(scenario.spec.labels.length)
      expect((config.data.datasets as unknown[]).length).toBeGreaterThan(0)
      expect(config.options.animation).toBe(false)
    })
  }
})

describe('chart type resolution', () => {
  it('maps area to a line chart, since area is a fill not a type', () => {
    expect(chartJsType(cumulativeScenario)).toBe('line')
    expect(datasets(cumulativeScenario)[0].fill).toBe(true)
  })

  it('maps the remaining kinds directly', () => {
    expect(chartJsType(multiLineScenario)).toBe('line')
    expect(chartJsType(groupedBarScenario)).toBe('bar')
    expect(chartJsType(pieScenario)).toBe('pie')
    expect(chartJsType(doughnutScenario)).toBe('doughnut')
  })
})

describe('multiple series on one chart', () => {
  it('emits one Chart.js dataset per Ion dataset, in order', () => {
    const built = datasets(multiLineScenario)
    expect(built).toHaveLength(3)
    expect(built.map((d) => d.label)).toEqual(['Series A', 'Series B', 'Series C'])
  })

  it('uses each series explicit color for its line', () => {
    const built = datasets(multiLineScenario)
    expect(built.map((d) => d.borderColor)).toEqual(['#3366ff', '#ff8833', '#22aa77'])
  })

  it('assigns distinct theme colors when none are supplied', () => {
    // Three uncolored series must not all render in one color, or the chart is
    // unreadable without the model having to pick colors.
    const built = datasets(themeColorScenario)
    const assigned = built.map((d) => d.borderColor)
    expect(new Set(assigned).size).toBe(3)
    expect(assigned[0]).toBe(colors.accent)
  })

  it('resolves colors through the shared helpers', () => {
    const palette = defaultSeriesColors(colors)
    expect(seriesColor(multiLineScenario, 0, palette)).toBe('#3366ff')
    expect(seriesColor(themeColorScenario, 1, palette)).toBe(palette[1])
    // Palette assignment wraps rather than running out of colors.
    expect(seriesColor(themeColorScenario, palette.length, palette)).toBe(palette[0])
  })

  it('passes the exact resolved values through to the canvas', () => {
    expect(datasets(multiLineScenario)[0].data).toEqual([120, 135, 128, 150, 162, 158])
  })
})

describe('mixed series and dual axes', () => {
  it('binds each series to the scale its axis names', () => {
    const built = datasets(mixedDualAxisScenario)
    expect(built[0]).toMatchObject({ type: 'bar', yAxisID: 'y' })
    expect(built[1]).toMatchObject({ type: 'line', yAxisID: 'y1' })
  })

  it('creates a right scale only when a series uses it', () => {
    expect(scales(mixedDualAxisScenario).y1).toBeDefined()
    expect(scales(mixedDualAxisScenario).y1.position).toBe('right')
    // A single-axis chart must not carry an empty second scale.
    expect(scales(multiLineScenario).y1).toBeUndefined()
  })

  it('draws grid lines from the left axis only', () => {
    const built = scales(mixedDualAxisScenario)
    expect((built.y.grid as Record<string, unknown>).drawOnChartArea).toBe(true)
    expect((built.y1.grid as Record<string, unknown>).drawOnChartArea).toBe(false)
  })

  it('carries axis titles onto both scales', () => {
    const built = scales(mixedDualAxisScenario)
    expect((built.y.title as Record<string, unknown>).text).toBe('Volume')
    expect((built.y1.title as Record<string, unknown>).text).toBe('Rate')
  })
})

describe('scales and bounds', () => {
  it('maps a logarithmic axis to the logarithmic scale type', () => {
    expect(scales(logarithmicScenario).y.type).toBe('logarithmic')
    expect(scales(multiLineScenario).y.type).toBe('linear')
  })

  it('applies explicit min and max', () => {
    const spec = cloneSpec(multiLineScenario)
    spec.leftAxis = { min: 50, max: 200 }
    expect(scales(spec).y).toMatchObject({ min: 50, max: 200 })
  })

  it('omits bounds that were not supplied', () => {
    expect(scales(multiLineScenario).y.min).toBeUndefined()
    expect(scales(multiLineScenario).y.max).toBeUndefined()
  })

  it('stacks the category axis and the axis that carries the stack', () => {
    const built = scales(stackedBarScenario)
    expect(built.x.stacked).toBe(true)
    expect(built.y.stacked).toBe(true)
    // Grouped bars are the default; stacking must be opt-in.
    expect(scales(groupedBarScenario).y.stacked).toBe(false)
  })

  /**
   * Stacking is a WITHIN-AXIS transform, so a value scale carrying one series
   * has no stack. Reading spec.stacked straight onto every scale reported
   * `stacked: true` for a lone right-axis rate line on a stacked bar chart — a
   * stack of one, which says something untrue about that scale.
   */
  it('does not stack a value axis that carries a single series', () => {
    const spec = cloneSpec(mixedDualAxisScenario)
    spec.stacked = true
    const built = scales(spec)
    // Two bar series share the left scale in the fixture? No — the left axis
    // carries one bar and the right carries one line, so neither stacks.
    expect(built.y.stacked).toBe(false)
    expect(built.y1.stacked).toBe(false)
    // The category axis still groups the whole chart.
    expect(built.x.stacked).toBe(true)
  })

  it('stacks only the axis whose series are stacked', () => {
    // The reported shape: two stacked bars on the left, one rate line right.
    const spec = cloneSpec(stackedBarScenario)
    spec.datasets.push({
      label: 'Rate',
      data: spec.labels.map((_, index) => 10 + index),
      kind: 'line',
      axis: 'right',
    })
    spec.rightAxis = { title: 'Rate', format: { kind: 'percent', decimals: 1 } }
    const built = scales(spec)
    expect(built.y.stacked).toBe(true)
    expect(built.y1.stacked).toBe(false)
  })

  it('carries the category axis title', () => {
    expect((scales(multiLineScenario).x.title as Record<string, unknown>).text).toBe('Period')
  })

  /**
   * THE BUG THESE EXIST FOR: Chart.js decides `beginAtZero` CHART-wide, not per
   * scale. `BarController.overrides.scales._value_` sets it on every value
   * scale, so on the ordinary dual-scale shape — stacked bars left, a rate line
   * right — `y1` inherited it and was dragged down to 0. An 11.2%-14.2% series
   * was drawn inside a 0%-16% scale: squeezed into the top fifth, its real dip
   * flattened to almost nothing, and the chart understated the movement in its
   * own data. iOS resolved this per axis, so the two clients drew one spec
   * differently.
   */
  it('anchors a bar axis to zero', () => {
    // A bar's height is read against a zero baseline, so its scale keeps it.
    expect(scales(stackedBarScenario).y.beginAtZero).toBe(true)
    expect(scales(groupedBarScenario).y.beginAtZero).toBe(true)
  })

  it('does not anchor a line-only axis to zero', () => {
    // A line states a level rather than a magnitude; its scale ranges to data.
    expect(scales(multiLineScenario).y.beginAtZero).toBe(false)
  })

  it('leaves a rate line on the right axis free of the bar axis anchor', () => {
    // The reported chart: currency bars on the left, a percent line on the
    // right. The left scale must anchor and the right must not.
    const spec = cloneSpec(stackedBarScenario)
    spec.datasets.push({
      label: 'Rate',
      data: spec.labels.map((_, index) => 11.2 + index * 0.6),
      kind: 'line',
      axis: 'right',
    })
    spec.rightAxis = { title: 'Rate', format: { kind: 'percent', decimals: 1 } }
    const built = scales(spec)
    expect(built.y.beginAtZero).toBe(true)
    expect(built.y1.beginAtZero).toBe(false)
  })

  it('anchors a filled area axis to zero', () => {
    // A filled area's extent is read from a baseline, like a bar's height.
    const spec = cloneSpec(multiLineScenario)
    spec.kind = 'area'
    expect(scales(spec).y.beginAtZero).toBe(true)
  })

  it('never sets a zero anchor on a logarithmic axis', () => {
    // A logarithmic scale cannot contain zero, so the option is absent rather
    // than false — stating it either way would be a claim about a bound the
    // scale is incapable of having.
    expect(scales(logarithmicScenario).y.beginAtZero).toBeUndefined()
  })

  it('omits scales entirely for a radial chart', () => {
    expect(build(pieScenario).options.scales).toBeUndefined()
  })
})

describe('value formatting', () => {
  function tickFor(spec: ChartSpec, axis: 'y' | 'y1', value: number): string {
    const ticks = scales(spec)[axis].ticks as { callback: (v: unknown) => string }
    return ticks.callback(value)
  }

  it('formats currency ticks with the declared code', () => {
    const rendered = tickFor(groupedBarScenario, 'y', 1500)
    expect(rendered).toContain('1,500')
    expect(rendered).toMatch(/\$|USD/)
  })

  it('formats percent ticks as percentage points', () => {
    expect(tickFor(mixedDualAxisScenario, 'y1', 13.5)).toBe('13.5%')
  })

  it('formats decimal ticks at the declared precision', () => {
    expect(tickFor(labelledContextScenario, 'y', 12.5)).toBe('12.50')
  })

  it('formats a tooltip through the dataset own axis', () => {
    // A dual-axis chart must not format a rate as a volume; the callback picks
    // the format from the dataset's axis, not from the chart.
    const tooltip = plugins(mixedDualAxisScenario).tooltip as {
      callbacks: { label: (item: unknown) => string }
    }
    const volume = tooltip.callbacks.label({ datasetIndex: 0, dataset: { label: 'Volume' }, parsed: { y: 300 } })
    const rate = tooltip.callbacks.label({ datasetIndex: 1, dataset: { label: 'Rate' }, parsed: { y: 13.9 } })
    expect(volume).toBe('Volume: 300')
    expect(rate).toBe('Rate: 13.9%')
  })
})

describe('data labels', () => {
  it('prints values when the spec asks for them', () => {
    const datalabels = plugins(labelledContextScenario).datalabels as {
      display: boolean
      formatter: (v: unknown, c: { datasetIndex: number }) => string
    }
    expect(datalabels.display).toBe(true)
    expect(datalabels.formatter(12.25, { datasetIndex: 0 })).toBe('12.25')
  })

  it('is disabled by default so a dense chart stays readable', () => {
    expect((plugins(multiLineScenario).datalabels as { display: boolean }).display).toBe(false)
  })
})

describe('annotations', () => {
  it('emits a box for a range band and a line for a reference line', () => {
    const annotations = buildAnnotations(comparisonOverlayScenario, colors)
    expect(annotations['band-0']).toMatchObject({ type: 'box', yMin: 130, yMax: 170, yScaleID: 'y' })
    expect(annotations['line-0']).toMatchObject({ type: 'line', yMin: 150, yMax: 150, yScaleID: 'y' })
  })

  it('paints bands behind the data and lines in front', () => {
    // A band drawn over the series would hide the values it contextualises.
    const annotations = buildAnnotations(comparisonOverlayScenario, colors)
    expect((annotations['band-0'] as Record<string, unknown>).drawTime).toBe('beforeDatasetsDraw')
    expect((annotations['line-0'] as Record<string, unknown>).drawTime).toBe('afterDatasetsDraw')
  })

  it('writes the reference value into the label using the axis format', () => {
    const annotations = buildAnnotations(comparisonOverlayScenario, colors)
    const label = (annotations['line-0'] as { label: { content: string } }).label
    expect(label.content).toContain('Target')
    expect(label.content).toContain('150')
  })

  it('binds an annotation to the right scale when asked', () => {
    const spec = cloneSpec(mixedDualAxisScenario)
    spec.referenceLines = [{ value: 14, label: 'Rate target', axis: 'right' }]
    const annotations = buildAnnotations(spec, colors)
    expect((annotations['line-0'] as Record<string, unknown>).yScaleID).toBe('y1')
  })

  it('registers the annotation plugin only when annotations exist', () => {
    expect(plugins(comparisonOverlayScenario).annotation).toBeDefined()
    expect(plugins(multiLineScenario).annotation).toBeUndefined()
  })
})

describe('gaps and cumulative values', () => {
  it('never spans a gap, so a missing reading breaks the line', () => {
    expect(datasets(nullGapScenario)[0].spanGaps).toBe(false)
    expect(datasets(nullGapScenario)[0].data).toEqual([15, null, null, 22, 25, null])
  })

  it('draws the running total, not the raw values', () => {
    expect(datasets(cumulativeScenario)[0].data).toEqual([10, 30, null, 60, 100, 150])
  })
})

describe('radial charts', () => {
  it('uses one dataset with a color per slice', () => {
    const built = datasets(pieScenario)
    expect(built).toHaveLength(1)
    expect(built[0].backgroundColor).toEqual(['#3366ff', '#ff8833', '#22aa77', '#aa55cc'])
  })

  it('falls back to theme colors per slice', () => {
    const spec = cloneSpec(pieScenario)
    delete spec.sliceColors
    const palette = defaultSeriesColors(colors)
    expect(sliceColors(spec, palette)).toEqual(palette.slice(0, 4))
  })
})

describe('legend', () => {
  it('shows by default for several series and honours an explicit position', () => {
    const legend = plugins(multiLineScenario).legend as Record<string, unknown>
    expect(legend.display).toBe(true)
    expect(legend.position).toBe('bottom')
  })

  it('respects an explicit hide', () => {
    expect((plugins(cumulativeScenario).legend as Record<string, unknown>).display).toBe(false)
  })
})

describe('export background', () => {
  it('is absent on screen and present for a copy', () => {
    // On screen the card blends with the transcript; a pasted PNG needs an
    // opaque backing or it is unreadable on a white document.
    expect(plugins(multiLineScenario).ionExportBackground).toBeUndefined()
    const exported = buildChartConfig({ spec: multiLineScenario, colors, exportBackground: '#131316' })
    const exportPlugins = exported.options.plugins as Record<string, Record<string, unknown>>
    expect(exportPlugins.ionExportBackground.color).toBe('#131316')
  })
})

describe('exact-value table', () => {
  it('emits one row per label with one entry per series', () => {
    const rows = chartValueRows(multiLineScenario)
    expect(rows).toHaveLength(6)
    expect(rows[0].label).toBe('Jan')
    expect(rows[0].values.map((v) => v.series)).toEqual(['Series A', 'Series B', 'Series C'])
    expect(rows[0].values.map((v) => v.raw)).toEqual([120, 90, 40])
  })

  it('prints a gap as an em dash, never as zero', () => {
    const rows = chartValueRows(nullGapScenario)
    expect(rows[1].values[0]).toMatchObject({ raw: null, display: '—' })
  })

  it('shows cumulative rows as the running total', () => {
    const rows = chartValueRows(cumulativeScenario)
    expect(rows.map((r) => r.values[0].raw)).toEqual([10, 30, null, 60, 100, 150])
  })

  it('formats each series through its own axis', () => {
    const rows = chartValueRows(mixedDualAxisScenario)
    expect(rows[0].values[0].display).toBe('300')
    expect(rows[0].values[1].display).toBe('12.5%')
  })
})
