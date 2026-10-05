// `make desktop` builds Ion.app, then a detached coordinator drains the running
// Ion and hands the build to the updater's install worker. These run the real
// coordinator and worker in a sandbox: a fake HOME, a fake /Applications, and
// a fake running Ion that exits on the drain signal.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { spawn, type ChildProcess } from 'node:child_process'

const desktopDir = join(__dirname, '..', '..', '..')
const coordinator = join(desktopDir, 'commands', 'install-post-build.command')
const developerBuild = join(desktopDir, 'commands', 'install-bg.command')
const stageEngineResources = join(desktopDir, '..', 'scripts', 'stage-engine-resources.sh')
const posix = process.platform !== 'win32'

let root: string
let home: string
let bin: string
let dest: string
let staging: string
const children: ChildProcess[] = []

function bundle(dir: string, version: string): void {
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(dir, 'Contents', 'version'), version)
  writeFileSync(join(dir, 'Contents', 'MacOS', 'Ion'), 'binary')
}

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

/** A running Ion that records the drain signal and exits on it, registered in Ion's pid file. */
function startIon(): Promise<ChildProcess> {
  const script = `trap 'echo drained > "${join(root, 'signal')}"; exit 0' USR1\necho ready\nwhile :; do sleep 0.1; done\n`
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-c', script], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.once('error', reject)
    child.stdout?.once('data', () => {
      const pidDir = join(home, 'Library', 'Application Support', 'Ion')
      mkdirSync(pidDir, { recursive: true })
      writeFileSync(join(pidDir, 'ion.pid'), String(child.pid))
      children.push(child)
      resolve(child)
    })
  })
}

// Async on purpose: a synchronous spawn would stop this process from reaping
// the fake Ion, and the coordinator would wait on its zombie forever.
function runCoordinator(): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [coordinator, staging, dest], {
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        ION_RELAUNCH_WAIT_SECONDS: '1',
        ION_RELAUNCH_SETTLE_SECONDS: '0',
        ION_RELAUNCH_BACKOFF_SECONDS: '0',
      },
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('close', resolve)
  })
}

const coordinatorLog = (): string => readFileSync(join(home, '.ion', 'dev-install-coordinator.log'), 'utf8')
const workerLog = (): string => readFileSync(join(home, '.ion', 'install-worker.jsonl'), 'utf8')

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-dev-install-')))
  home = join(root, 'home')
  bin = join(root, 'bin')
  dest = join(root, 'Applications', 'Ion.app')
  staging = join(root, 'staging')
  for (const dir of [home, bin, join(root, 'Applications')]) mkdirSync(dir)
  bundle(dest, 'old')
  bundle(join(staging, 'Ion.app'), 'new')
  // The worker's own tools, replaced so nothing outside the sandbox is touched.
  stub('ditto', 'cp -R "$1" "$2"')
  // Ion's main process shows up only once the worker has reopened it; the test
  // runner itself is the live process standing in for it.
  const opened = join(root, 'opened')
  stub('pgrep', `case "$2" in *MacOS*) [ -f "${opened}" ] && echo ${process.pid} && exit 0;; esac\nexit 1`)
  stub('stat', `echo ${userInfo().username}`)
  stub('open', `echo "$1" >> "${join(root, 'opened')}"`)
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGKILL')
    await exited(child)
  }
  rmSync(root, { recursive: true, force: true })
})

describe.runIf(posix)('developer install coordinator', () => {
  it('drains the running Ion, then installs the build without Installer and reopens it', async () => {
    const ion = await startIon()

    expect(await runCoordinator()).toBe(0)

    await exited(ion)
    expect(readFileSync(join(root, 'signal'), 'utf8').trim()).toBe('drained')
    expect(coordinatorLog()).toContain(`requesting graceful Ion quit for developer install, pid=${ion.pid}`)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(workerLog()).toContain('"event":"installed"')
    expect(readFileSync(join(root, 'opened'), 'utf8').trim()).toBe(dest)
    // The staged snapshot belongs to the coordinator and is gone once it ends.
    expect(existsSync(staging)).toBe(false)
  })

  it('installs straight away when Ion is not running', async () => {
    expect(await runCoordinator()).toBe(0)

    expect(coordinatorLog()).toContain(`Ion is not running; installing ${dest}`)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(existsSync(staging)).toBe(false)
  })

  it('reports a failed install and still removes the staged build', async () => {
    // Staging beside the bundle works, setting the installed bundle aside does not.
    stub('mv', `case "$1" in *Ion.app) exit 1;; esac\nexec /bin/mv "$@"`)

    expect(await runCoordinator()).toBe(1)

    expect(coordinatorLog()).toContain('install failed with exit 1')
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('old')
    expect(existsSync(staging)).toBe(false)
  })

  it('is what the developer build dispatches, with a snapshot of the built app', () => {
    const body = readFileSync(developerBuild, 'utf8')
    expect(body).toContain('bash scripts/built-app-path.sh release')
    expect(body).toContain('ditto "$BUILT_APP" "$STAGING_DIR/Ion.app"')
    expect(body).toContain('commands/install-post-build.command "$STAGING_DIR"')
    expect(body).not.toContain('npm run pkg')
  })

  // The SDK staging itself lives in the shared stager every Ion.app-producing
  // path runs, so `make desktop-pkg` and the developer build stage the same
  // inputs. Both halves are pinned: the developer build must call the stager,
  // and the stager must stage both SDKs.
  it('stages both SDKs before building the app', () => {
    expect(readFileSync(developerBuild, 'utf8')).toContain('bash ../scripts/stage-engine-resources.sh')

    const stager = readFileSync(stageEngineResources, 'utf8')
    expect(stager).toContain('rm -rf "$RES/extensions/sdk" "$RES/extensions/sdk-go"')
    expect(stager).toContain('cp -R "$REPO_ROOT/engine/extensions/sdk" "$RES/extensions/sdk"')
    expect(stager).toContain('cp -R "$REPO_ROOT/sdk/go" "$RES/extensions/sdk-go"')
  })
})
