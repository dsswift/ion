import { describe, expect, it } from 'vitest'
import { degreeRanks, hubDegreeThreshold, labelEligibleCount, labelTier, quantizeLabelZoom, LANDMARK_COUNT, LOD_RATIO_THRESHOLD, MIN_HUB_DEGREE } from './graph-label-priority'

describe('hubDegreeThreshold', () => {
  it('nothing qualifies in an empty corpus', () => {
    expect(hubDegreeThreshold([])).toBe(Infinity)
  })

  it('a corpus of leaves has no hubs', () => {
    const degrees = Array.from({ length: 200 }, () => 1)
    expect(hubDegreeThreshold(degrees)).toBe(MIN_HUB_DEGREE)
    expect(labelTier(1, hubDegreeThreshold(degrees))).toBe('normal')
  })

  it('the top of a skewed corpus is a hub and the bulk is not', () => {
    const degrees = [...Array.from({ length: 190 }, (_, i) => 1 + (i % 3)), 40, 55, 60, 70, 80, 90, 100, 120, 150, 200]
    const threshold = hubDegreeThreshold(degrees)
    expect(labelTier(200, threshold)).toBe('hub')
    expect(labelTier(150, threshold)).toBe('hub')
    expect(labelTier(3, threshold)).toBe('normal')
  })

  it('hubs are a bounded share of the corpus, not a bare percentile', () => {
    // Degrees 1..200 with no ties: the 95th percentile alone would name ten
    // hubs; the share cap trims that to a few percent.
    const degrees = Array.from({ length: 200 }, (_, i) => i + 1)
    const threshold = hubDegreeThreshold(degrees)
    const hubs = degrees.filter((d) => labelTier(d, threshold) === 'hub')
    expect(hubs.length).toBeLessThanOrEqual(Math.ceil(degrees.length * 0.03) + 1)
    expect(hubs.length).toBeGreaterThan(0)
  })
})

describe('labelEligibleCount', () => {
  it('every node is a candidate at zoom 1 and closer', () => {
    expect(labelEligibleCount(2000, 1)).toBe(2000)
    expect(labelEligibleCount(2000, 0.2)).toBe(2000)
  })

  it('thins with the square of the ratio between zoom 1 and the overview threshold, never below the landmarks', () => {
    expect(labelEligibleCount(2000, 2)).toBe(500)
    expect(labelEligibleCount(40, 2)).toBe(LANDMARK_COUNT)
  })

  it('past the overview threshold only landmarks remain, fewer the further out, never none', () => {
    expect(labelEligibleCount(2000, LOD_RATIO_THRESHOLD + 0.01)).toBeLessThanOrEqual(LANDMARK_COUNT)
    expect(labelEligibleCount(2000, 5)).toBe(3)
    expect(labelEligibleCount(2000, 16)).toBe(1)
    expect(labelEligibleCount(0, 16)).toBe(0)
  })
})

describe('quantizeLabelZoom', () => {
  it('snaps to half-octave steps', () => {
    expect(quantizeLabelZoom(1)).toBe(1)
    expect(quantizeLabelZoom(1.1)).toBe(1)
    expect(quantizeLabelZoom(1.35)).toBeCloseTo(Math.SQRT2)
    expect(quantizeLabelZoom(3.9)).toBe(4)
  })
})

describe('degreeRanks', () => {
  it('ranks best-connected first with a stable tie-break', () => {
    const ranks = degreeRanks([{ id: 'b', degree: 3 }, { id: 'a', degree: 3 }, { id: 'c', degree: 9 }])
    expect(ranks.get('c')).toBe(0)
    expect(ranks.get('a')).toBe(1)
    expect(ranks.get('b')).toBe(2)
  })
})
