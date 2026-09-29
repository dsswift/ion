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
    for (const pid of scanIonProcesses()) {
      if (isLiveForeignPid(pid)) {
        log('instance guard found live Ion from process scan', { pid })
        return { pid, source: 'process_scan' }
      }
    }
  } catch (err) {
    // pgrep exits 1 when nothing matched; that is an answer, not a failure.
    const code = (err as { status?: number }).status
    if (code !== 1) warn('instance guard process scan failed', { error: String(err) })
  }
  return null
}

/**
 * Every Ion process the platform's own process lister can see, by pid.
 * darwin asks pgrep for the app bundle's executable; win32 has no pgrep and
 * asks tasklist for Ion.exe, whose CSV rows carry the pid in the second
 * column and whose "no tasks" answer is an unquoted sentence that matches
 * nothing. Exported for testing.
 */
export function scanIonProcesses(platform: NodeJS.Platform = process.platform): number[] {
  if (platform === 'win32') {
    const output = execFileSync('tasklist.exe', ['/FI', 'IMAGENAME eq Ion.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return [...output.matchAll(/^"Ion\.exe","(\d+)"/gm)].map((m) => Number.parseInt(m[1], 10))
  }
  const output = execFileSync('pgrep', ['-f', 'Ion.app/Contents/MacOS/Ion$'], { encoding: 'utf8' })
  return output.split(/\s+/).map((value) => Number.parseInt(value, 10)).filter((pid) => Number.isSafeInteger(pid))
}
