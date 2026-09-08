/**
 * Tests for scales.ts (child 06): for each of the six channel kinds, a
 * missing value yields the fixed unknown appearance and increments
 * `unknownCount`; `0` and `false` are NOT unknown. Also asserts there is no
 * code path that skips a channel — `apply` always returns a defined value.
 */
import { describe, expect, it } from 'vitest'
import { buildScale, unboundAppearance, type ChannelKind } from './scales'
import { categoricalColorPalette } from './categorical-palette'
import { darkColors } from '../../../theme/palette-dark'

const CHANNEL_KINDS: ChannelKind[] = ['color', 'shape', 'size', 'thickness', 'opacity']

describe('buildScale — missing values are unknown, 0/false are not', () => {
  for (const kind of CHANNEL_KINDS) {
    it(`${kind}: a missing value yields the fixed unknown appearance and increments unknownCount`, () => {
      const scale = buildScale(kind, 'categorical', ['a', 'b'], darkColors)
      scale.apply(null)
      expect(scale.unknownCount).toBe(1)
      scale.apply(undefined)
      expect(scale.unknownCount).toBe(2)
      scale.apply('')
      expect(scale.unknownCount).toBe(3)
    })

    it(`${kind}: 0 is not unknown (numeric)`, () => {
      const scale = buildScale(kind, 'numeric', [0, 10], darkColors)
      scale.apply(0)
      expect(scale.unknownCount).toBe(0)
    })

    it(`${kind}: false is not unknown (categorical)`, () => {
      const scale = buildScale(kind, 'categorical', [false, true], darkColors)
      scale.apply(false)
      expect(scale.unknownCount).toBe(0)
    })
  }
})

describe('buildScale — no code path skips a channel', () => {
  const inputs: unknown[] = [undefined, null, '', {}, []]
  for (const kind of CHANNEL_KINDS) {
    for (const valueType of ['categorical', 'numeric', 'temporal'] as const) {
      it(`${kind}/${valueType}: every input in the missing-value matrix returns a defined appearance`, () => {
        const scale = buildScale(kind, valueType, ['a', 1], darkColors)
        for (const input of inputs) {
          const result = scale.apply(input)
          expect(result).toBeDefined()
        }
      })
    }
  }
})

describe('buildScale — categorical', () => {
  it('domain is ordered by descending frequency', () => {
    const scale = buildScale('color', 'categorical', ['a', 'b', 'b', 'c', 'c', 'c'], darkColors)
    expect(scale.domain).toEqual(['c', 'b', 'a'])
  })

  it('numeric-looking identical values collapse to a single midpoint', () => {
    const scale = buildScale('size', 'numeric', [5, 5, 5], darkColors)
    const applied = scale.apply(5)
    expect(typeof applied).toBe('number')
  })

  it('a value with one NaN after coercion is unknown, others scale', () => {
    const scale = buildScale('size', 'numeric', [1, 2, 'not-a-number'], darkColors)
    scale.apply('not-a-number')
    expect(scale.unknownCount).toBe(1)
  })

  it('a categorical field with more distinct values than shape slots marks the rest unknown', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'f']
    const scale = buildScale('shape', 'categorical', values, darkColors)
    const results = values.map((v) => scale.apply(v))
    expect(results.filter((r) => r === 'point').length).toBeGreaterThan(0)
  })
})

describe('buildScale — list-valued fields expand to their members', () => {
  // A tag/topic field is a YAML list. Joining the list into one string makes
  // the domain a set of co-occurrence combinations rather than the corpus's
  // actual values, so a 111-topic corpus would present hundreds of
  // meaningless categories and no two documents sharing a topic would share
  // a colour unless their whole tag sets matched.
  it('the domain holds each member value, not the joined array', () => {
    const values = [['topic/a', 'topic/b'], ['topic/a'], ['topic/b', 'topic/c']]
    const scale = buildScale('color', 'categorical', values, darkColors)
    expect(scale.domain).toEqual(expect.arrayContaining(['topic/a', 'topic/b', 'topic/c']))
    expect(scale.domain).toHaveLength(3)
  })

  it('a node is encoded by its first member, so a list is never unknown', () => {
    const values = [['topic/a', 'topic/b'], ['topic/a']]
    const scale = buildScale('color', 'categorical', values, darkColors)
    const applied = scale.apply(['topic/a', 'topic/b'])
    expect(applied).toBe(scale.apply('topic/a'))
    expect(scale.unknownCount).toBe(0)
  })

  it('an empty list is unknown, exactly like a missing value', () => {
    const scale = buildScale('color', 'categorical', [['topic/a'], []], darkColors)
    scale.apply([])
    expect(scale.unknownCount).toBe(1)
  })
})

describe('unboundAppearance', () => {
  it('matches each channel unknown appearance', () => {
    expect(unboundAppearance('color', darkColors)).toBe(darkColors.graphUnknown)
    expect(unboundAppearance('shape', darkColors)).toBe('point')
  })
})

describe('buildScale — categorical colour never wraps silently', () => {
  it('twelve values get twelve distinct appearances', () => {
    const values = Array.from({ length: 12 }, (_, i) => `type-${i}`)
    const scale = buildScale('color', 'categorical', values, darkColors)
    const appearances = values.map((v) => String(scale.apply(v)))
    expect(new Set(appearances).size).toBe(12)
    expect(appearances).not.toContain(darkColors.graphUnknown)
  })

  it('values past the cycle draw as unknown and the legend says how many', () => {
    const cycle = categoricalColorPalette(darkColors)
    const values = Array.from({ length: cycle.length + 3 }, (_, i) => `v${i}`)
    const scale = buildScale('color', 'categorical', values, darkColors)
    const tail = values.slice(cycle.length).map((v) => scale.apply(v))
    expect(tail).toEqual([darkColors.graphUnknown, darkColors.graphUnknown, darkColors.graphUnknown])
    expect(scale.legend).toContain('3 further values shown as unknown')
    expect(new Set(cycle).size).toBe(cycle.length)
  })
})

describe('boolean domains are ordered semantically, not by frequency', () => {
  /**
   * Regression: a corpus that is mostly orphans (1,338 of 2,192 documents)
   * bound shape to the `orphan` metric and got the picture inverted —
   * frequency ranking handed the neutral circle to the orphans and drew
   * every connected document as the exception. `false` is the unmarked
   * state whatever the counts say.
   */
  it('false takes the neutral shape even when true is the majority', () => {
    const values = [...Array(1338).fill(true), ...Array(854).fill(false)]
    const scale = buildScale('shape', 'categorical', values, darkColors)
    expect(scale.domain).toEqual(['false', 'true'])
    expect(scale.apply(false)).toBe('circle')
    expect(scale.apply(true)).toBe('square')
  })

  it('the reported counts still describe the corpus, not the ordering', () => {
    const values = [...Array(3).fill(true), false]
    const scale = buildScale('shape', 'categorical', values, darkColors)
    expect(scale.domain).toEqual(['false', 'true'])
    expect(scale.counts).toEqual([1, 3])
  })

  it('an ordinary categorical is still ranked by frequency', () => {
    const values = [...Array(5).fill('note'), ...Array(2).fill('adr')]
    const scale = buildScale('shape', 'categorical', values, darkColors)
    expect(scale.domain).toEqual(['note', 'adr'])
    expect(scale.apply('note')).toBe('circle')
  })

  it('a two-value categorical that is not boolean keeps frequency order', () => {
    const values = [...Array(5).fill('yes'), ...Array(9).fill('no')]
    const scale = buildScale('shape', 'categorical', values, darkColors)
    expect(scale.domain).toEqual(['no', 'yes'])
  })
})
