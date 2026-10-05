// The in-app updater's install worker replaces the installed bundle as the
// signed-in user. A package install leaves that bundle owned by root, which
// this user cannot delete. These run the real script in a sandbox folder,
// with a bundle the user cannot delete standing in for a root-owned one.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, userInfo } from 'node:os'
import { spawnSync } from 'node:child_process'

const worker = join(__dirname, '..', '..', '..', 'scripts', 'install-worker.sh')
const posix = process.platform !== 'win32'

let root: string
let apps: string
let bin: string
let home: string

function bundle(dir: string, version: string): void {
  mkdirSync(join(dir, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(dir, 'Contents', 'version'), version)
  writeFileSync(join(dir, 'Contents', 'MacOS', 'Ion'), 'binary')
}

/** Makes every folder of a bundle read-only: its files can no longer be deleted, as with a bundle root owns. */
function lock(dir: string, mode: number): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) lock(join(dir, entry.name), mode)
  }
  chmodSync(dir, mode)
}

function stub(name: string, body: string): void {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/**
 * Stands in for pgrep. A lookup of the app's main process reports `pid` once
 * `open` has run at least `afterOpens` times; every other lookup finds nothing.
 */
function pgrepReporting(pid: number | null, afterOpens = 1): void {
  const opened = join(root, 'opened')
  const found = pid === null ? 'exit 1' : `[ -f "${opened}" ] && [ "$(wc -l < "${opened}")" -ge ${afterOpens} ] && echo ${pid} && exit 0`
  stub('pgrep', `case "$2" in *MacOS*) ${found};; esac\nexit 1`)
}

function opens(): number {
  const opened = join(root, 'opened')
  return existsSync(opened) ? readFileSync(opened, 'utf8').trim().split('\n').length : 0
}

function run(source: string, dest: string, overrides: Record<string, string> = {}): { status: number | null; log: string } {
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    ION_LSREGISTER: join(bin, 'lsregister'),
    ION_RELAUNCH_WAIT_SECONDS: '1',
    ION_RELAUNCH_SETTLE_SECONDS: '0',
    ION_RELAUNCH_BACKOFF_SECONDS: '0',
    ...overrides,
  }
  const result = spawnSync('bash', [worker, source, dest, '0'], { env, encoding: 'utf8' })
  const logFile = join(home, '.ion', 'install-worker.jsonl')
  return { status: result.status, log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '' }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ion-install-worker-'))
  apps = join(root, 'Applications')
  bin = join(root, 'bin')
  home = join(root, 'home')
  for (const dir of [apps, bin, home]) mkdirSync(dir)
  // The worker's own tools, replaced so nothing outside the sandbox is touched.
  stub('ditto', 'cp -R "$1" "$2"')
  // Ion comes up on the first launch unless a case says otherwise; the test
  // runner itself is the live process standing in for it.
  pgrepReporting(process.pid)
  // This user is the one signed in on screen unless a case says otherwise.
  stub('stat', `echo ${userInfo().username}`)
  stub('open', `echo "$1" >> "${join(root, 'opened')}"`)
  stub('lsregister', `echo "$@" >> "${join(root, 'unregistered')}"`)
})

afterEach(() => {
  for (const entry of existsSync(apps) ? readdirSync(apps) : []) lock(join(apps, entry), 0o755)
  rmSync(root, { recursive: true, force: true })
})

