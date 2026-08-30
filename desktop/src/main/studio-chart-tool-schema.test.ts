import { describe, expect, it } from 'vitest'
import Ajv, { type ValidateFunction } from 'ajv'
import { RENDER_CHART_TOOL } from './studio-chart-tool'

/**
 * Schema-level pins for the `RenderChart` input contract.
 *
 * THE PROBLEM THESE EXIST FOR: four of the tool's fields are only valid in
 * specific combinations — `chartId`/`expectedTitle` require
 * `operation: "update"`, `sliceColors` requires a radial kind, a format's
 * `currency` requires `kind: "currency"`. The schema advertised them as plain
 * optional properties, so a caller that fills in every advertised field
 * produces `chartId: ""`, `sliceColors: []`, `currency: ""` — and the strict
 * parser refuses the call.
 *
 * No bad chart was ever stored (the parser is the real gate), but the caller
 * only learned after a failed round trip and had no structural signal about
 * which combinations are legal. In practice that meant repeated refusals for
 * the same reason.
 *
 * The schema now encodes the rules with `if`/`then`/`else`, so an invalid
 * SHAPE fails validation before the call is routed, and providers that
 * constrain generation from the schema will not emit it at all.
 *
 * ── Why validate here as well as in the parser ──────────────────────────────
 * The engine validates client-tool input against this exact schema with
 * `google/jsonschema-go` (`CompileClientToolInputValidator`). These tests use
 * ajv over the SAME schema object the tool declares, so a rule that regresses
 * in the declaration fails here rather than in a live conversation.
 */

const ajv = new Ajv({ strict: false, allErrors: true })
// `inputSchema` is optional on ClientToolDef; a chart tool with no schema
// would defeat the whole point of these tests, so assert it is present rather
// than silently validating against an empty schema that accepts everything.
const declaredSchema = RENDER_CHART_TOOL.inputSchema
if (!declaredSchema) throw new Error('RenderChart must declare an inputSchema')
const validate: ValidateFunction = ajv.compile(declaredSchema)

describe('RenderChart schema — provider compatibility', () => {
  it('keeps union combinators below the tool input schema root', () => {
    // Anthropic rejects the complete request before inference when one of
    // these keywords appears at the input_schema root. Nested combinators are
    // valid and still express the omission rules below.
    expect(declaredSchema).not.toHaveProperty('oneOf')
    expect(declaredSchema).not.toHaveProperty('allOf')
    expect(declaredSchema).not.toHaveProperty('anyOf')
  })
})

/** The minimum valid create payload — every test builds from this. */
function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'line',
    title: 'Series comparison',
    labels: ['A', 'B'],
    datasets: [{ label: 'Series A', data: [1, 2] }],
    ...overrides,
  }
}

function errorsFor(input: Record<string, unknown>): string {
  validate(input)
  return JSON.stringify(validate.errors ?? [])
}

describe('RenderChart schema — create', () => {
  it('accepts the minimal create payload', () => {
    expect(validate(base())).toBe(true)
  })

  it('accepts an explicit operation: create', () => {
    expect(validate(base({ operation: 'create' }))).toBe(true)
  })

  // The exact malformed payloads that caused repeated live refusals.
  it('rejects an empty chartId on a create', () => {
    expect(validate(base({ chartId: '' }))).toBe(false)
  })

  it('rejects an empty expectedTitle on a create', () => {
    expect(validate(base({ expectedTitle: '' }))).toBe(false)
  })

  it('rejects a populated chartId on a create', () => {
    // Identity is minted by the tool, so supplying one on a create is a
    // category error, not a hint.
    expect(validate(base({ chartId: 'tool-gate-123-1' }))).toBe(false)
  })

  it('rejects both identity fields sent empty alongside operation: create', () => {
    expect(validate(base({ operation: 'create', chartId: '', expectedTitle: '' }))).toBe(false)
  })
})

