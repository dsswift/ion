/**
 * ssh-bootstrap -- the remote half of the SSH door: what runs ON the host.
 *
 * Three remote commands, each over `runSsh`:
 *
 *  1. `probeHost`: `uname -s; uname -m; echo $HOME`, which proves key auth
 *     and tells us which bundle the host needs.
 *  2. `installOnHost`: pipes `install-studio-server.sh` (the same script a
 *     consumer curls) into `sh -s` with `ION_STUDIO_VERSION` pinned to the
 *     server version this desktop shipped with, so the pair stays in step.
 *     A development desktop ships no release, so it packages the bundle
 *     from its own repo first (`make package-studio-server`, the same
 *     target the deploy script runs, streamed into the dialog), copies it
 *     to the host, and points `ION_STUDIO_BUNDLE` at it. It always
 *     rebuilds: a development desktop exists to put the current source on
 *     the host, and a bundle left in `build/deploy` by an earlier run is
 *     exactly the stale artifact that would otherwise ship. A desktop is a
 *     development desktop when it is unpackaged
 *     OR when its server bundle carries a `DEV_ROOT` file, which the local
 *     build (`build-dev-app.js`) stages and the release workflow does not:
 *     `make desktop` produces a packaged app whose server version has no
 *     release either. The installer's last stdout line is a JSON receipt.
 *  3. `mintPairingLink`: `ion studio pair --json` from the installed bundle.
 *
 * The installer script and the server version are read from beside the
 * desktop's own server bundle (`dist/server`), where the build stages them.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawn as nodeSpawn } from 'child_process'
import { runSsh, sshBaseArgs, SshError, type SshDestination, type SshSpawn } from './ssh-command'
import { log as _log, warn as _warn } from '../../logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('ssh-bootstrap', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('ssh-bootstrap', msg, fields)
}

/** Where the services live on the host once installed (mirrors `ion studio`'s layout under the host's ~/.ion). */
export const REMOTE_ION_BIN = '$HOME/.ion/studio-server/current/bin/ion'
const REMOTE_INCOMING_DIR = '$HOME/.ion/studio-server/incoming'

export interface HostPlatform {
  goos: 'darwin' | 'linux'
  goarch: 'amd64' | 'arm64'
  home: string
}

/** Parses `uname -s; uname -m; echo $HOME` output. */
export function parseHostPlatform(stdout: string): HostPlatform {
  const [os = '', arch = '', home = ''] = stdout.trim().split('\n').map((l) => l.trim())
  const goos = os === 'Darwin' ? 'darwin' : os === 'Linux' ? 'linux' : null
  const goarch = /^(x86_64|amd64)$/.test(arch) ? 'amd64' : /^(arm64|aarch64)$/.test(arch) ? 'arm64' : null
  if (!goos) throw new Error(`The host runs ${os || 'an unknown OS'}; the Studio server installs as a service on macOS and Linux only.`)
  if (!goarch) throw new Error(`The host's architecture ${arch || '(unknown)'} is not supported (x86_64 or arm64).`)
  if (!home) throw new Error('The host did not report a home directory.')
  return { goos, goarch, home }
}

/** What Ion has already left on a host, read before an install so a re-add says so instead of looking like a first install. */
export interface HostAppraisal {
  /** The installed Studio Server bundle version, or null when none is installed. */
  studioVersion: string | null
  /** The account the SSH login landed in: the install (present or to come) is that account's. */
  user: string | null
  /** The port the existing install's server.json names; null when there is no install or it names none (the server default then). */
  port: number | null
  conversations: number
  gitCredentialHosts: number
  projects: number
}

/**
 * POSIX sh only (the host may have nothing else yet): the bundle VERSION's
 * server field, distinct conversation ids, stored git credential hosts, and
 * registered projects, each as `key=value` on its own line.
 */
