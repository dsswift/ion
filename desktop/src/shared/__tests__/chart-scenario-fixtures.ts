/**
 * Synthetic chart scenarios — the one fixture set every chart test reads.
 *
 * ── Why these are invented ──────────────────────────────────────────────────
 * Ion is an open-source product; its test suite must be publishable and must
 * not encode any operator's real data. Every number, label, and title here is
 * manufactured for coverage. Labels are deliberately generic ("Series A",
 * "Region 1") so no fixture reads as a real organization, program, or cost.
 *
 * ── Why one shared set ──────────────────────────────────────────────────────
 * The schema parser, the Chart.js mapper, the card, and the tool all validate
 * the same specs. Sharing fixtures makes a divergence impossible to hide: if
 * the mapper accepts something the parser rejects, one of these scenarios
 * fails rather than each layer testing its own private idea of a valid chart.
 */
import {
  CHART_SCHEMA_VERSION,
  type ChartSpec,
} from '../chart-schema'

export interface ChartScenario {
  /** Stable id used as a test name and a gallery key. */
  id: string
  /** What behaviour this scenario is here to prove. */
  purpose: string
  spec: ChartSpec
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun']

/** Three colored lines on one chart — the multi-series baseline. */
export const multiLineScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'line',
  title: 'Three-series line comparison',
  subtitle: 'Synthetic values for renderer coverage',
  labels: MONTHS,
  datasets: [
    { label: 'Series A', data: [120, 135, 128, 150, 162, 158], color: '#3366ff' },
    { label: 'Series B', data: [90, 96, 105, 99, 112, 121], color: '#ff8833' },
    { label: 'Series C', data: [40, 52, 61, 58, 70, 74], color: '#22aa77' },
  ],
  categoryAxis: { title: 'Period' },
  leftAxis: { title: 'Units', format: { kind: 'decimal', decimals: 0 } },
  legend: { visible: true, position: 'bottom' },
}

/** Two grouped bar series — the side-by-side comparison shape. */
export const groupedBarScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'bar',
  title: 'Two-series grouped bars',
  labels: MONTHS,
  datasets: [
    { label: 'Group One', data: [220, 240, 215, 260, 258, 275], color: '#5566dd' },
    { label: 'Group Two', data: [180, 165, 195, 205, 190, 210], color: '#dd6655' },
  ],
  leftAxis: { title: 'Amount', format: { kind: 'currency', currency: 'USD', decimals: 0 } },
  legend: { visible: true, position: 'top' },
}

/** Mixed bar + line across two axes — the dual-scale shape. */
export const mixedDualAxisScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'bar',
  title: 'Mixed bars and line on two axes',
  labels: MONTHS,
  datasets: [
    { label: 'Volume', data: [300, 320, 290, 355, 340, 380], kind: 'bar', axis: 'left', color: '#4477cc' },
    { label: 'Rate', data: [12.5, 13.1, 11.8, 14.2, 13.9, 15.4], kind: 'line', axis: 'right', color: '#cc4477' },
  ],
  leftAxis: { title: 'Volume', format: { kind: 'decimal', decimals: 0 } },
  rightAxis: { title: 'Rate', format: { kind: 'percent', decimals: 1 } },
  legend: { visible: true },
}

/** Period-over-period overlay with a target line and an expected band. */
export const comparisonOverlayScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'line',
  title: 'Period comparison with reference annotations',
  labels: MONTHS,
  datasets: [
    { label: 'Current period', data: [140, 152, 149, 168, 171, 165], color: '#3377ee' },
    { label: 'Prior period', data: [128, 131, 140, 145, 150, 148], color: '#8899aa', style: 'dashed' },
  ],
  leftAxis: { title: 'Amount', format: { kind: 'currency', currency: 'USD', decimals: 0 } },
  referenceLines: [{ value: 150, label: 'Target', color: '#22aa77', style: 'dashed' }],
  rangeBands: [{ from: 130, to: 170, label: 'Expected range', color: '#22aa77' }],
  legend: { visible: true },
  showValues: false,
}

/** Ion-derived running total, including a gap that must not reset the total. */
export const cumulativeScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'area',
  title: 'Cumulative total with a reporting gap',
  labels: MONTHS,
  datasets: [
    { label: 'Running total', data: [10, 20, null, 30, 40, 50], cumulative: true, fill: true, color: '#7755cc' },
  ],
  leftAxis: { title: 'Cumulative units', format: { kind: 'decimal', decimals: 0 } },
  legend: { visible: false },
}

/** Stacked bars — the composition shape. */
export const stackedBarScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'bar',
  title: 'Stacked composition',
  labels: ['Q1', 'Q2', 'Q3', 'Q4'],
  datasets: [
    { label: 'Component A', data: [50, 60, 55, 70], color: '#3366ff' },
    { label: 'Component B', data: [30, 25, 35, 40], color: '#ff8833' },
    { label: 'Component C', data: [20, 22, 18, 26], color: '#22aa77' },
  ],
  stacked: true,
  leftAxis: { format: { kind: 'decimal', decimals: 0 } },
  legend: { visible: true },
}

