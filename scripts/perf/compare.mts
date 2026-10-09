#!/usr/bin/env node
/**
 * perf compare -- two result files from scripts/perf/run.mts to one markdown
 * table of per-span deltas with a Mann-Whitney U verdict.
 *
 *   node --experimental-strip-types scripts/perf/compare.mts A.json B.json [--threshold 0.10] [--fail] [--summary <path>]
 *
 * A is the baseline, B the candidate. Exit code 1 only with `--fail` and at
 * least one `regressed` row; 2 on a usage or read error.
 */
import { readFileSync, writeFileSync } from 'fs'
import { compareResults, renderMarkdown, DEFAULT_THRESHOLD, type PerfResult } from './lib/compare-core.mjs'

interface Args { a: string; b: string; threshold: number; fail: boolean; summary?: string }

function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const args: Args = { a: '', b: '', threshold: DEFAULT_THRESHOLD, fail: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--threshold') {
      const v = Number(argv[++i])
      if (!Number.isFinite(v) || v < 0) throw new Error(`--threshold must be a non-negative number, got ${argv[i]}`)
      args.threshold = v
    } else if (a === '--fail') args.fail = true
    else if (a === '--summary') args.summary = argv[++i]
    else if (a.startsWith('--')) throw new Error(`unknown argument ${a}`)
    else positional.push(a)
  }
  if (positional.length !== 2) throw new Error('usage: compare.mts A.json B.json [--threshold 0.10] [--fail] [--summary <path>]')
  args.a = positional[0]
  args.b = positional[1]
  return args
}

function readResult(path: string): PerfResult {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<PerfResult>
  if (parsed.schema !== 1 || typeof parsed.spans !== 'object' || parsed.spans === null) {
    throw new Error(`${path}: not a schema 1 perf result`)
  }
  return parsed as PerfResult
}

function main(): number {
  const args = parseArgs(process.argv.slice(2))
  const a = readResult(args.a)
  const b = readResult(args.b)
  if (a.scenario !== b.scenario) {
    process.stderr.write(`perf-compare: scenario mismatch (${a.scenario} vs ${b.scenario}); numbers are observations, not drift\n`)
  }
  const rows = compareResults(a, b, { threshold: args.threshold })
  const md = renderMarkdown(rows, { labelA: a.sha.slice(0, 12), labelB: b.sha.slice(0, 12), threshold: args.threshold })
  process.stdout.write(md)
  if (args.summary) writeFileSync(args.summary, md, { flag: 'a' })
  const regressions = rows.filter((r) => r.verdict === 'regressed').length
  if (regressions > 0) process.stderr.write(`perf-compare: ${regressions} regressed span(s)${args.fail ? '' : ' (report only; pass --fail to exit 1)'}\n`)
  return args.fail && regressions > 0 ? 1 : 0
}

try {
  process.exitCode = main()
} catch (err: unknown) {
  process.stderr.write(`perf-compare: ${String(err)}\n`)
  process.exitCode = 2
}
