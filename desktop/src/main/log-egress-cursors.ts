/**
 * log-egress-cursors.ts — persistent inode-aware tail cursors for egress tailers.
 *
 * Cursors are stored atomically at ~/.ion/.egress-cursors.json. Each entry tracks
 * the byte offset and a fileId (inode stringified, or size-only fallback on
 * platforms where stat().ino is unreliable).
 *
 * Shape on disk:
 *   { "/abs/path": { offset: number, fileId: string } }
 *
 * Lifecycle:
 *   - loadCursors() at startup: restores offsets from the last flush.
 *   - saveCursors() after each successful ship pass: durable progress.
 *   - On rename-rotation: the tailer detects the inode change and resets the
 *     cursor to { offset: 0, fileId: <new inode> } before calling saveCursors.
 *
 * At-least-once contract: there is a small window between a successful ship
 * and the next saveCursors call. On crash, the cursor points before the shipped
 * data → duplicates possible on restart. Telemetry lines carry event_id (R22)
 * so downstream dedup is available; operational log lines tolerate duplicates.
 */

import { statSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWriteFileSync } from './utils/atomicWrite'
import { log as _log } from './logger'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('log_egress_cursors', msg, fields)
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CursorEntry {
  /** Byte offset into the file. */
  offset: number
  /**
   * File identity: the inode number stringified (bigint → string).
   * On platforms or filesystems where ino is 0 / unreliable, falls back to
   * a size-based token ("size:<N>"). The tailer uses this to detect renames:
   * a new inode means a new file was created at the path.
   */
  fileId: string
}

export type CursorMap = Record<string, CursorEntry>

// ---------------------------------------------------------------------------
// Disk I/O
// ---------------------------------------------------------------------------

const CURSOR_FILE = join(homedir(), '.ion', '.egress-cursors.json')

/** Load cursor map from disk. Returns empty map on any read/parse error. */
export function loadCursors(): CursorMap {
  try {
    const fs = require('fs') as typeof import('fs')
    const raw = fs.readFileSync(CURSOR_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      log('cursors loaded', { path: CURSOR_FILE, count: Object.keys(parsed).length })
      return parsed as CursorMap
    }
  } catch {
    // Absent or corrupt — start fresh.
  }
  return {}
}

/** Persist cursor map atomically. Errors are logged but not thrown. */
export function saveCursors(cursors: CursorMap): void {
  try {
    atomicWriteFileSync(CURSOR_FILE, JSON.stringify(cursors, null, 2), 0o644)
  } catch (err) {
    log('cursor save failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// File identity
// ---------------------------------------------------------------------------

/**
 * Compute a fileId for the file at path.
 * Returns ino stringified when ino is non-zero, otherwise falls back to
 * "size:<bytes>". Returns "" on stat failure.
 */
export function fileIdForPath(path: string): string {
  try {
    const info = statSync(path)
    const ino = info.ino
    if (typeof ino === 'bigint' ? ino !== 0n : ino !== 0) {
      return String(ino)
    }
    return `size:${info.size}`
  } catch {
    return ''
  }
}

/**
 * Compute a fileId for an already-opened file descriptor.
 * Uses fstatSync so there is no TOCTOU race between open() and fstat().
 */
export function fileIdForFd(fd: number): string {
  try {
    const fs = require('fs') as typeof import('fs')
    const info = fs.fstatSync(fd)
    const ino = info.ino
    if (typeof ino === 'bigint' ? ino !== 0n : ino !== 0) {
      return String(ino)
    }
    return `size:${info.size}`
  } catch {
    return ''
  }
}
