/**
 * Real-engine test harness for `server/tests/integration/*.test.ts` (manifest
 * child 11 "integration lane"): builds the actual `engine/cmd/ion` binary
 * with `go build` and runs it as a child process against a temp
 * `ION_DATA_DIR`, mirroring `engine/tests/integration`'s own real-process
 * shape rather than mocking the engine bridge the way `src/__tests__/boot.test.ts`
 * does. Not a `*.test.ts` file itself -- collected by
 * `vitest.integration.config.ts`'s `tests/integration/**\/*.test.ts` include,
 * not the default `src/**\/*.test.{ts,tsx}` one, so it never runs as part of
 * the fast `npm -w server test` dev-loop suite.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ENGINE_DIR = join(__dirname, '..', '..', '..', 'engine')

let cachedBinaryPath: Promise<string> | null = null

/**
 * Builds `engine/cmd/ion` once per test process (`go build`, not `go run`,
 * so the harness starts the same binary shape `engine/Dockerfile` ships) and
 * memoizes the result -- every test in the suite that needs a real engine
 * reuses the same compiled binary rather than rebuilding per test.
 */
export function buildEngineBinary(): Promise<string> {
  if (!cachedBinaryPath) {
    cachedBinaryPath = (async () => {
      const outDir = mktempSyncSafe('ion-engine-build-')
      const binPath = join(outDir, process.platform === 'win32' ? 'ion.exe' : 'ion')
      // engine/Makefile's real build passes `-X main.version=$(VERSION)`
      // (main.go's `var version = "dev"` default otherwise). A plain-"dev"
      // build fails `version-check.ts`'s `parseVersion` entirely (it is not
      // `major.minor.patch`), which the server treats as incompatible and
      // never becomes ready -- so this harness needs a parseable synthetic
      // version too, not the real release process's actual version number.
      const result = spawnSync('go', ['build', '-ldflags', '-X main.version=0.0.0-integration-test', '-o', binPath, './cmd/ion'], {
        cwd: ENGINE_DIR,
        encoding: 'utf-8',
      })
      if (result.status !== 0) {
        throw new Error(`go build ./cmd/ion failed (exit ${result.status}):\n${result.stdout}\n${result.stderr}`)
      }
      if (!existsSync(binPath)) {
        throw new Error(`go build reported success but ${binPath} does not exist`)
      }
      return binPath
    })()
  }
  return cachedBinaryPath
}

function mktempSyncSafe(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

export interface EngineHandle {
  proc: ChildProcess
  dataDir: string
  sockPath: string
  /** Sends SIGTERM and waits (bounded) for the process to exit. */
  stop(): Promise<void>
}

/** Polls for `path` to exist, rejecting after `timeoutMs`. */
async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${path} to appear`)
}

/**
 * Spawns the built engine binary (`ion serve`) against a fresh temp
 * `ION_DATA_DIR`, and waits for `<dataDir>/engine.sock` to appear before
 * resolving -- the same file the server's own `engine-address.ts` resolves
 * to (non-win32: `<ION_DATA_DIR>/engine.sock`), so a caller that then points
 * the SERVER at the same `dataDir` connects to this exact process.
 */
export async function startEngine(opts: { dataDir?: string; socketWaitMs?: number } = {}): Promise<EngineHandle> {
  const dataDir = opts.dataDir ?? mktempSyncSafe('ion-engine-data-')
  const binPath = await buildEngineBinary()
  const sockPath = join(dataDir, 'engine.sock')

  const proc = spawn(binPath, ['serve'], {
    env: { ...process.env, ION_DATA_DIR: dataDir, HOME: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stderrTail = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000)
  })

  const exited = new Promise<never>((_resolve, reject) => {
    proc.once('exit', (code, signal) => {
      reject(new Error(`engine process exited early (code=${code}, signal=${signal}): ${stderrTail}`))
    })
  })

  try {
    await Promise.race([waitForFile(sockPath, opts.socketWaitMs ?? 15000), exited])
  } catch (err) {
    proc.kill('SIGKILL')
    throw err
  }

  return {
    proc,
    dataDir,
    sockPath,
    async stop(): Promise<void> {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          proc.kill('SIGKILL')
          resolve()
        }, 5000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        proc.kill('SIGTERM')
      })
    },
  }
}

/** Removes a temp `dataDir` created by `startEngine` (or passed to it). Safe to call after `stop()`. */
export function cleanupEngineDataDir(dataDir: string): void {
  rmSync(dataDir, { recursive: true, force: true })
}