describe('RenderChart schema — update', () => {
  function update(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return base({
      operation: 'update',
      chartId: 'tool-gate-123-1',
      expectedTitle: 'Series comparison',
      ...overrides,
    })
  }

  it('accepts an update carrying both identity fields', () => {
    expect(validate(update())).toBe(true)
  })

  it('rejects an update missing expectedTitle', () => {
    const input = update()
    delete input.expectedTitle
    expect(validate(input)).toBe(false)
    expect(errorsFor(input)).toContain('expectedTitle')
  })

  it('rejects an update missing chartId', () => {
    const input = update()
    delete input.chartId
    expect(validate(input)).toBe(false)
    expect(errorsFor(input)).toContain('chartId')
  })

  it('rejects an update whose identity fields are empty strings', () => {
    expect(validate(update({ chartId: '', expectedTitle: '' }))).toBe(false)
  })
})

describe('RenderChart schema — kind-specific fields', () => {
  it('rejects sliceColors on a bar chart', () => {
    expect(validate(base({ kind: 'bar', sliceColors: ['#112233'] }))).toBe(false)
  })

  it('rejects an EMPTY sliceColors array on a line chart', () => {
    // The placeholder-empty-array shape, refused structurally.
    expect(validate(base({ sliceColors: [] }))).toBe(false)
  })

  it('accepts sliceColors on a doughnut chart', () => {
    expect(validate({
      schemaVersion: 1,
      kind: 'doughnut',
      title: 'Composition',
      labels: ['One', 'Two'],
      datasets: [{ label: 'Share', data: [60, 40] }],
      sliceColors: ['#112233', '#445566'],
    })).toBe(true)
  })

  it('rejects axes on a radial chart', () => {
    expect(validate({
      schemaVersion: 1,
      kind: 'pie',
      title: 'Composition',
      labels: ['One'],
      datasets: [{ label: 'Share', data: [100] }],
      leftAxis: { title: 'Amount' },
    })).toBe(false)
  })

  it('rejects reference lines and range bands on a radial chart', () => {
    for (const extra of [
      { referenceLines: [{ value: 10 }] },
      { rangeBands: [{ from: 1, to: 2 }] },
      { stacked: true },
      { categoryAxis: { title: 'x' } },
    ]) {
      expect(validate({
        schemaVersion: 1,
        kind: 'pie',
        title: 'Composition',
        labels: ['One'],
        datasets: [{ label: 'Share', data: [100] }],
        ...extra,
      })).toBe(false)
    }
  })

  it('accepts axes and annotations on a Cartesian chart', () => {
    expect(validate(base({
      leftAxis: { title: 'Units', format: { kind: 'decimal', decimals: 0 } },
      categoryAxis: { title: 'Period' },
      referenceLines: [{ value: 10, label: 'Target' }],
      rangeBands: [{ from: 1, to: 5, label: 'Expected' }],
      stacked: false,
    }))).toBe(true)
  })
})

describe('RenderChart schema — value format currency', () => {
  it('rejects an empty currency on a decimal axis', () => {
    expect(validate(base({
      leftAxis: { format: { kind: 'decimal', currency: '' } },
    }))).toBe(false)
  })

  it('rejects a currency code on a percent axis', () => {
    expect(validate(base({
      leftAxis: { format: { kind: 'percent', currency: 'USD' } },
    }))).toBe(false)
  })

  it('rejects a currency format with no code', () => {
    expect(validate(base({
      leftAxis: { format: { kind: 'currency' } },
    }))).toBe(false)
  })

  it('accepts a currency format with a valid ISO code', () => {
    expect(validate(base({
      leftAxis: { format: { kind: 'currency', currency: 'USD', decimals: 0 } },
    }))).toBe(true)
  })

  it('rejects a malformed currency code', () => {
    expect(validate(base({
      leftAxis: { format: { kind: 'currency', currency: 'usd' } },
    }))).toBe(false)
  })
})

describe('RenderChart schema — description states the omission rule', () => {
  it('tells the caller to omit unused fields rather than send placeholders', () => {
    // A caller reading only the description must learn the rule the
    // conditional branches enforce; otherwise the first failure is a refusal.
    const description = RENDER_CHART_TOOL.description
    expect(description).toContain('OMIT every field you are not using')
    expect(description).toMatch(/never send an empty string or an empty array/i)
  })
})