export const HOST_APPRAISAL_COMMAND = [
  'v=""; [ -f "$HOME/.ion/studio-server/current/VERSION" ] && v=$(sed -n \'s/.*"server": *"\\([^"]*\\)".*/\\1/p\' "$HOME/.ion/studio-server/current/VERSION")',
  'echo "studio=${v:--}"',
  'echo "user=$(id -un)"',
  'pt=""; [ -f "$HOME/.ion/server.json" ] && pt=$(sed -n \'s/.*"port": *\\([0-9][0-9]*\\).*/\\1/p\' "$HOME/.ion/server.json" | head -n 1)',
  'echo "port=${pt:--}"',
  'c=0; [ -d "$HOME/.ion/conversations" ] && c=$(ls "$HOME/.ion/conversations" 2>/dev/null | sed -n -e \'s/\\.tree\\.jsonl$//p\' -e \'s/\\.llm\\.jsonl$//p\' | sort -u | wc -l | tr -d " ")',
  'echo "conversations=$c"',
  'g=0; [ -f "$HOME/.ion/git-credentials.json" ] && g=$(grep -o \'"host"\' "$HOME/.ion/git-credentials.json" | wc -l | tr -d " ")',
  'echo "git_credentials=$g"',
  'p=0; [ -f "$HOME/.ion/settings.json" ] && p=$(grep -o \'"addedManually"\' "$HOME/.ion/settings.json" | wc -l | tr -d " ")',
  'echo "projects=$p"',
].join('; ')

export function parseHostAppraisal(stdout: string): HostAppraisal {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim())
  }
  const num = (key: string): number => { const n = Number(values.get(key) ?? '0'); return Number.isFinite(n) ? n : 0 }
  const studio = values.get('studio') ?? '-'
  const user = values.get('user') ?? ''
  const port = Number(values.get('port') ?? '-')
  return {
    studioVersion: studio && studio !== '-' ? studio : null,
    user: user || null,
    port: Number.isInteger(port) && port > 0 ? port : null,
    conversations: num('conversations'),
    gitCredentialHosts: num('git_credentials'),
    projects: num('projects'),
  }
}

/** The server's own default port, used when an install's server.json names none. */
export const DEFAULT_STUDIO_PORT = 7331

/** The port an existing install listens on. */
export function installedPort(a: HostAppraisal): number {
  return a.port ?? DEFAULT_STUDIO_PORT
}

/** One sentence for the progress list: what the host already has, or that it is fresh. */
export function describeHostAppraisal(a: HostAppraisal): string {
  if (!a.studioVersion && a.conversations === 0 && a.gitCredentialHosts === 0 && a.projects === 0) return 'Fresh host: no Ion install found.'
  const parts: string[] = []
  parts.push(a.studioVersion ? `Studio Server ${a.studioVersion} for ${a.user ?? 'this account'} on port ${installedPort(a)} (kept as is; this desktop will only be paired)` : `no Studio Server${a.user ? ` for ${a.user}` : ''}`)
  if (a.conversations > 0) parts.push(`${a.conversations} conversation${a.conversations === 1 ? '' : 's'}`)
  if (a.gitCredentialHosts > 0) parts.push(`git credentials for ${a.gitCredentialHosts} host${a.gitCredentialHosts === 1 ? '' : 's'}`)
  if (a.projects > 0) parts.push(`${a.projects} project${a.projects === 1 ? '' : 's'}`)
  return `Already on the host: ${parts.join(', ')}. Everything is kept.`
}

export async function appraiseHost(dest: SshDestination, spawn?: SshSpawn): Promise<HostAppraisal> {
  const result = await runSsh({ dest, command: HOST_APPRAISAL_COMMAND, spawn })
  const appraisal = parseHostAppraisal(result.stdout)
  log('host appraised', { destination: dest.destination, ...appraisal })
  return appraisal
}

export async function probeHost(dest: SshDestination, spawn?: SshSpawn): Promise<HostPlatform> {
  const result = await runSsh({ dest, command: 'uname -s; uname -m; echo "$HOME"', spawn })
  const platform = parseHostPlatform(result.stdout)
  log('host probed', { destination: dest.destination, ...platform })
  return platform
}

/** The installer receipt `ion studio install` prints as its last stdout line. */
export interface InstallReceipt {
  ok: true
  version: string
  engine?: string
  port: number
  /** The account the services run as. */
  user?: string
  dataDir: string
}

/** Finds the receipt: the LAST line that parses as `{"ok":true,...}`. Throws with the output tail when absent. */
export function parseInstallReceipt(stdout: string): InstallReceipt {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as Partial<InstallReceipt>
      if (parsed.ok === true && typeof parsed.version === 'string' && typeof parsed.port === 'number' && typeof parsed.dataDir === 'string') {
        return parsed as InstallReceipt
      }
    } catch {
      // silent-ok: a stray brace-led log line is not the receipt; keep scanning upward
    }
  }
  throw new Error(`The installer finished without a receipt. Last output:\n${lines.slice(-8).join('\n')}`)
}

