/**
 * Whole-spec semantic validation for the Chart Output contract.
 *
 * ── Why this is separate from the parser ────────────────────────────────────
 * `chart-parse.ts` answers "is each field well-formed?" one field at a time.
 * The checks here need the ASSEMBLED spec: whether a declared right axis is
 * actually used, whether a logarithmic axis can plot the values bound to it.
 * They cannot run until every field has been parsed, so they are a distinct
 * pass over a distinct input, and separating them keeps the parser a readable
 * list of per-field guards.
 *
 * `parseChartToolInput` remains the only public validation entry point — this
 * module is the final step inside it, never a second gate a caller has to
 * remember to run.
 */

import type {
  ChartAxisId,
  ChartSpec,
  ChartValueAxis,
} from './chart-schema'

/**
 * Cross-field checks that need the whole spec assembled.
 *
 * A logarithmic axis with a zero or negative value is the case that matters:
 * Chart.js silently drops such points, which would show the user a chart that
 * is missing data with no indication why. Rejecting at the tool boundary means
 * the model learns immediately and can pick a linear axis instead.
 *
 * Returns a model-facing message describing the first violation, or null when
 * the spec is coherent.
 */
export function validateAxisSemantics(spec: ChartSpec): string | null {
  const axisFor = (id: ChartAxisId | undefined): ChartValueAxis | undefined =>
    (id === 'right' ? spec.rightAxis : spec.leftAxis)

  const boundToRight = spec.datasets.some((dataset) => dataset.axis === 'right')
  if (spec.rightAxis && !boundToRight) {
    return 'rightAxis is declared but no dataset binds to it. Set axis: "right" on a dataset or remove rightAxis.'
  }

  for (const dataset of spec.datasets) {
    const axis = axisFor(dataset.axis)
    if (axis?.scale !== 'logarithmic') continue
    const label = dataset.axis === 'right' ? 'rightAxis' : 'leftAxis'
    for (let i = 0; i < dataset.data.length; i += 1) {
      const point = dataset.data[i]
      if (point === null) {
        return `datasets with a logarithmic ${label} cannot contain null: "${dataset.label}" has a gap at index ${i}. A logarithmic scale has no position for a missing value; use a linear axis instead.`
      }
      if (point <= 0) {
        return `datasets with a logarithmic ${label} must be positive: "${dataset.label}" has ${point} at index ${i}.`
      }
    }
  }

  for (const line of spec.referenceLines ?? []) {
    const axis = axisFor(line.axis)
    if (axis?.scale === 'logarithmic' && line.value <= 0) {
      return `referenceLines value ${line.value} must be positive on a logarithmic axis.`
    }
  }
  for (const band of spec.rangeBands ?? []) {
    const axis = axisFor(band.axis)
    if (axis?.scale === 'logarithmic' && band.from <= 0) {
      return `rangeBands from ${band.from} must be positive on a logarithmic axis.`
    }
  }

  return null
}
