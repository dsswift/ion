import { test } from 'node:test'
import assert from 'node:assert/strict'
import { percentile, summarize, mannWhitneyU, erfc, SAMPLE_KEEP_LIMIT } from '../lib/stats.mjs'

test('percentile interpolates linearly over sorted samples (type 7)', () => {
  const s = [1, 2, 3, 4, 5]
  assert.equal(percentile(s, 0.5), 3)
  assert.equal(percentile(s, 0), 1)
  assert.equal(percentile(s, 1), 5)
  assert.ok(Math.abs(percentile(s, 0.95) - 4.8) < 1e-12)
  assert.equal(percentile([7], 0.99), 7)
  assert.ok(Number.isNaN(percentile([], 0.5)))
})

test('summarize computes count, percentiles, max, mean from raw samples', () => {
  const s = summarize([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
  assert.equal(s.count, 10)
  assert.equal(s.p50, 55)
  assert.ok(Math.abs(s.p95 - 95.5) < 1e-9)
  assert.ok(Math.abs(s.p99 - 99.1) < 1e-9)
  assert.equal(s.max, 100)
  assert.equal(s.mean, 55)
  assert.deepEqual(s.samples, [10, 20, 30, 40, 50, 60, 70, 80, 90, 100])
})

test('summarize drops raw samples above the keep limit', () => {
  const big = Array.from({ length: SAMPLE_KEEP_LIMIT + 1 }, (_, i) => i)
  assert.equal(summarize(big).samples, undefined)
  assert.ok(Array.isArray(summarize(big.slice(0, SAMPLE_KEEP_LIMIT)).samples))
})

test('summarize of nothing is a zero count with NaN statistics', () => {
  const s = summarize([])
  assert.equal(s.count, 0)
  assert.ok(Number.isNaN(s.p50))
})

test('erfc matches tabulated values', () => {
  assert.ok(Math.abs(erfc(0) - 1) < 1e-7)
  assert.ok(Math.abs(erfc(1) - 0.1572992) < 1e-6)
  assert.ok(Math.abs(erfc(-1) - 1.8427008) < 1e-6)
})

test('Mann-Whitney U: fully separated samples', () => {
  // n1 = n2 = 5, U_a = 0, mu = 12.5, sigma = sqrt(5*5*11/12) = 4.787, z = -2.611, p = 0.0090
  const r = mannWhitneyU([1, 2, 3, 4, 5], [6, 7, 8, 9, 10])
  assert.equal(r.u, 0)
  assert.ok(Math.abs(r.z + 2.611) < 0.002, `z=${r.z}`)
  assert.ok(Math.abs(r.p - 0.00903) < 0.0005, `p=${r.p}`)
})

test('Mann-Whitney U: identical samples are not significant', () => {
  const r = mannWhitneyU([5, 5, 5, 5], [5, 5, 5, 5])
  assert.equal(r.u, 8)
  assert.equal(r.z, 0)
  assert.equal(r.p, 1)
})

test('Mann-Whitney U: tie correction against a textbook example', () => {
  // a = [3, 4, 2, 6, 2, 5], b = [9, 7, 5, 10, 6, 8]; pooled average ranks give R_a = 23, U_a = 23 - 21 = 2.
  // Four tie groups of two: variance 36/12 * (13 - 24/132) = 38.45, z = -2.58, p = 0.0099.
  const r = mannWhitneyU([3, 4, 2, 6, 2, 5], [9, 7, 5, 10, 6, 8])
  assert.equal(r.u, 2)
  assert.ok(Math.abs(r.z + 2.58) < 0.01, `z=${r.z}`)
  assert.ok(r.p < 0.05, `p=${r.p}`)
  assert.ok(r.p > 0.005, `p=${r.p}`)
})

test('Mann-Whitney U: an empty side yields NaN', () => {
  assert.ok(Number.isNaN(mannWhitneyU([], [1]).p))
})