describe.runIf(posix)('install-worker', () => {
  it('replaces a bundle this user cannot delete, by setting it aside', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    lock(dest, 0o555)

    const { status, log } = run(staged, dest)

    expect(log).toContain('"event":"installed"')
    expect(status).toBe(0)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
    // The old bundle could not be deleted, so it stays set aside under the name the package scripts clean up.
    expect(readFileSync(join(apps, '.Ion.app.previous', 'Contents', 'version'), 'utf8')).toBe('old')
    expect(log).toContain('"event":"previous_bundle_left"')
    // It stays on disk, so macOS is told to forget it as an app.
    expect(readFileSync(join(root, 'unregistered'), 'utf8').trim()).toBe(`-u ${join(apps, '.Ion.app.previous')}`)
    expect(log).toContain('"event":"previous_bundle_unregistered"')
    expect(readFileSync(join(root, 'opened'), 'utf8').trim()).toBe(dest)
  })

  it('relaunches without the switch that would start Ion as bare Node', () => {
    // A `make desktop` from an Ion terminal inherits the local server's
    // ELECTRON_RUN_AS_NODE=1, and `open` passes it on: Ion then exits at once.
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    stub('open', `echo "\${ELECTRON_RUN_AS_NODE-unset}" >> "${join(root, 'opened')}"`)

    const { status, log } = run(staged, dest, { ELECTRON_RUN_AS_NODE: '1' })

    expect(status).toBe(0)
    expect(readFileSync(join(root, 'opened'), 'utf8').trim()).toBe('unset')
    expect(log).toContain('"event":"relaunch_env_scrubbed"')
    expect(log).toContain('"event":"relaunched"')
  })

  it('updates again while an undeletable set-aside bundle still holds the name', () => {
    const dest = join(apps, 'Ion.app')
    const leftover = join(apps, '.Ion.app.previous')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(leftover, 'oldest')
    lock(leftover, 0o555)
    bundle(dest, 'old')
    bundle(staged, 'new')

    const { status, log } = run(staged, dest)

    expect(status).toBe(0)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(readFileSync(join(leftover, 'Contents', 'version'), 'utf8')).toBe('oldest')
    // The bundle it replaced was this user's own, so it is gone.
    expect(readdirSync(apps).sort()).toEqual(['.Ion.app.previous', 'Ion.app'])
    expect(log).toContain('"event":"previous_bundle_removed"')
    // A deleted bundle leaves nothing for macOS to forget.
    expect(existsSync(join(root, 'unregistered'))).toBe(false)
  })

  it('leaves the installed bundle in place and starts it again when it cannot be set aside', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    // Staging beside the bundle works, renaming the bundle does not.
    stub('mv', `case "$1" in *Ion.app) exit 1;; esac\nexec /bin/mv "$@"`)

    const { status, log } = run(staged, dest)

    expect(status).toBe(1)
    expect(log).toContain('"reason":"bundle_set_aside_failed"')
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('old')
    expect(readdirSync(apps)).toEqual(['Ion.app'])
    expect(readFileSync(join(root, 'opened'), 'utf8').trim()).toBe(dest)
  })

  it('installs into an empty place', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(staged, 'new')
    expect(run(staged, dest).status).toBe(0)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
  })

  it('installs but leaves Ion closed when this user is not signed in on screen', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    stub('stat', 'echo loginwindow')

    const { status, log } = run(staged, dest)

    expect(status).toBe(0)
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
    expect(log).toContain('"event":"relaunch_skipped"')
    expect(log).not.toContain('"event":"relaunched"')
    expect(existsSync(join(root, 'opened'))).toBe(false)
  })

  it('reaps only processes running from the bundle it replaces', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    stub('pgrep', `case "$2" in *MacOS*) echo ${process.pid}; exit 0;; esac\nprintf '%s\\n' "$2" > "${join(root, 'pattern')}"\nexit 1`)

    expect(run(staged, dest).status).toBe(0)

    const pattern = new RegExp(readFileSync(join(root, 'pattern'), 'utf8').trim())
    expect(pattern.test(`${dest}/Contents/Frameworks/Ion Helper.app/Contents/MacOS/Ion Helper`)).toBe(true)
    expect(pattern.test('/Users/someone/source/ion/desktop/release/mac-arm64/Ion.app/Contents/MacOS/Ion')).toBe(false)
  })

  it('launches again when Ion does not come up on the first try', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(dest, 'old')
    bundle(staged, 'new')
    pgrepReporting(process.pid, 2)

    const { status, log } = run(staged, dest)

    expect(status).toBe(0)
    expect(opens()).toBe(2)
    expect(log).toContain('"event":"relaunch_attempt_failed","attempt":1,"reason":"not running"')
    expect(log).toContain('"attempt":2}')
  })

  it('launches again when Ion starts but exits right away', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(staged, 'new')
    // A process that has already exited stands in for a launch that died.
    const exited = spawnSync('true').pid
    pgrepReporting(exited)

    const { status, log } = run(staged, dest)

    expect(status).toBe(1)
    expect(log).toContain(`"event":"relaunch_exited_early","pid":${exited}`)
    expect(opens()).toBe(3)
  })

  it('gives up after three launches that never come up', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(staged, 'new')
    pgrepReporting(null)

    const { status, log } = run(staged, dest)

    expect(status).toBe(1)
    expect(opens()).toBe(3)
    expect(log).not.toContain('"event":"relaunched"')
    expect(log).toContain('"reason":"relaunch_failed"')
    // The new build is still installed; only the launch failed.
    expect(readFileSync(join(dest, 'Contents', 'version'), 'utf8')).toBe('new')
  })

  it('waits longer before each retry', () => {
    const dest = join(apps, 'Ion.app')
    const staged = join(root, 'staged', 'Ion.app')
    bundle(staged, 'new')
    pgrepReporting(null)
    stub('sleep', `echo "$1" >> "${join(root, 'slept')}"`)

    expect(run(staged, dest, { ION_RELAUNCH_BACKOFF_SECONDS: '5' }).status).toBe(1)

    // One-second polls while waiting for Ion, then 5s and 10s between attempts.
    const backoffs = readFileSync(join(root, 'slept'), 'utf8').trim().split('\n').filter((s) => s !== '1')
    expect(backoffs).toEqual(['5', '10'])
  })
})
