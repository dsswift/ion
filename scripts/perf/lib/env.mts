/**
 * The isolated Environment a perf run drives: a throwaway ION_DATA_DIR with
 * an engine.json (mock provider on, telemetry to a file, optional OTLP
 * egress) and a server.json (headless, local listeners only), and the two
 * child processes with their readiness polls and a PID-scoped stop.
 */
import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { mkdirSync, writeFileSync, existsSync, openSync } from 'fs'
import { createServer } from 'net'
import { join } from 'path'

export interface ProviderScenario { seed: number; turns: Array<{ ttft_ms: number; tokens: number; tokens_per_s: number; tool_calls: unknown[] }>; repeat: boolean }
export interface DrivePlan { tabs: number; promptsPerTab: number; bodyLoadsPerTab: number; snapshotPolls: number; pacingMs: number; promptTimeoutMs: number; settleMs: number }
export interface Scenario { name: string; description?: string; provider: ProviderScenario; plan: DrivePlan }

export interface EnvOptions { dataDir: string; port: number; alloy?: string; relay?: string; relayPsk?: string }

export function log(msg: string, fields: Record<string, unknown> = {}): void {
  const extra = Object.entries(fields).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ')
  process.stderr.write(`perf: ${msg}${extra ? ' ' + extra : ''}\n`)
}

export function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => (port ? resolve(port) : reject(new Error('no port assigned'))))
    })
  })
}

/** Writes scenario.json, engine.json and server.json into the data dir and returns the workspace directory tabs open in. */
export function writeEnvironment(opts: EnvOptions, scenario: Scenario): string {
  mkdirSync(opts.dataDir, { recursive: true })
  const workspace = join(opts.dataDir, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(workspace, 'README.md'), `# perf workspace\n\nscenario ${scenario.name}\n`)
  const scenarioPath = join(opts.dataDir, 'scenario.json')
  writeFileSync(scenarioPath, JSON.stringify(scenario.provider, null, 2) + '\n')

  const logging: Record<string, unknown> = { maxSizeMB: 200, maxFiles: 3 }
  if (opts.alloy) {
    // The engine ships every file it tails (engine, server, telemetry) to the
    // one OTLP endpoint; spans in those files become traces (log-schema § Export).
    logging.egressTargets = ['otel']
    logging.egressEndpoint = opts.alloy
    logging.egressOtel = { enabled: true, endpoint: opts.alloy, protocol: 'http' }
    logging.egressShipSources = ['engine', 'server', 'telemetry']
  }
  const engine = {
    logLevel: 'info',
    defaultModel: 'mock/default',
    providers: { mock: { enabled: true, scenarioFile: scenarioPath } },
    telemetry: { enabled: true, targets: ['file'], filePath: join(opts.dataDir, 'telemetry.jsonl'), maxSizeMB: 200, maxFiles: 3 },
    security: { principalPartitioning: { enabled: false } },
    logging,
  }
  writeFileSync(join(opts.dataDir, 'engine.json'), JSON.stringify(engine, null, 2) + '\n')

  const server: Record<string, unknown> = {
    label: `perf ${scenario.name}`,
    logLevel: 'info',
    listen: { local: true, lan: false, tcp: { host: '127.0.0.1', port: opts.port } },
    web: { enabled: false },
    discovery: { mode: 'sealed' },
    tenancy: { mode: 'shared' },
  }
  if (opts.relay) {
    // Server-side leg only: the server joins the relay with a PSK. A client
    // leg needs an OIDC bearer the relay's issuer vouches for, which the
    // harness has no identity provider to mint (docs/contributing/performance.md).
    server.relays = [{ url: opts.relay, psk: opts.relayPsk ?? '' }]
  }
  writeFileSync(join(opts.dataDir, 'server.json'), JSON.stringify(server, null, 2) + '\n')
  return workspace
}

export interface Child { name: string; proc: ChildProcess; exited: Promise<number | null> }

function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, logPath: string): Child {
  const out = openSync(logPath, 'a')
  const proc = spawn(cmd, args, { env, stdio: ['ignore', out, out], detached: false })
  const exited = new Promise<number | null>((resolve) => {
    proc.once('exit', (code, signal) => { log(`${name} exited`, { code, signal, pid: proc.pid }); resolve(code) })
  })
  proc.once('error', (err) => log(`${name} failed to start`, { error: String(err), cmd }))
  log(`${name} started`, { pid: proc.pid, cmd, args: args.join(' ') })
  return { name, proc, exited }
}

export function startEngine(ionBinary: string, dataDir: string): Child {
  const env: NodeJS.ProcessEnv = { ...process.env, ION_DATA_DIR: dataDir }
  delete env.ION_SOCKET_PATH
  delete env.ION_PID_PATH
  return start('engine', ionBinary, ['serve'], env, join(dataDir, 'engine.stdout.log'))
}

export function startServer(serverMain: string, dataDir: string): Child {
  const env: NodeJS.ProcessEnv = { ...process.env, ION_DATA_DIR: dataDir, ION_LOG_OUTPUT: 'file' }
  delete env.ION_SOCKET_PATH
  delete env.ION_DESKTOP_ENGINE_SOCKET
  return start('server', process.execPath, [serverMain], env, join(dataDir, 'server.stdout.log'))
}

/** `ion health` against the run's own socket until it answers ok. */
export async function waitForEngine(ionBinary: string, dataDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      execFileSync(ionBinary, ['health'], { env: { ...process.env, ION_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 })
      log('engine ready', { socket: join(dataDir, 'engine.sock') })
      return
    } catch (err) { lastErr = String((err as { stderr?: Buffer }).stderr ?? err).trim().split('\n').pop() ?? '' }
    await sleep(500)
  }
  throw new Error(`engine not healthy after ${timeoutMs}ms: ${lastErr}`)
}

/** GET /readyz until 200: the server is up and its engine bridge is connected. */
export async function waitForServer(port: number, dataDir: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3000) })
      last = `HTTP ${res.status} ${(await res.text()).slice(0, 200)}`
      if (res.status === 200 && existsSync(join(dataDir, 'studio.sock'))) { log('server ready', { port }); return }
    } catch (err) { last = String(err) }
    await sleep(500)
  }
  throw new Error(`server not ready after ${timeoutMs}ms: ${last}`)
}

/** SIGTERM the PIDs this run started (never a broad kill), SIGKILL after a grace period. */
export async function stopChildren(children: Child[], graceMs = 10_000): Promise<void> {
  for (const c of children.reverse()) {
    if (c.proc.exitCode !== null || c.proc.signalCode !== null) continue
    log(`stopping ${c.name}`, { pid: c.proc.pid })
    c.proc.kill('SIGTERM')
    const done = await Promise.race([c.exited.then(() => true), sleep(graceMs).then(() => false)])
    if (!done) { log(`${c.name} ignored SIGTERM; killing`, { pid: c.proc.pid }); c.proc.kill('SIGKILL'); await c.exited }
  }
}
