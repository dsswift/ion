import { IPC } from '../shared/types'
import { getCliEnv } from './cli-env'
import { homedir } from 'os'
import type { IPty } from 'node-pty'

// node-pty is a native module — require at runtime to avoid Vite bundling issues
let pty: typeof import('node-pty')
try {
  pty = require('node-pty')
} catch {
  // Will fail at create() time, not import time
}

export class TerminalManager {
  private sessions = new Map<string, IPty>()
  private broadcast: (channel: string, ...args: unknown[]) => void

  constructor(broadcast: (channel: string, ...args: unknown[]) => void) {
    this.broadcast = broadcast
  }

  create(key: string, cwd: string): void {
    if (this.sessions.has(key)) return

    if (!pty) {
      throw new Error('node-pty is not available')
    }

    const resolvedCwd = cwd === '~' ? homedir() : cwd
    const shell = process.env.SHELL || '/bin/zsh'

    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: getCliEnv() as Record<string, string>,
    })

    term.onData((data: string) => {
      this.broadcast(IPC.TERMINAL_INCOMING, key, data)
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(key)
      this.broadcast(IPC.TERMINAL_EXIT, key, exitCode)
    })

    this.sessions.set(key, term)
  }

  write(key: string, data: string): void {
    this.sessions.get(key)?.write(data)
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