/** Pie with explicit slice colors. */
export const pieScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'pie',
  title: 'Share by category',
  labels: ['Region 1', 'Region 2', 'Region 3', 'Region 4'],
  datasets: [{ label: 'Share', data: [40, 25, 20, 15] }],
  sliceColors: ['#3366ff', '#ff8833', '#22aa77', '#aa55cc'],
  legend: { visible: true, position: 'right' },
  showValues: true,
}

/** Doughnut variant — same radial path, different cutout. */
export const doughnutScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'doughnut',
  title: 'Distribution ring',
  labels: ['Bucket A', 'Bucket B', 'Bucket C'],
  datasets: [{ label: 'Distribution', data: [55, 30, 15] }],
  sliceColors: ['#4488dd', '#dd8844', '#44bb88'],
  legend: { visible: true, position: 'bottom' },
}

/** Logarithmic axis over several orders of magnitude. */
export const logarithmicScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'line',
  title: 'Logarithmic growth',
  labels: ['T1', 'T2', 'T3', 'T4', 'T5'],
  datasets: [{ label: 'Magnitude', data: [1, 12, 140, 1600, 18000], color: '#3366ff' }],
  leftAxis: { title: 'Magnitude', scale: 'logarithmic', format: { kind: 'decimal', decimals: 0 } },
  legend: { visible: false },
}

/** Explicit gaps — the honest-missing-value shape. */
export const nullGapScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'line',
  title: 'Series with missing readings',
  labels: MONTHS,
  datasets: [
    { label: 'Sparse series', data: [15, null, null, 22, 25, null], color: '#3366ff' },
  ],
  leftAxis: { format: { kind: 'decimal', decimals: 0 } },
  legend: { visible: false },
}

/** Printed value labels plus caption/source context fields. */
export const labelledContextScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'bar',
  title: 'Values printed on the chart',
  subtitle: 'Every bar carries its exact number',
  caption: 'Synthetic figures produced for a rendering test.',
  source: 'Generated fixture data',
  labels: ['Alpha', 'Beta', 'Gamma'],
  datasets: [{ label: 'Measured', data: [12.25, 8.5, 15.75], color: '#3366ff' }],
  leftAxis: { format: { kind: 'decimal', decimals: 2 } },
  showValues: true,
  legend: { visible: false },
}

/** Theme-assigned colors — no explicit color anywhere. */
export const themeColorScenario: ChartSpec = {
  schemaVersion: CHART_SCHEMA_VERSION,
  kind: 'line',
  title: 'Theme-assigned series colors',
  labels: ['P1', 'P2', 'P3', 'P4'],
  datasets: [
    { label: 'First', data: [5, 8, 6, 9] },
    { label: 'Second', data: [3, 4, 7, 6] },
    { label: 'Third', data: [8, 6, 5, 7] },
  ],
  legend: { visible: true },
}

/** Every scenario, in gallery/test order. */
export const CHART_SCENARIOS: ChartScenario[] = [
  { id: 'multi-line', purpose: 'three colored series on one chart', spec: multiLineScenario },
  { id: 'grouped-bar', purpose: 'side-by-side grouped bars with currency format', spec: groupedBarScenario },
  { id: 'mixed-dual-axis', purpose: 'mixed bar/line across left and right axes', spec: mixedDualAxisScenario },
  { id: 'comparison-overlay', purpose: 'overlay with a reference line and shaded band', spec: comparisonOverlayScenario },
  { id: 'cumulative', purpose: 'Ion-derived running total across a gap', spec: cumulativeScenario },
  { id: 'stacked-bar', purpose: 'stacked composition', spec: stackedBarScenario },
  { id: 'pie', purpose: 'pie with explicit slice colors', spec: pieScenario },
  { id: 'doughnut', purpose: 'doughnut variant', spec: doughnutScenario },
  { id: 'logarithmic', purpose: 'logarithmic value axis', spec: logarithmicScenario },
  { id: 'null-gap', purpose: 'explicit missing readings', spec: nullGapScenario },
  { id: 'labelled-context', purpose: 'printed values with caption and source', spec: labelledContextScenario },
  { id: 'theme-colors', purpose: 'series colors assigned from the theme', spec: themeColorScenario },
]

/** Clone a scenario so a test can mutate it without affecting its siblings. */
export function cloneSpec(spec: ChartSpec): ChartSpec {
  return JSON.parse(JSON.stringify(spec)) as ChartSpec
}

/** A spec as raw tool input (create). */
export function asCreateInput(spec: ChartSpec): Record<string, unknown> {
  return cloneSpec(spec) as unknown as Record<string, unknown>
}

/** A spec as raw tool input (update against an existing chart). */
export function asUpdateInput(
  spec: ChartSpec,
  chartId: string,
  expectedTitle: string,
): Record<string, unknown> {
  return { operation: 'update', chartId, expectedTitle, ...cloneSpec(spec) } as unknown as Record<string, unknown>
}
