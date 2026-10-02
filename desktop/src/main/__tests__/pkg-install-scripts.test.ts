// Runs the package's preinstall and postinstall against a sandbox: a fake
// Ion.app whose main executable is a shell script that answers the quit
// signals the way each case needs. The scripts are macOS installer scripts, so
// the cases run on macOS only.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'

const scriptsDir = join(__dirname, '..', '..', '..', 'scripts', 'pkg-scripts')

/** What the fake main executable does with each quit signal. */
type FakeApp = 'exits-on-drain' | 'exits-on-forced-quit' | 'ignores-both'

const FAKE_MAIN: Record<FakeApp, string> = {
  'exits-on-drain': "trap 'exit 0' USR1",
  'exits-on-forced-quit': "trap '' USR1; trap 'exit 0' USR2",
  'ignores-both': "trap '' USR1 USR2",
}

interface Sandbox {
  root: string
  appPath: string
  stagingDir: string
  logFile: string
  env: NodeJS.ProcessEnv
}

function writeBundle(appPath: string, marker: string, main = 'exit 0'): void {
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(appPath, 'Contents', 'Info.plist'), marker)
  const executable = join(appPath, 'Contents', 'MacOS', 'Ion')
  writeFileSync(executable, `#!/bin/bash\n${main}\necho ready\nwhile :; do sleep 0.1; done\n`)
  chmodSync(executable, 0o755)
}

function makeSandbox(): Sandbox {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ion-pkg-scripts-')))
  const appPath = join(root, 'Applications', 'Ion.app')
  const stagingDir = join(root, 'pkg-staging')
  const logFile = join(root, 'install.log')
  mkdirSync(join(root, 'Applications'), { recursive: true })
  return {
    root,
    appPath,
    stagingDir,
    logFile,
    env: {
      PATH: process.env.PATH ?? '',
      ION_PKG_APP_PATH: appPath,
      ION_PKG_STAGING_DIR: stagingDir,
      ION_PKG_POLICY_PLIST: join(root, 'policy.plist'),
      ION_PKG_LOG_FILE: logFile,
      ION_PKG_FORCED_QUIT_WAIT_SECONDS: '2',
      ION_PKG_KILL_WAIT_SECONDS: '2',
      ION_PKG_SKIP_LAUNCH: '1',
    },
  }
}

function writePolicy(sandbox: Sandbox, installer: Record<string, unknown>): void {
  const json = join(sandbox.root, 'policy.json')
  writeFileSync(json, JSON.stringify({ customFields: { 'ion-desktop': { installer } } }))
  const converted = spawnSync('plutil', ['-convert', 'xml1', json, '-o', join(sandbox.root, 'policy.plist')])
  expect(converted.status).toBe(0)
}

/** Start an executable from inside the sandbox bundle and wait until its signal traps are installed. */
function start(executable: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [executable], { stdio: ['ignore', 'pipe', 'ignore'] })
    child.once('error', reject)
    child.stdout?.once('data', () => resolve(child))
  })
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

// Async on purpose: a synchronous spawn would stop this process from reaping
// the fake app while the script waits for it to disappear.
function run(script: 'preinstall' | 'postinstall', sandbox: Sandbox): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', [join(scriptsDir, script)], { env: sandbox.env, stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

