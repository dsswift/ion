/**
 * Scale construction: turn a binding plus the current model's values into a
 * value-to-appearance function. Every scale kind resolves every possible
 * input to *some* appearance — there is no code path that returns
 * `undefined`, which is what makes "a missing value renders as a distinct
 * unknown" true by construction rather than by convention.
 */

import type { ColorPalette } from '../../../theme-tokens'
import { categoricalColorPalette } from './categorical-palette'
import { toValueList } from '../../../../shared/graph-model-resolve'
import type { ChannelBinding, ChannelValueType } from '../../../../shared/graph-view-types'

export type ChannelKind = 'color' | 'shape' | 'size' | 'thickness' | 'opacity'

export interface Scale {
  apply(value: unknown): string | number
  domain: string[] | [number, number] | null
  /** For a categorical scale, how many values carried each domain entry, aligned with `domain`. Absent on other scale kinds. */
  counts?: number[]
  unknownCount: number
  /** Human-readable legend lines, built once at scale construction. */
  legend: string[]
}

const MIN_NODE_SIZE = 3
const MAX_NODE_SIZE = 15
const MIN_EDGE_SIZE = 0.4
const MAX_EDGE_SIZE = 2
/** Opacity channel range. Exported so the reducer test can pin the unknown treatment without a magic number. */
export const MIN_EDGE_OPACITY = 0.15
export const MAX_EDGE_OPACITY = 1

/** Every node `type` the shape channel can assign. Exported so tests can pin that each one has a registered Sigma node program (see GraphCanvas.tsx's `NODE_PROGRAM_CLASSES`). */
export const CATEGORICAL_SHAPE_CYCLE = ['circle', 'square', 'border', 'point'] as const

function unknownFor(kind: ChannelKind, colors: ColorPalette): string | number {
  switch (kind) {
    case 'color':
      return colors.graphUnknown
    case 'shape':
      return 'point'
    case 'size':
      return MIN_NODE_SIZE
    case 'thickness':
      return MIN_EDGE_SIZE
    case 'opacity':
      return MIN_EDGE_OPACITY
  }
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined || value === ''
}

/**
 * The two members of a boolean domain, in semantic order: the unmarked
 * state first.
 */
const BOOLEAN_DOMAIN = ['false', 'true']

/**
 * True when a domain is exactly the boolean pair. Such a domain is ordered
 * semantically rather than by frequency — see `buildCategoricalDomain`.
 */
function isBooleanDomain(domain: string[]): boolean {
  return domain.length === 2 && BOOLEAN_DOMAIN.every((v) => domain.includes(v))
}

function buildCategoricalDomain(values: unknown[]): { value: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const v of values) {
    // A list-valued field contributes each member to the domain. Keying on
    // the joined array would build a domain of co-occurrence combinations
    // instead of the corpus's real values, so two documents sharing a topic
    // would only share an appearance when their entire tag sets matched.
    for (const member of toValueList(v)) {
      counts.set(member, (counts.get(member) ?? 0) + 1)
    }
  }
  const ranked = [...counts.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count)
  // Frequency ranking answers "which value is most common", and for most
  // categorical dimensions that is the right question: no value of `type`
  // or `tags` is inherently the normal one, so the commonest earns the
  // neutral first slot and the rarer values earn the marked ones.
  //
  // A boolean dimension is different. `false` IS the unmarked state by
  // definition, whatever the counts say, so ranking it by frequency hands
  // the marked shape to whichever side happens to be smaller. On a corpus
  // that is mostly orphans that inverted the whole picture: the orphans
  // took the neutral circle and every connected document was drawn as the
  // exception. Order the boolean pair semantically instead.
  return isBooleanDomain(ranked.map((r) => r.value))
    ? BOOLEAN_DOMAIN.map((value) => ({ value, count: counts.get(value) ?? 0 }))
    : ranked
}

function buildCategoricalScale(kind: ChannelKind, values: unknown[], colors: ColorPalette): Scale {
  const ranked = buildCategoricalDomain(values)
  const domain = ranked.map((r) => r.value)
  let unknownCount = 0

  const colorCycle = categoricalColorPalette(colors)
  const indexOf = new Map(domain.map((v, i) => [v, i]))

  const legend: string[] = [`categorical (${domain.length} values)`]
  if (kind === 'shape' && domain.length > CATEGORICAL_SHAPE_CYCLE.length) {
    legend.push(`${domain.length - CATEGORICAL_SHAPE_CYCLE.length} further values shown as unknown`)
  }
  if (kind === 'color' && domain.length > colorCycle.length) {
    legend.push(`${domain.length - colorCycle.length} further values shown as unknown`)
  }

  return {
    domain,
    counts: ranked.map((r) => r.count),
    get unknownCount() {
      return unknownCount
    },
    legend,
    apply(value: unknown): string | number {
      // A list resolves to its first member: one node draws one colour, and
      // the domain already holds every member so the lookup always hits.
      const members = toValueList(value)
      if (members.length === 0) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      const idx = indexOf.get(members[0])
      if (idx === undefined) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      switch (kind) {
        case 'color':
          // Past the cycle a value draws as unknown rather than reusing a
          // hue: two values that look identical with no legend row saying
          // so is worse than a grey the legend counts.
          return idx < colorCycle.length ? colorCycle[idx] : (unknownFor(kind, colors) as string)
        case 'shape':
          return idx < CATEGORICAL_SHAPE_CYCLE.length ? CATEGORICAL_SHAPE_CYCLE[idx] : (unknownFor(kind, colors) as string)
        case 'size':
        case 'thickness':
        case 'opacity': {
          const [min, max] = kind === 'size' ? [MIN_NODE_SIZE, MAX_NODE_SIZE] : kind === 'thickness' ? [MIN_EDGE_SIZE, MAX_EDGE_SIZE] : [MIN_EDGE_OPACITY, MAX_EDGE_OPACITY]
          const steps = Math.max(1, domain.length - 1)
          return min + ((max - min) * idx) / steps
        }
      }
    },
  }
}

