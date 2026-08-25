import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { app } from 'electron'
import { join } from 'node:path'
import { log as _log, warn as _warn } from './logger'

function log(message: string, fields?: Record<string, unknown>): void {
  _log('instance-guard', message, fields)
}

function warn(message: string, fields?: Record<string, unknown>): void {
  _warn('instance-guard', message, fields)
}

export interface RunningIon {
  pid: number
  source: 'pid_file' | 'process_scan'
}

function isLiveForeignPid(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Find a live Ion that predates this process, including legacy releases. */
export function detectRunningIon(): RunningIon | null {
  const pidPath = join(app.getPath('userData'), 'ion.pid')
  try {
    if (existsSync(pidPath)) {
      const pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10)
      if (isLiveForeignPid(pid)) {
        log('instance guard found live Ion from pid file', { pid, pid_path: pidPath })
        return { pid, source: 'pid_file' }
      }
    }
  } catch (err) {
    warn('instance guard could not read pid file', { pid_path: pidPath, error: String(err) })
  }

  try {
    const output = execFileSync('pgrep', ['-f', 'Ion.app/Contents/MacOS/Ion$'], { encoding: 'utf8' })
    for (const value of output.split(/\s+/)) {
      const pid = Number.parseInt(value, 10)
      if (isLiveForeignPid(pid)) {
        log('instance guard found live Ion from process scan', { pid })
        return { pid, source: 'process_scan' }
      }
    }
  } catch (err) {
    const code = (err as { status?: number }).status
    if (code !== 1) warn('instance guard process scan failed', { error: String(err) })
  }
  return null
}