/** Paths to the installer script and server VERSION file staged beside the desktop's own server bundle. */
export interface BootstrapAssets {
  installerPath: string
  serverVersion: string
  /** True for a development desktop: no release of this server version exists, so a locally packaged bundle is shipped instead. */
  isDev: boolean
  /** Repo root for a development desktop (where `build/deploy` lives). */
  repoRoot: string | null
}

/** Where the desktop's own server bundle, installer, VERSION, and (for a local build) DEV_ROOT are staged. */
export function packagedServerDir(): string {
  return join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'server')
}

export function resolveBootstrapAssets(): BootstrapAssets {
  if (app.isPackaged) {
    const dir = packagedServerDir()
    const installerPath = join(dir, 'install-studio-server.sh')
    const serverVersion = readFileSync(join(dir, 'VERSION'), 'utf-8').trim()
    const devRootFile = join(dir, 'DEV_ROOT')
    if (existsSync(devRootFile)) {
      const repoRoot = readFileSync(devRootFile, 'utf-8').trim()
      log('bootstrap assets: packaged development desktop', { server_version: serverVersion, repo_root: repoRoot })
      return { installerPath, serverVersion, isDev: true, repoRoot }
    }
    log('bootstrap assets: released desktop', { server_version: serverVersion })
    return { installerPath, serverVersion, isDev: false, repoRoot: null }
  }
  const repoRoot = join(app.getAppPath(), '..')
  return {
    installerPath: join(repoRoot, 'scripts', 'install-studio-server.sh'),
    serverVersion: readFileSync(join(repoRoot, 'server', 'VERSION'), 'utf-8').trim(),
    isDev: true,
    repoRoot,
  }
}

export interface InstallOnHostOptions {
  dest: SshDestination
  platform: HostPlatform
  assets: BootstrapAssets
  /** Extra `ion studio install` flags (label, tenancy, --system). */
  installArgs?: string[]
  onLine?: (line: string) => void
  spawn?: SshSpawn
  /** Injectable `scp`-equivalent for the dev bundle copy (defaults to `scp` via spawn). */
  copyToHost?: (dest: SshDestination, localPath: string, remotePath: string) => Promise<void>
  /** Injectable bundle build for a development desktop (defaults to `make package-studio-server` in the repo). */
  packageBundle?: (repoRoot: string, platform: HostPlatform, onLine: (line: string) => void) => Promise<void>
}

/**
 * Packages the Studio server bundle for `platform` from the development
 * repo: `make package-studio-server GOOS=<goos> GOARCH=<goarch>`, which
 * writes `build/deploy/ion-studio-server-<goos>-<goarch>.tar.gz`. Every
 * output line is forwarded so the operator watches the build in the dialog
 * rather than a silent minute. The build runs through the operator's login
 * shell, since a packaged desktop's own PATH has no `go`: the login shell is
 * the one place that carries the PATH their toolchain is actually on. The
 * arguments are fixed identifiers (a validated goos/goarch), never input.
 */
