import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classify, compareResults, renderMarkdown } from '../lib/compare-core.mjs'
import { summarize } from '../lib/stats.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'compare.mts')

function result(sha: string, spans: Record<string, number[]>, keepSamples = true) {
  const out: Record<string, ReturnType<typeof summarize>> = {}
  for (const [k, v] of Object.entries(spans)) {
    const s = summarize(v)
    if (!keepSamples) delete s.samples
    out[k] = s
  }
  return { schema: 1, scenario: 'smoke', sha, spans: out }
}

const seq = (n: number, base: number, step: number) => Array.from({ length: n }, (_, i) => base + i * step)

test('classify: threshold and significance both gate a verdict', () => {
  assert.equal(classify(0.5, 0.001, 0.1), 'regressed')
  assert.equal(classify(-0.5, 0.001, 0.1), 'improved')
  assert.equal(classify(0.05, 0.001, 0.1), 'unchanged', 'below threshold')
  assert.equal(classify(0.5, 0.2, 0.1), 'unchanged', 'not significant')
  assert.equal(classify(0.5, null, 0.1), 'regressed', 'no samples: threshold alone')
  assert.equal(classify(NaN, null, 0.1), 'unchanged')
})

test('compareResults: regressed, improved, unchanged, sorted regressions first', () => {
  const a = result('aaaaaaaaaaaaaaaa', {
    'ion-server/prompt.handle': seq(40, 10, 0.5),
    'ion-engine/run.execute': seq(40, 1000, 5),
    'ion-engine/llm.call': seq(40, 500, 2),
    'ion-engine/only-in-a': seq(10, 1, 1),
  })
  const b = result('bbbbbbbbbbbbbbbb', {
    'ion-server/prompt.handle': seq(40, 10, 0.5),            // same -> unchanged
    'ion-engine/run.execute': seq(40, 1500, 5),              // +50% -> regressed
    'ion-engine/llm.call': seq(40, 250, 2),                  // -50% -> improved
    'ion-engine/only-in-b': seq(10, 1, 1),
  })
  const rows = compareResults(a, b, { threshold: 0.1 })
  assert.deepEqual(rows.map((r) => [r.key, r.verdict]), [
    ['ion-engine/run.execute', 'regressed'],
    ['ion-engine/llm.call', 'improved'],
    ['ion-server/prompt.handle', 'unchanged'],
  ])
  const reg = rows[0]
  assert.ok(Math.abs(reg.deltaP50 - 0.455) < 0.01, `deltaP50=${reg.deltaP50}`)
  assert.ok(reg.p !== null && reg.p < 0.001)
  assert.equal(rows[2].p !== null && rows[2].p, 1)
})

test('compareResults: a large shift that is not significant stays unchanged', () => {
  // Two overlapping tiny samples: medians differ by 30% but n = 3 cannot reach p < 0.05.
  const a = result('a'.repeat(16), { k: [10, 11, 12] })
  const b = result('b'.repeat(16), { k: [12, 13, 14] })
  const rows = compareResults(a, b, { threshold: 0.1 })
  assert.equal(rows[0].verdict, 'unchanged')
  assert.ok(rows[0].p !== null && rows[0].p > 0.05)
})

test('compareResults: without raw samples the threshold alone decides and p is null', () => {
  const a = result('a'.repeat(16), { k: seq(20, 100, 1) }, false)
  const b = result('b'.repeat(16), { k: seq(20, 130, 1) }, false)
  const rows = compareResults(a, b, { threshold: 0.1 })
  assert.equal(rows[0].p, null)
  assert.equal(rows[0].verdict, 'regressed')
})

test('renderMarkdown: a table with the verdict column first', () => {
  const rows = compareResults(result('a'.repeat(16), { k: seq(20, 100, 1) }), result('b'.repeat(16), { k: seq(20, 100, 1) }))
  const md = renderMarkdown(rows, { labelA: 'aaaa', labelB: 'bbbb', threshold: 0.1 })
  assert.match(md, /^### Perf compare: aaaa -> bbbb/)
  assert.match(md, /\| unchanged \| `k` \| 20\/20 \|/)
})

test('CLI exit codes: 0 by default, 1 only with --fail and a regression, 2 on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ion-perf-compare-'))
  const a = join(dir, 'a.json')
  const b = join(dir, 'b.json')
  const summary = join(dir, 'summary.md')
  writeFileSync(a, JSON.stringify(result('a'.repeat(40), { 'ion-engine/run.execute': seq(40, 1000, 5) })))
  writeFileSync(b, JSON.stringify(result('b'.repeat(40), { 'ion-engine/run.execute': seq(40, 1500, 5) })))
  const node = process.execPath
  const flags = ['--experimental-strip-types', '--no-warnings', cli]
  const report = spawnSync(node, [...flags, a, b, '--summary', summary], { encoding: 'utf-8' })
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.stdout, /regressed/)
  assert.match(readFileSync(summary, 'utf-8'), /regressed/)
  const fail = spawnSync(node, [...flags, a, b, '--fail'], { encoding: 'utf-8' })
  assert.equal(fail.status, 1)
  const same = spawnSync(node, [...flags, a, a, '--fail'], { encoding: 'utf-8' })
  assert.equal(same.status, 0, same.stderr)
  const bad = spawnSync(node, [...flags, a], { encoding: 'utf-8' })
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /usage/)
  assert.doesNotThrow(() => execFileSync(node, [...flags, a, b, '--threshold', '0.9'], { encoding: 'utf-8' }))
})