describe.skipIf(process.platform !== 'darwin')('pkg install scripts', () => {
  let sandbox: Sandbox
  const children: ChildProcess[] = []

  async function startApp(behavior: FakeApp): Promise<ChildProcess> {
    writeBundle(sandbox.appPath, 'previous', FAKE_MAIN[behavior])
    const child = await start(join(sandbox.appPath, 'Contents', 'MacOS', 'Ion'))
    children.push(child)
    return child
  }

  const log = (): string => readFileSync(sandbox.logFile, 'utf8')

  beforeEach(() => {
    sandbox = makeSandbox()
  })

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.kill('SIGKILL')
      await exited(child)
    }
    rmSync(sandbox.root, { recursive: true, force: true })
  })

  it('proceeds when Ion is not running', async () => {
    expect(await run('preinstall', sandbox)).toBe(0)
    expect(log()).toContain('Ion is not running.')
  })

  it('refuses a running Ion by default and leaves it running', async () => {
    const app = await startApp('exits-on-drain')
    expect(await run('preinstall', sandbox)).toBe(1)
    expect(log()).toContain('refusing to replace the live application bundle')
    expect(app.exitCode).toBeNull()
    expect(app.signalCode).toBeNull()
  })

  it('replace policy drains a running Ion and succeeds', async () => {
    writePolicy(sandbox, { runningApp: 'replace' })
    const app = await startApp('exits-on-drain')
    expect(await run('preinstall', sandbox)).toBe(0)
    await exited(app)
    expect(app.exitCode).toBe(0)
    expect(log()).toContain('stop outcome: graceful')
    expect(log()).not.toContain('SIGUSR2')
  })

  it('replace policy forces the quit only after the drain bound elapses', async () => {
    writePolicy(sandbox, { runningApp: 'replace', drainTimeoutSeconds: 1 })
    const app = await startApp('exits-on-forced-quit')
    expect(await run('preinstall', sandbox)).toBe(0)
    await exited(app)
    expect(log()).toContain('drain bound of 1s elapsed; forcing the quit (SIGUSR2).')
    expect(log()).toContain('stop outcome: forced')
    expect(log()).not.toContain('SIGKILL')
  })

  it('replace policy terminates an Ion that ignores both quit requests', async () => {
    writePolicy(sandbox, { runningApp: 'replace', drainTimeoutSeconds: 1 })
    const app = await startApp('ignores-both')
    expect(await run('preinstall', sandbox)).toBe(0)
    await exited(app)
    expect(app.signalCode).toBe('SIGKILL')
    expect(log()).toContain('stop outcome: killed')
  })

  it('replace policy reaps helper processes of the bundle', async () => {
    writePolicy(sandbox, { runningApp: 'replace' })
    const app = await startApp('exits-on-drain')
    const helperDir = join(sandbox.appPath, 'Contents', 'Frameworks', 'Ion Helper.app', 'Contents', 'MacOS')
    mkdirSync(helperDir, { recursive: true })
    writeFileSync(join(helperDir, 'Ion Helper'), '#!/bin/bash\necho ready\nwhile :; do sleep 0.1; done\n')
    const helper = await start(join(helperDir, 'Ion Helper'))
    children.push(helper)

    expect(await run('preinstall', sandbox)).toBe(0)
    await exited(app)
    await exited(helper)
    expect(helper.signalCode).toBe('SIGKILL')
    expect(log()).toContain('reaped 1 helper process(es).')
  })

  it('an unknown policy value refuses, the same as no policy', async () => {
    writePolicy(sandbox, { runningApp: 'always' })
    const app = await startApp('exits-on-drain')
    expect(await run('preinstall', sandbox)).toBe(1)
    expect(log()).toContain('unknown installer.runningApp policy "always"; using refuse')
    expect(app.exitCode).toBeNull()
  })

  it('clears a staged bundle left by an interrupted install', async () => {
    writeBundle(join(sandbox.stagingDir, 'Ion.app'), 'stale')
    expect(await run('preinstall', sandbox)).toBe(0)
    expect(existsSync(sandbox.stagingDir)).toBe(false)
  })

  it('restores the previous bundle when an install was interrupted mid-swap', async () => {
    writeBundle(join(sandbox.root, 'Applications', '.Ion.app.previous'), 'previous')
    expect(await run('preinstall', sandbox)).toBe(0)
    expect(readFileSync(join(sandbox.appPath, 'Contents', 'Info.plist'), 'utf8')).toBe('previous')
    expect(existsSync(join(sandbox.root, 'Applications', '.Ion.app.previous'))).toBe(false)
  })

  it('postinstall replaces the installed bundle with the staged one and leaves nothing behind', async () => {
    writeBundle(sandbox.appPath, 'previous')
    writeFileSync(join(sandbox.appPath, 'Contents', 'only-in-previous'), '')
    writeBundle(join(sandbox.stagingDir, 'Ion.app'), 'new')

    expect(await run('postinstall', sandbox)).toBe(0)
    expect(readFileSync(join(sandbox.appPath, 'Contents', 'Info.plist'), 'utf8')).toBe('new')
    expect(existsSync(join(sandbox.appPath, 'Contents', 'only-in-previous'))).toBe(false)
    expect(existsSync(sandbox.stagingDir)).toBe(false)
    expect(existsSync(join(sandbox.root, 'Applications', '.Ion.app.previous'))).toBe(false)
  })

  it('postinstall installs into an empty location', async () => {
    writeBundle(join(sandbox.stagingDir, 'Ion.app'), 'new')
    expect(await run('postinstall', sandbox)).toBe(0)
    expect(readFileSync(join(sandbox.appPath, 'Contents', 'Info.plist'), 'utf8')).toBe('new')
  })

  it('postinstall leaves the installed bundle alone when the staged one is incomplete', async () => {
    writeBundle(sandbox.appPath, 'previous')
    mkdirSync(join(sandbox.stagingDir, 'Ion.app', 'Contents'), { recursive: true })

    expect(await run('postinstall', sandbox)).toBe(1)
    expect(readFileSync(join(sandbox.appPath, 'Contents', 'Info.plist'), 'utf8')).toBe('previous')
    expect(existsSync(sandbox.stagingDir)).toBe(false)
    expect(log()).toContain('staged application bundle is missing or incomplete')
  })

  it('a full unattended install over a running Ion succeeds', async () => {
    writePolicy(sandbox, { runningApp: 'replace' })
    const app = await startApp('exits-on-drain')

    expect(await run('preinstall', sandbox)).toBe(0)
    await exited(app)
    writeBundle(join(sandbox.stagingDir, 'Ion.app'), 'new')
    expect(await run('postinstall', sandbox)).toBe(0)

    expect(readFileSync(join(sandbox.appPath, 'Contents', 'Info.plist'), 'utf8')).toBe('new')
    expect(log()).toContain('stop outcome: graceful')
    expect(log()).toContain(`replaced ${sandbox.appPath} with the new bundle.`)
  })
})