function toNumeric(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'string') {
    const n = Number(value)
    return n
  }
  return NaN
}

function interpolate(min: number, max: number, t: number): number {
  return min + (max - min) * t
}

function buildNumericScale(kind: ChannelKind, values: unknown[], colors: ColorPalette): Scale {
  const numbers = values.filter((v) => !isMissing(v)).map(toNumeric).filter((n) => Number.isFinite(n))
  const domainMin = numbers.length > 0 ? Math.min(...numbers) : 0
  const domainMax = numbers.length > 0 ? Math.max(...numbers) : 0
  const constant = domainMin === domainMax
  let unknownCount = 0

  return {
    domain: [domainMin, domainMax],
    get unknownCount() {
      return unknownCount
    },
    legend: constant ? [`numeric (constant ${domainMin})`] : [`numeric [${domainMin}, ${domainMax}]`],
    apply(value: unknown): string | number {
      if (isMissing(value)) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      const n = toNumeric(value)
      if (!Number.isFinite(n)) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      const t = constant ? 0.5 : (n - domainMin) / (domainMax - domainMin)
      switch (kind) {
        case 'color':
          // Two-stop theme gradient: default token to the graph accent.
          return t < 0.5 ? colors.graphNodeDefault : colors.graphSupersession
        case 'shape':
          return 'circle'
        case 'size':
          return interpolate(MIN_NODE_SIZE, MAX_NODE_SIZE, t)
        case 'thickness':
          return interpolate(MIN_EDGE_SIZE, MAX_EDGE_SIZE, t)
        case 'opacity':
          return interpolate(MIN_EDGE_OPACITY, MAX_EDGE_OPACITY, t)
      }
    },
  }
}

function toEpochMs(value: unknown): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Date.parse(value)
  return NaN
}

function buildTemporalScale(kind: ChannelKind, values: unknown[], colors: ColorPalette): Scale {
  const epochs = values.filter((v) => !isMissing(v)).map(toEpochMs).filter((n) => Number.isFinite(n))
  const domainMin = epochs.length > 0 ? Math.min(...epochs) : 0
  const domainMax = epochs.length > 0 ? Math.max(...epochs) : 0
  const constant = domainMin === domainMax
  let unknownCount = 0

  return {
    domain: [domainMin, domainMax],
    get unknownCount() {
      return unknownCount
    },
    legend: [constant ? 'temporal (constant)' : 'temporal (sequential)'],
    apply(value: unknown): string | number {
      if (isMissing(value)) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      const epoch = toEpochMs(value)
      if (!Number.isFinite(epoch)) {
        unknownCount++
        return unknownFor(kind, colors)
      }
      const t = constant ? 0.5 : (epoch - domainMin) / (domainMax - domainMin)
      switch (kind) {
        case 'color':
          return t < 0.5 ? colors.graphNodeDefault : colors.graphSupersession
        case 'shape':
          return 'circle'
        case 'size':
          return interpolate(MIN_NODE_SIZE, MAX_NODE_SIZE, t)
        case 'thickness':
          return interpolate(MIN_EDGE_SIZE, MAX_EDGE_SIZE, t)
        case 'opacity':
          return interpolate(MIN_EDGE_OPACITY, MAX_EDGE_OPACITY, t)
      }
    },
  }
}

/**
 * Build a scale for one channel from its resolved value type and the
 * current model's sample values. `unknownCount` on the returned scale
 * accumulates as `apply` is called — read it after a full render pass.
 */
export function buildScale(kind: ChannelKind, valueType: ChannelValueType, values: unknown[], colors: ColorPalette): Scale {
  switch (valueType) {
    case 'categorical':
      return buildCategoricalScale(kind, values, colors)
    case 'numeric':
      return buildNumericScale(kind, values, colors)
    case 'temporal':
      return buildTemporalScale(kind, values, colors)
  }
}

/** The channel's fixed appearance for an unbound dimension (`dimension: null`). */
export function unboundAppearance(kind: ChannelKind, colors: ColorPalette): string | number {
  return unknownFor(kind, colors)
}

export type { ChannelBinding }
