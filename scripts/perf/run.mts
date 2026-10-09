#!/usr/bin/env node
/**
 * perf run -- drives one scenario against an isolated Environment (its own
 * ION_DATA_DIR, engine daemon, and headless server, mock provider on) over
 * the Studio wire, then reduces the spans both processes wrote inside the
 * run window to one result file.
 *
 *   scripts/perf/run.sh --scenario smoke|soak [--out perf/results/<scenario>/<sha>.json]
 *                       [--alloy http://localhost:4318] [--relay <url> [--relay-psk <psk>]]
 *                       [--max-minutes 20] [--ion engine/bin/ion] [--server server/dist/main.js] [--keep]
 *
 * Prerequisite: `make perf-build` (the engine binary and the server bundle).
 * Exit codes: 0 wrote a result; 1 the plan failed or the wall-time cap hit
 * (a result with `timedOut` is still written when the window closed); 2 setup.
 */
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { cpus, arch, platform, release } from 'os'
import { join, resolve, dirname } from 'path'
import { type Scenario, type Child, log, sleep, freePort, writeEnvironment, startEngine, startServer, waitForEngine, waitForServer, stopChildren } from './lib/env.mts'
import { LocalClient } from './lib/wire.mts'
import { collectSpans } from './lib/collect.mts'
import type { SpanSummary } from './lib/stats.mjs'

interface Args { scenario: string; out?: string; alloy?: string; relay?: string; relayPsk?: string; maxMinutes: number; ion: string; server: string; keep: boolean }

interface PerfResult {
  schema: 1
  scenario: string
  sha: string
  branch: string
  startedAt: string
  endedAt: string
  wallMs: number
  timedOut: boolean
  runner: { os: string; arch: string; cpus: number; node: string; go: string }
  plan: Scenario['plan']
  prompts: { attempted: number; completed: number; failed: number }
  spans: Record<string, SpanSummary>
}

// run.sh bundles this file into build/, so the source location says nothing
// about the repo; the wrapper names the root, a direct run uses the cwd.
const repoRoot = resolve(process.env.ION_PERF_REPO_ROOT ?? process.cwd())

function parseArgs(argv: string[]): Args {
  const args: Args = { scenario: 'smoke', maxMinutes: 20, ion: join(repoRoot, 'engine', 'bin', 'ion'), server: join(repoRoot, 'server', 'dist', 'main.js'), keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--scenario') args.scenario = argv[++i]
    else if (a === '--out') args.out = argv[++i]
    else if (a === '--alloy') args.alloy = argv[++i]
    else if (a === '--relay') args.relay = argv[++i]
    else if (a === '--relay-psk') args.relayPsk = argv[++i]
    else if (a === '--max-minutes') args.maxMinutes = Number(argv[++i])
    else if (a === '--ion') args.ion = resolve(argv[++i])
    else if (a === '--server') args.server = resolve(argv[++i])
    else if (a === '--keep') args.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!/^[a-z0-9-]+$/.test(args.scenario)) throw new Error(`--scenario must be a scenario file name, got ${args.scenario}`)
  if (!Number.isFinite(args.maxMinutes) || args.maxMinutes <= 0) throw new Error('--max-minutes must be a positive number')
  return args
}