async function defaultPackageBundle(repoRoot: string, platform: HostPlatform, onLine: (line: string) => void): Promise<void> {
  const args = ['package-studio-server', `GOOS=${platform.goos}`, `GOARCH=${platform.goarch}`]
  log('packaging dev bundle', { repo_root: repoRoot, goos: platform.goos, goarch: platform.goarch })
  await new Promise<void>((resolve, reject) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const child = nodeSpawn(shell, ['-lc', `make ${args.join(' ')}`], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    let tail = ''
    const forward = (chunk: Buffer): void => {
      for (const line of chunk.toString('utf-8').split('\n')) {
        const trimmed = line.trimEnd()
        if (!trimmed) continue
        tail = `${tail}\n${trimmed}`.split('\n').slice(-8).join('\n')
        onLine(trimmed)
      }
    }
    child.stdout?.on('data', forward)
    child.stderr?.on('data', forward)
    child.on('error', (err) => reject(new Error(`Could not start make in ${repoRoot}: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        log('dev bundle packaged', { repo_root: repoRoot, goos: platform.goos, goarch: platform.goarch })
        resolve()
      } else {
        warn('dev bundle packaging failed', { repo_root: repoRoot, exit_code: code, tail })
        reject(new Error(`make package-studio-server GOOS=${platform.goos} GOARCH=${platform.goarch} failed in ${repoRoot} (exit ${code}):${tail}`))
      }
    })
  })
}

/** `scp` a local file to the host. Uses the same batch options as every ssh call. */
async function defaultCopyToHost(dest: SshDestination, localPath: string, remotePath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = [...sshBaseArgs(dest, 'scp')]
    args.push(localPath, `${dest.destination}:${remotePath}`)
    const child = nodeSpawn('scp', args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer) => { stderr += c.toString('utf-8') })
    child.on('error', (err) => reject(new SshError('spawn_failed', `Could not start scp: ${err.message}`)))
    child.on('close', (code) => (code === 0 ? resolve() : reject(new SshError('remote_failed', `scp to ${dest.destination} failed (exit ${code}):\n${stderr.trim()}`, code))))
  })
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Runs the installer on the host and returns its receipt. Every installer
 * line is forwarded to `onLine` for the dialog's progress list.
 */
export async function installOnHost(opts: InstallOnHostOptions): Promise<InstallReceipt> {
  const { dest, platform, assets } = opts
  const installer = readFileSync(assets.installerPath, 'utf-8')
  const env: string[] = []
  if (assets.isDev) {
    const asset = `ion-studio-server-${platform.goos}-${platform.goarch}.tar.gz`
    if (!assets.repoRoot || !existsSync(assets.repoRoot)) {
      throw new Error(`This is a development desktop, but its repository ${assets.repoRoot ?? '(unknown)'} is not on this machine, so the server bundle cannot be packaged. Rebuild the desktop from a checkout that exists.`)
    }
    const local = join(assets.repoRoot, 'build', 'deploy', asset)
    opts.onLine?.(`This is a development desktop: packaging ${asset} from ${assets.repoRoot}`)
    await (opts.packageBundle ?? defaultPackageBundle)(assets.repoRoot, platform, (line) => opts.onLine?.(line))
    if (!existsSync(local)) {
      throw new Error(`make package-studio-server finished but wrote no bundle at ${local}.`)
    }
    const remote = `${platform.home}/.ion/studio-server/incoming/${asset}`
    opts.onLine?.(`copying ${asset} to the host`)
    await runSsh({ dest, command: `mkdir -p ${REMOTE_INCOMING_DIR}`, spawn: opts.spawn })
    await (opts.copyToHost ?? defaultCopyToHost)(dest, local, remote)
    env.push(`ION_STUDIO_BUNDLE=${shellQuote(remote)}`)
    log('dev bundle copied to host', { destination: dest.destination, asset })
  } else {
    env.push(`ION_STUDIO_VERSION=${shellQuote(assets.serverVersion)}`)
  }
  if (opts.installArgs && opts.installArgs.length > 0) {
    env.push(`ION_STUDIO_INSTALL_ARGS=${shellQuote(opts.installArgs.join(' '))}`)
  }
  const command = `${env.join(' ')} sh -s`
  log('installer piped to host', { destination: dest.destination, dev: assets.isDev, server_version: assets.serverVersion, install_args: opts.installArgs ?? [] })
  const result = await runSsh({
    dest,
    command,
    stdin: installer,
    onStdoutLine: opts.onLine,
    onStderrLine: opts.onLine,
    spawn: opts.spawn,
  })
  const receipt = parseInstallReceipt(result.stdout)
  log('installer receipt', { destination: dest.destination, ...receipt })
  return receipt
}

/** What `ion studio pair --json` prints. */
export interface MintedPairingLink {
  url: string
  code: string
  expiresAt: number
}

export function parseMintedLink(stdout: string): MintedPairingLink {
  const lines = stdout.trim().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line) as Partial<MintedPairingLink>
      if (typeof parsed.url === 'string' && typeof parsed.code === 'string') return { url: parsed.url, code: parsed.code, expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : 0 }
    } catch {
      // silent-ok: not the JSON line; keep scanning
    }
  }
  throw new Error(`ion studio pair did not print a pairing link. Output:\n${lines.slice(-6).join('\n')}`)
}

/** Scopes the door requests: the defaults plus admin, since the desktop that installed the host administers it. */
export const SSH_DOOR_SCOPES = ['conversations:read', 'conversations:operate', 'terminal:operate', 'git:write', 'admin']

export async function mintPairingLink(dest: SshDestination, clientLabel: string, spawn?: SshSpawn): Promise<MintedPairingLink> {
  const command = `${REMOTE_ION_BIN} studio pair --json --label ${shellQuote(clientLabel)} --scopes ${SSH_DOOR_SCOPES.join(',')}`
  const result = await runSsh({ dest, command, spawn })
  const link = parseMintedLink(result.stdout)
  log('pairing link minted on host', { destination: dest.destination, code_length: link.code.length })
  if (!link.code) warn('minted link carries an empty code', { destination: dest.destination })
  return link
}
