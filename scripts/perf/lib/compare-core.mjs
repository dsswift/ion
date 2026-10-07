// @ts-check
/**
 * Compare two perf result files span by span. A span key present in both
 * gets its p50 and p95 deltas; when both files kept raw samples a two-sided
 * Mann-Whitney U test decides significance. The verdict rule is documented
 * in perf/results/README.md and pinned by scripts/perf/__tests__/compare.test.mts.
 */
import { mannWhitneyU } from './stats.mjs'

/**
 * @typedef {import('./stats.mjs').SpanSummary} SpanSummary
 * @typedef {{ schema: number; scenario: string; sha: string; spans: Record<string, SpanSummary> }} PerfResult
 * @typedef {'regressed' | 'improved' | 'unchanged'} Verdict
 * @typedef {object} CompareRow
 * @property {string} key `<service>/<span>`
 * @property {number} countA
 * @property {number} countB
 * @property {number} p50A
 * @property {number} p50B
 * @property {number} p95A
 * @property {number} p95B
 * @property {number} deltaP50 relative change of p50, (B - A) / A; NaN when A is 0
 * @property {number} deltaP95 relative change of p95, (B - A) / A; NaN when A is 0
 * @property {number | null} p two-sided Mann-Whitney p-value; null when either side lacks raw samples
 * @property {Verdict} verdict
 */

export const DEFAULT_THRESHOLD = 0.1
export const ALPHA = 0.05

/**
 * @param {number} a
 * @param {number} b
 * @returns {number}
 */
function relativeDelta(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0) return NaN
  return (b - a) / a
}

/**
 * The verdict rule. The effect is the relative change of p50, the location
 * statistic the U test is about. With raw samples on both sides a verdict
 * needs p < alpha AND |effect| >= threshold; without samples there is no
 * test, so the threshold alone decides and `p` is null.
 * @param {number} effect
 * @param {number | null} p
 * @param {number} threshold
 * @param {number} alpha
 * @returns {Verdict}
 */
export function classify(effect, p, threshold, alpha = ALPHA) {
  if (!Number.isFinite(effect) || Math.abs(effect) < threshold) return 'unchanged'
  if (p !== null && !(p < alpha)) return 'unchanged'
  return effect > 0 ? 'regressed' : 'improved'
}

/**
 * @param {PerfResult} a baseline
 * @param {PerfResult} b candidate
 * @param {{ threshold?: number; alpha?: number }} [opts]
 * @returns {CompareRow[]} regressions first, then improvements, then unchanged; alphabetical within a group
 */
export function compareResults(a, b, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const alpha = opts.alpha ?? ALPHA
  /** @type {CompareRow[]} */
  const rows = []
  for (const key of Object.keys(a.spans).sort()) {
    const sa = a.spans[key]
    const sb = b.spans[key]
    if (!sb) continue
    const deltaP50 = relativeDelta(sa.p50, sb.p50)
    const deltaP95 = relativeDelta(sa.p95, sb.p95)
    /** @type {number | null} */
    let p = null
    if (sa.samples && sb.samples && sa.samples.length > 0 && sb.samples.length > 0) {
      p = mannWhitneyU(sa.samples, sb.samples).p
    }
    rows.push({ key, countA: sa.count, countB: sb.count, p50A: sa.p50, p50B: sb.p50, p95A: sa.p95, p95B: sb.p95, deltaP50, deltaP95, p, verdict: classify(deltaP50, p, threshold, alpha) })
  }
  const order = { regressed: 0, improved: 1, unchanged: 2 }
  rows.sort((x, y) => order[x.verdict] - order[y.verdict] || x.key.localeCompare(y.key))
  return rows
}

/**
 * @param {number} v
 * @returns {string}
 */
function ms(v) {
  return Number.isFinite(v) ? v.toFixed(v >= 100 ? 0 : 1) : '-'
}

/**
 * @param {number} v
 * @returns {string}
 */
function pct(v) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%` : '-'
}

/**
 * @param {CompareRow[]} rows
 * @param {{ labelA: string; labelB: string; threshold: number }} meta
 * @returns {string} GitHub-flavoured markdown
 */
export function renderMarkdown(rows, meta) {
  const counts = { regressed: 0, improved: 0, unchanged: 0 }
  for (const r of rows) counts[r.verdict]++
  const lines = [
    `### Perf compare: ${meta.labelA} -> ${meta.labelB}`,
    '',
    `${rows.length} spans in both; ${counts.regressed} regressed, ${counts.improved} improved, ${counts.unchanged} unchanged (threshold ${(meta.threshold * 100).toFixed(0)}%, p < ${ALPHA}).`,
    '',
    '| verdict | span | n (A/B) | p50 A | p50 B | d p50 | p95 A | p95 B | d p95 | p |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|',
  ]
  for (const r of rows) {
    lines.push(`| ${r.verdict} | \`${r.key}\` | ${r.countA}/${r.countB} | ${ms(r.p50A)} | ${ms(r.p50B)} | ${pct(r.deltaP50)} | ${ms(r.p95A)} | ${ms(r.p95B)} | ${pct(r.deltaP95)} | ${r.p === null ? 'n/a' : r.p < 0.001 ? '<0.001' : r.p.toFixed(3)} |`)
  }
  if (rows.length === 0) lines.push('| - | no span key is present in both files | | | | | | | | |')
  return lines.join('\n') + '\n'
}