function git(...a: string[]): string {
  try { return execFileSync('git', a, { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

function goVersion(): string {
  try { return execFileSync('go', ['version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^go version /, '') } catch { return 'unavailable' }
}

/** Builds the bundle path and starts the bundler-independent wall clock guard. */
async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  const scenarioPath = join(repoRoot, 'scripts', 'perf', 'scenarios', `${args.scenario}.json`)
  if (!existsSync(scenarioPath)) throw new Error(`no scenario file at ${scenarioPath}`)
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf-8')) as Scenario
  if (!existsSync(args.ion)) throw new Error(`engine binary missing at ${args.ion}; run make perf-build`)
  if (!existsSync(args.server)) throw new Error(`server bundle missing at ${args.server}; run make perf-build`)

  const sha = process.env.GITHUB_SHA || git('rev-parse', 'HEAD') || 'unknown'
  const branch = process.env.GITHUB_REF_NAME || git('branch', '--show-current') || 'unknown'
  const out = args.out ?? join(repoRoot, 'perf', 'results', args.scenario, `${sha}.json`)
  const dataDir = join('/tmp', `ion-perf-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  const port = await freePort()
  const workspace = writeEnvironment({ dataDir, port, alloy: args.alloy, relay: args.relay, relayPsk: args.relayPsk }, scenario)
  log('environment written', { scenario: args.scenario, data_dir: dataDir, port, sha, branch, alloy: args.alloy ?? 'none', relay: args.relay ?? 'none' })

  const children: Child[] = []
  let timedOut = false
  const prompts = { attempted: 0, completed: 0, failed: 0 }
  let startedAt = ''
  let endedAt = ''
  const wallStart = Date.now()
  const capMs = args.maxMinutes * 60_000
  let abort: () => void = () => undefined
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error(`wall time exceeded --max-minutes ${args.maxMinutes}`))
  })
  // Observed only through the races below; a cap that fires between two of
  // them must not surface as an unhandled rejection.
  aborted.catch(() => undefined) // silent-ok: every await below races this promise
  const capTimer = setTimeout(() => { timedOut = true; abort() }, capMs)

  let exit = 0
  try {
    children.push(startEngine(args.ion, dataDir))
    await Promise.race([waitForEngine(args.ion, dataDir, 60_000), aborted])
    children.push(startServer(args.server, dataDir))
    await Promise.race([waitForServer(port, dataDir, 60_000), aborted])

    const client = new LocalClient(join(dataDir, 'studio.sock'))
    await Promise.race([client.open(), aborted])
    try {
      startedAt = new Date().toISOString()
      await Promise.race([drive(client, scenario, workspace, prompts), aborted])
      await Promise.race([sleep(scenario.plan.settleMs), aborted])
      endedAt = new Date().toISOString()
    } finally { client.close() }
  } catch (err) {
    log('run failed', { error: String(err), timed_out: timedOut })
    if (startedAt && !endedAt) endedAt = new Date().toISOString()
    exit = 1
  } finally {
    clearTimeout(capTimer)
    await stopChildren(children)
  }

  if (!startedAt) {
    log('no window to collect; nothing written', { data_dir: dataDir })
    return exit || 2
  }
  // Both children have exited, so every span is flushed to disk.
  const spans = collectSpans(dataDir, { startMs: Date.parse(startedAt), endMs: Date.parse(endedAt) })
  const result: PerfResult = {
    schema: 1, scenario: args.scenario, sha, branch, startedAt, endedAt, wallMs: Date.now() - wallStart, timedOut,
    runner: { os: `${platform()} ${release()}`, arch: arch(), cpus: cpus().length, node: process.version, go: goVersion() },
    plan: scenario.plan, prompts, spans,
  }
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, JSON.stringify(result, null, 2) + '\n')
  log('result written', { out, wall_ms: result.wallMs, spans: Object.keys(spans).length, prompts: JSON.stringify(prompts) })
  process.stdout.write(renderTable(result))
  if (!args.keep) rmSync(dataDir, { recursive: true, force: true })
  else log('data dir kept', { data_dir: dataDir })
  if (prompts.failed > 0) exit = 1
  return exit
}

/** The driver plan: N tabs in parallel, each M prompts in sequence, then body loads, then snapshot polls. */
async function drive(client: LocalClient, scenario: Scenario, workspace: string, prompts: { attempted: number; completed: number; failed: number }): Promise<void> {
  const plan = scenario.plan
  const tabs: string[] = []
  for (let i = 0; i < plan.tabs; i++) {
    tabs.push(String(await client.action('createConversationTab', [workspace, { setActive: i === 0 }])))
    await sleep(plan.pacingMs)
  }
  log('tabs created', { count: tabs.length })
  await Promise.all(tabs.map(async (tabId, t) => {
    for (let m = 0; m < plan.promptsPerTab; m++) {
      prompts.attempted++
      try {
        const r = await client.prompt(tabId, `perf ${scenario.name} tab ${t} prompt ${m}`, plan.promptTimeoutMs)
        if (r.end === 'error' || r.end === 'status:failed') { prompts.failed++; log('prompt ended in failure', { tab: t, prompt: m, end: r.end }) }
        else prompts.completed++
      } catch (err) { prompts.failed++; log('prompt failed', { tab: t, prompt: m, error: String(err) }) }
      await sleep(plan.pacingMs)
    }
  }))
  log('prompts done', { ...prompts })
  for (const tabId of tabs) {
    for (let k = 0; k < plan.bodyLoadsPerTab; k++) {
      await client.action('loadSkeletonMessages', [tabId]).catch((err: unknown) => log('body load failed', { tab: tabId, error: String(err) }))
      await sleep(plan.pacingMs)
    }
  }
  for (let k = 0; k < plan.snapshotPolls; k++) {
    await client.snapshot()
    await sleep(plan.pacingMs)
  }
  log('plan complete', { body_loads: plan.bodyLoadsPerTab * tabs.length, snapshot_polls: plan.snapshotPolls })
}

function renderTable(r: PerfResult): string {
  const lines = [`perf ${r.scenario} @ ${r.sha.slice(0, 12)}  wall ${(r.wallMs / 1000).toFixed(1)}s  prompts ${r.prompts.completed}/${r.prompts.attempted}${r.timedOut ? '  TIMED OUT' : ''}`, '', 'span'.padEnd(44) + 'count'.padStart(7) + 'p50'.padStart(10) + 'p95'.padStart(10) + 'p99'.padStart(10) + 'max'.padStart(10)]
  for (const [key, s] of Object.entries(r.spans)) {
    lines.push(key.padEnd(44) + String(s.count).padStart(7) + s.p50.toFixed(1).padStart(10) + s.p95.toFixed(1).padStart(10) + s.p99.toFixed(1).padStart(10) + s.max.toFixed(1).padStart(10))
  }
  if (Object.keys(r.spans).length === 0) lines.push('(no spans inside the window)')
  return lines.join('\n') + '\n'
}

main().then((code) => { process.exitCode = code }).catch((err: unknown) => { process.stderr.write(`perf: ${String(err)}\n`); process.exitCode = 2 })
