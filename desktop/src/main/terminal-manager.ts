import { IPC } from '../shared/types'
import { getCliEnv } from './cli-env'
import { getDeepLinkToken } from './deeplink/token'
import { homedir } from 'os'
import { basename } from 'path'
import { existsSync } from 'fs'
import { terminalScrollback } from './state'
import { debug as _debug } from './logger'
import type { IPty } from 'node-pty'

function debug(msg: string, fields?: Record<string, unknown>): void {
  _debug('terminal', msg, fields)
}

/**
 * Split a terminal key into its tab and instance ids.
 *
 * Keys are `"<tabId>:<instanceId>"`. Split on the FIRST colon only: a tab id is
 * a UUID today, but an instance id must never be able to swallow part of a tab
 * id if either format ever gains one.
 */
function splitTerminalKey(key: string): [tabId: string, instanceId: string] {
  const sep = key.indexOf(':')
  if (sep < 0) return [key, '']
  return [key.slice(0, sep), key.slice(sep + 1)]
}

// node-pty is a native module — require at runtime to avoid Vite bundling issues
let pty: typeof import('node-pty')
try {
  pty = require('node-pty')
} catch {
  // Will fail at create() time, not import time
}

/**
 * The `pty.spawn` surface this manager uses.
 *
 * Declared so a test can supply a spawner and observe the environment a PTY
 * would be created with. node-pty is a real native module that loads fine under
 * vitest, so without this seam a test would spawn actual shells and could not
 * inspect the spawn arguments at all.
 */
export type PtySpawner = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => IPty

/** Read node-pty's foreground-process title without spawning a subprocess. */
export type ProcessProbe = (term: Pick<IPty, 'process'>, shell: string) => boolean

function hasForegroundChildProcess(term: Pick<IPty, 'process'>, shell: string): boolean {
  return basename(term.process) !== basename(shell)
}

export class TerminalManager {
  private sessions = new Map<string, IPty>()
  private activeKeys = new Set<string>()
  private activityTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private broadcast: (channel: string, ...args: unknown[]) => void
  private spawner: PtySpawner | null
  private processProbe: ProcessProbe

  constructor(broadcast: (channel: string, ...args: unknown[]) => void, spawner?: PtySpawner, processProbe?: ProcessProbe) {
    this.broadcast = broadcast
    this.processProbe = processProbe ?? hasForegroundChildProcess
    // Production passes nothing and gets node-pty; tests inject a spy.
    this.spawner = spawner ?? null
  }

  create(key: string, cwd: string): void {
    if (this.sessions.has(key)) return

    const spawn = this.spawner ?? (pty ? pty.spawn : null)
    if (!spawn) {
      throw new Error('node-pty is not available')
    }

    const resolvedCwd = (() => {
      const p = cwd === '~' ? homedir() : cwd
      return existsSync(p) ? p : homedir()
    })()
    const shell = process.env.SHELL || '/bin/zsh'

    // Conversation identity, injected into the PTY environment.
    //
    // This is what lets `dev run` (or any tool) open a pane in THE CONVERSATION
    // IT WAS RUN FROM rather than in whichever tab happens to be focused. Every
    // descendant of this shell inherits these vars, so a tool at any depth can
    // name its own tab, and a pane it spawns carries its own ids in turn.
    //
    // Resolving the target from focus instead would be a heuristic that breaks
    // the moment the operator navigates away — which is precisely the case that
    // matters, since services are launched and then read later.
    //
    // The token is included so a local tool's request is recognised as coming
    // from this machine and does not need a human confirmation. That is not an
    // escalation: anything able to read this PTY's environment can already spawn
    // processes as this user. See deeplink/token.ts.
    const [tabId, instanceId] = splitTerminalKey(key)
    const env = getCliEnv({
      ION_DESKTOP_TAB_ID: tabId,
      ION_DESKTOP_TERMINAL_INSTANCE_ID: instanceId,
      ION_DESKTOP_DEEPLINK_TOKEN: getDeepLinkToken(),
    }) as Record<string, string>

    const term = spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env,
    })

    term.onData((data: string) => {
      this.broadcast(IPC.TERMINAL_INCOMING, key, data)
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(key)
      this.stopActivityWatch(key)
      this.setActivity(key, false)
      this.broadcast(IPC.TERMINAL_EXIT, key, exitCode)
    })

    this.sessions.set(key, term)
    this.startActivityWatch(key, term, shell)
  }

  write(key: string, data: string): void {
    this.sessions.get(key)?.write(data)
  }

  activeTabIds(): string[] {
    return [...new Set([...this.activeKeys].map((key) => splitTerminalKey(key)[0]))]
  }

  private setActivity(key: string, active: boolean): void {
    const wasActive = this.activeKeys.has(key)
    if (active === wasActive) return

    const [tabId] = splitTerminalKey(key)
    const wasTabActive = this.activeTabIds().includes(tabId)
    if (active) this.activeKeys.add(key)
    else this.activeKeys.delete(key)
    const isTabActive = this.activeTabIds().includes(tabId)

    // Renderers show activity per tab. A new active PTY still emits its own
    // identity so observers can associate it with the pane that started it. Do
    // not mark a tab idle while another PTY in that tab has a foreground child
    // process.
    if (!active && wasTabActive === isTabActive) return
    this.broadcast(IPC.TERMINAL_ACTIVITY, { key, tabId, active: isTabActive })
    debug('terminal activity changed', { key, tab_id: tabId, active: isTabActive })
  }

  private startActivityWatch(key: string, term: IPty, shell: string): void {
    this.stopActivityWatch(key)
    const refresh = (): void => {
      if (this.sessions.get(key) !== term) return
      try {
        this.setActivity(key, this.processProbe(term, shell))
      } catch (err: unknown) {
        debug('terminal activity probe failed', { key, error: String(err) })
      }
      if (this.sessions.get(key) === term) {
        this.activityTimers.set(key, setTimeout(refresh, 500))
      }
    }
    refresh()
  }

  private stopActivityWatch(key: string): void {
    const timer = this.activityTimers.get(key)
    if (timer) clearTimeout(timer)
    this.activityTimers.delete(key)
  }

  resize(key: string, cols: number, rows: number): void {
    try {
      this.sessions.get(key)?.resize(cols, rows)
    } catch {
      // Ignore resize errors on dead PTYs
    }
  }

  destroy(key: string): void {
    const term = this.sessions.get(key)
    if (term) {
      this.sessions.delete(key)
      this.stopActivityWatch(key)
      this.setActivity(key, false)
      terminalScrollback.delete(key)
      try {
        term.kill()
      } catch {
        // Already dead
      }
    }
  }

  /** Destroy all PTYs matching a prefix (e.g. "tabId:" destroys all terminals for that tab) */
  destroyByPrefix(prefix: string): void {
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix)) {
        this.destroy(key)
      }
    }
  }

  destroyAll(): void {
    for (const key of this.sessions.keys()) {
      this.destroy(key)
    }
  }
}
