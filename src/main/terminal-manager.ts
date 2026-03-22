import { IPC } from '../shared/types'
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

  create(tabId: string, cwd: string): void {
    if (this.sessions.has(tabId)) return

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
      env: { ...process.env } as Record<string, string>,
    })

    term.onData((data: string) => {
      this.broadcast(IPC.TERMINAL_INCOMING, tabId, data)
    })

    term.onExit(({ exitCode }: { exitCode: number }) => {
      this.sessions.delete(tabId)
      this.broadcast(IPC.TERMINAL_EXIT, tabId, exitCode)
    })

    this.sessions.set(tabId, term)
  }

  write(tabId: string, data: string): void {
    this.sessions.get(tabId)?.write(data)
  }

  resize(tabId: string, cols: number, rows: number): void {
    try {
      this.sessions.get(tabId)?.resize(cols, rows)
    } catch {
      // Ignore resize errors on dead PTYs
    }
  }

  destroy(tabId: string): void {
    const term = this.sessions.get(tabId)
    if (term) {
      this.sessions.delete(tabId)
      try {
        term.kill()
      } catch {
        // Already dead
      }
    }
  }

  destroyAll(): void {
    for (const tabId of this.sessions.keys()) {
      this.destroy(tabId)
    }
  }
}
