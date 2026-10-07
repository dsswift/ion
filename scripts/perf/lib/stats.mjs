// @ts-check
/**
 * Latency statistics for the perf harness: percentiles and a summary from
 * RAW samples, and a two-sided Mann-Whitney U test (normal approximation
 * with tie correction) for the compare step. Plain ESM with JSDoc so
 * `node --test` runs it with no build step and no dependency.
 */

/**
 * Linear-interpolation percentile (Hyndman-Fan type 7, what R and NumPy
 * default to) over an ascending-sorted array. `q` is in [0, 1].
 * @param {readonly number[]} sorted ascending samples
 * @param {number} q quantile in [0, 1]
 * @returns {number}
 */
export function percentile(sorted, q) {
  const n = sorted.length
  if (n === 0) return NaN
  if (n === 1) return sorted[0]
  const pos = (n - 1) * Math.min(1, Math.max(0, q))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

/**
 * @typedef {object} SpanSummary
 * @property {number} count
 * @property {number} p50
 * @property {number} p95
 * @property {number} p99
 * @property {number} max
 * @property {number} mean
 * @property {number[]} [samples] raw samples, kept when count <= SAMPLE_KEEP_LIMIT
 */

/** Raw samples are stored in the result file up to this many per span. */
export const SAMPLE_KEEP_LIMIT = 2000

/**
 * Summary statistics from raw samples. Percentiles come from the samples
 * themselves, never from averaging other percentiles.
 * @param {readonly number[]} samples
 * @returns {SpanSummary}
 */
export function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const count = sorted.length
  if (count === 0) return { count: 0, p50: NaN, p95: NaN, p99: NaN, max: NaN, mean: NaN }
  let sum = 0
  for (const v of sorted) sum += v
  /** @type {SpanSummary} */
  const out = {
    count,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[count - 1],
    mean: sum / count,
  }
  if (count <= SAMPLE_KEEP_LIMIT) out.samples = sorted
  return out
}

/**
 * Average ranks over the pooled sample; ties share the mean of the ranks
 * they would occupy.
 * @param {readonly number[]} pooled
 * @returns {{ ranks: number[]; tieGroups: number[] }} ranks aligned with `pooled`, plus the size of each tie group (>1)
 */
function averageRanks(pooled) {
  const order = pooled.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const ranks = new Array(pooled.length).fill(0)
  /** @type {number[]} */
  const tieGroups = []
  let i = 0
  while (i < order.length) {
    let j = i
    while (j + 1 < order.length && order[j + 1].v === order[i].v) j++
    const rank = (i + j + 2) / 2 // 1-based ranks i+1 .. j+1, averaged
    for (let k = i; k <= j; k++) ranks[order[k].i] = rank
    if (j > i) tieGroups.push(j - i + 1)
    i = j + 1
  }
  return { ranks, tieGroups }
}

/**
 * Complementary error function, Abramowitz and Stegun 7.1.26 (absolute
 * error below 1.5e-7), enough for a p-value compared against 0.05.
 * @param {number} x
 * @returns {number}
 */
export function erfc(x) {
  if (x === 0) return 1
  const z = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * z)
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))))
  const erf = 1 - poly * Math.exp(-z * z)
  return x >= 0 ? 1 - erf : 1 + erf
}

/**
 * @typedef {object} MannWhitneyResult
 * @property {number} u the U statistic for sample `a` (U_a)
 * @property {number} z standardized statistic (normal approximation, tie-corrected); 0 when the variance is 0
 * @property {number} p two-sided p-value
 */

/**
 * Two-sided Mann-Whitney U test. Uses the normal approximation with tie
 * correction and no continuity correction; sample sizes in the harness are
 * in the tens to thousands, where the approximation is standard practice.
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 * @returns {MannWhitneyResult}
 */
export function mannWhitneyU(a, b) {
  const n1 = a.length
  const n2 = b.length
  if (n1 === 0 || n2 === 0) return { u: NaN, z: NaN, p: NaN }
  const { ranks, tieGroups } = averageRanks([...a, ...b])
  let r1 = 0
  for (let i = 0; i < n1; i++) r1 += ranks[i]
  const u = r1 - (n1 * (n1 + 1)) / 2
  const n = n1 + n2
  const mu = (n1 * n2) / 2
  let tieTerm = 0
  for (const t of tieGroups) tieTerm += t * t * t - t
  const variance = ((n1 * n2) / 12) * ((n + 1) - tieTerm / (n * (n - 1)))
  if (variance <= 0) return { u, z: 0, p: 1 }
  const z = (u - mu) / Math.sqrt(variance)
  const p = Math.min(1, erfc(Math.abs(z) / Math.SQRT2))
  return { u, z, p }
}
