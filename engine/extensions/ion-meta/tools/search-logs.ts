// ion_search_logs tool -- search or tail engine/desktop/harness/iOS logs.
//
// Four log files are supported:
//   engine   -> ~/.ion/engine.log   (~19MB at time of writing, 118K lines)
//   desktop  -> ~/.ion/desktop.log  (~556KB)
//   harness  -> ~/.ion/harness.log  (~53KB)
//   ios      -> ~/.ion/ios-diagnostic-logs.txt (~53KB)
//
// Three modes:
//   tail  -- return the last N lines of the file. Reads from the end of
//            the file (last 512KB chunk), so the 19MB engine.log is safe.
//   grep  -- stream the file in 64KB chunks, scan for a plain-string
//            pattern, collect up to `limit` matching lines, stop early.
//   level -- same as grep but matches `[LEVEL]` prefix tokens in the
//            engine/desktop log format.
//
// Security model:
//   - No caller-supplied path segments ever reach the OS. The four log
//     files map to hardcoded absolute paths.
//   - Pattern is a plain substring match (case-insensitive). No regex.
//     This eliminates ReDoS and keeps the tool deterministic.
//
// All tools are planModeSafe: true (read-only).

import { existsSync, openSync, readSync, statSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ToolDef } from '../../sdk/ion-sdk'

// ─── Parameter types ──────────────────────────────────────────────────────

interface SearchLogsParams {
  /** Which log file to read. Default `"engine"`. */
  log?: 'engine' | 'desktop' | 'harness' | 'ios'
  /** Mode:
   *  - `tail` (default): return the last `lines` lines.
   *  - `grep`: stream the file, return lines containing `pattern`.
   *  - `level`: return the most recent lines matching the given `level`. */
  mode?: 'tail' | 'grep' | 'level'
  /** For `tail` mode. Default 50. Capped at 200. */
  lines?: number
  /** For `grep` mode. Plain string (not regex), case-insensitive. Required when mode=grep. */
  pattern?: string
  /** For `level` mode. One of ERROR, WARN, INFO, DEBUG. Required when mode=level. */
  level?: 'ERROR' | 'WARN' | 'INFO' | 'DEBUG'
  /** Optional session key to additionally filter lines. Applied after the primary filter. */
  sessionKey?: string
  /** For `grep`/`level` mode. Max matching lines. Default 30. Capped at 100. */
  limit?: number
}

// ─── Log file resolution ─────────────────────────────────────────────────

const LOG_FILES: Record<NonNullable<SearchLogsParams['log']>, string> = {
  engine:  join(homedir(), '.ion', 'engine.log'),
  desktop: join(homedir(), '.ion', 'desktop.log'),
  harness: join(homedir(), '.ion', 'harness.log'),
  ios:     join(homedir(), '.ion', 'ios-diagnostic-logs.txt'),
}

// ─── Tail implementation ──────────────────────────────────────────────────

const TAIL_READ_BYTES = 512 * 1024 // 512 KB from end -- enough for ~200+ lines

/**
 * Read the last `maxLines` lines from a file without loading the whole thing.
 * Opens the file, seeks to max(0, size - TAIL_READ_BYTES), reads to end,
 * splits on newlines, returns the trailing `maxLines` non-empty lines.
 */
function tailFile(filePath: string, maxLines: number): string[] {
  const stat = statSync(filePath)
  const size = stat.size
  const readFrom = Math.max(0, size - TAIL_READ_BYTES)
  const readLen = size - readFrom

  const buf = Buffer.alloc(readLen)
  const fd = openSync(filePath, 'r')
  try {
    readSync(fd, buf, 0, readLen, readFrom)
  } finally {
    closeSync(fd)
  }

  const text = buf.toString('utf8')
  const lines = text.split('\n').filter(l => l.trim().length > 0)

  // If we didn't read from the start, the very first line may be truncated;
  // drop it only when we didn't read from byte 0.
  if (readFrom > 0 && lines.length > 0) lines.shift()

  return lines.slice(-maxLines)
}

// ─── Grep / level implementation ──────────────────────────────────────────

const GREP_CHUNK_BYTES = 64 * 1024 // 64 KB per read chunk

/**
 * Stream a file in chunks, collect lines matching `matchFn` up to
 * `maxMatches`. Returns early once `maxMatches` is reached.
 *
 * Handles the edge case where a newline straddles a chunk boundary by
 * carrying a partial line across reads.
 */
function grepFile(
  filePath: string,
  matchFn: (line: string) => boolean,
  maxMatches: number,
): string[] {
  const stat = statSync(filePath)
  const size = stat.size
  const matches: string[] = []

  const fd = openSync(filePath, 'r')
  try {
    const buf = Buffer.alloc(GREP_CHUNK_BYTES)
    let offset = 0
    let carry = ''

    while (offset < size && matches.length < maxMatches) {
      const bytesToRead = Math.min(GREP_CHUNK_BYTES, size - offset)
      const bytesRead = readSync(fd, buf, 0, bytesToRead, offset)
      if (bytesRead === 0) break
      offset += bytesRead

      const chunk = carry + buf.slice(0, bytesRead).toString('utf8')
      const lines = chunk.split('\n')

      // The last element may be incomplete (no trailing newline yet).
      carry = lines.pop() ?? ''

      for (const line of lines) {
        if (line.trim().length === 0) continue
        if (matchFn(line)) {
          matches.push(line)
          if (matches.length >= maxMatches) break
        }
      }
    }

    // Process any remaining carry after EOF.
    if (carry.trim().length > 0 && matches.length < maxMatches && matchFn(carry)) {
      matches.push(carry)
    }
  } finally {
    closeSync(fd)
  }

  return matches
}

// ─── Public API ───────────────────────────────────────────────────────────

export function searchLogs(
  params: SearchLogsParams,
): { content: string; isError?: boolean } {
  const logKey = params.log ?? 'engine'
  const filePath = LOG_FILES[logKey]
  const mode = params.mode ?? 'tail'
  const sessionKey = params.sessionKey ?? null

  if (!existsSync(filePath)) {
    return {
      content: JSON.stringify({
        error: `Log file not found: ${filePath}`,
        log: logKey,
        path: filePath,
      }, null, 2),
      isError: true,
    }
  }

  let sizeBytes: number
  try {
    sizeBytes = statSync(filePath).size
  } catch (err) {
    return { content: `stat failed: ${(err as Error).message}`, isError: true }
  }

  // ── Tail mode ────────────────────────────────────────────────────────────

  if (mode === 'tail') {
    const maxLines = Math.min(200, Math.max(1, params.lines ?? 50))
    let lines: string[]
    try {
      lines = tailFile(filePath, maxLines)
    } catch (err) {
      return { content: `tail failed: ${(err as Error).message}`, isError: true }
    }

    // Apply optional sessionKey filter after tail.
    if (sessionKey) {
      lines = lines.filter(l => l.includes(sessionKey))
    }

    return {
      content: JSON.stringify({
        log: logKey,
        path: filePath,
        sizeBytes,
        mode: 'tail',
        requestedLines: maxLines,
        returnedLines: lines.length,
        ...(sessionKey ? { sessionKey } : {}),
        lines,
      }, null, 2),
    }
  }

  // ── Grep mode ─────────────────────────────────────────────────────────────

  if (mode === 'grep') {
    if (!params.pattern || params.pattern.trim().length === 0) {
      return {
        content: 'mode=grep requires a non-empty `pattern` parameter.',
        isError: true,
      }
    }
    const needle = params.pattern.toLowerCase()
    const maxMatches = Math.min(100, Math.max(1, params.limit ?? 30))

    const matchFn = (line: string): boolean => {
      const lower = line.toLowerCase()
      if (!lower.includes(needle)) return false
      if (sessionKey && !line.includes(sessionKey)) return false
      return true
    }

    let matches: string[]
    try {
      matches = grepFile(filePath, matchFn, maxMatches)
    } catch (err) {
      return { content: `grep failed: ${(err as Error).message}`, isError: true }
    }

    return {
      content: JSON.stringify({
        log: logKey,
        path: filePath,
        sizeBytes,
        mode: 'grep',
        pattern: params.pattern,
        ...(sessionKey ? { sessionKey } : {}),
        matchCount: matches.length,
        capped: matches.length >= maxMatches,
        lines: matches,
      }, null, 2),
    }
  }

  // ── Level mode ────────────────────────────────────────────────────────────

  if (mode === 'level') {
    const levelValues = ['ERROR', 'WARN', 'INFO', 'DEBUG'] as const
    type LevelVal = typeof levelValues[number]
    const requestedLevel = params.level as LevelVal | undefined
    if (!requestedLevel || !levelValues.includes(requestedLevel)) {
      return {
        content: `mode=level requires a \`level\` parameter: one of ${levelValues.join(', ')}.`,
        isError: true,
      }
    }

    // Engine log format: `[HH:MM:SS] [LEVEL] [Component] message`
    // Desktop log format: `[ISO-8601] [LEVEL] [component] message`
    // Both embed `[LEVEL]` as a bracket-enclosed token.
    const levelToken = `[${requestedLevel}]`
    const maxMatches = Math.min(100, Math.max(1, params.limit ?? 30))

    const matchFn = (line: string): boolean => {
      if (!line.includes(levelToken)) return false
      if (sessionKey && !line.includes(sessionKey)) return false
      return true
    }

    let matches: string[]
    try {
      matches = grepFile(filePath, matchFn, maxMatches)
    } catch (err) {
      return { content: `level filter failed: ${(err as Error).message}`, isError: true }
    }

    return {
      content: JSON.stringify({
        log: logKey,
        path: filePath,
        sizeBytes,
        mode: 'level',
        level: requestedLevel,
        ...(sessionKey ? { sessionKey } : {}),
        matchCount: matches.length,
        capped: matches.length >= maxMatches,
        lines: matches,
      }, null, 2),
    }
  }

  return { content: `Unknown mode: ${JSON.stringify(mode)}. Use tail, grep, or level.`, isError: true }
}

// ─── ToolDef ──────────────────────────────────────────────────────────────

export const searchLogsTool: ToolDef = {
  name: 'ion_search_logs',
  description:
    'Search or tail engine/desktop/harness/iOS log files from `~/.ion/`. ' +
    'Logs: `engine` (engine.log, ~19MB), `desktop` (desktop.log), `harness` (harness.log), `ios` (ios-diagnostic-logs.txt). ' +
    'Modes: `tail` (last N lines, default), `grep` (substring search — never regex), `level` (filter by ERROR/WARN/INFO/DEBUG). ' +
    'Optionally add `sessionKey` to further filter to a specific session. ' +
    'Never reads the full file — tail reads from the end, grep/level stream in 64KB chunks.',
  planModeSafe: true,
  parameters: {
    type: 'object',
    properties: {
      log: {
        type: 'string',
        enum: ['engine', 'desktop', 'harness', 'ios'],
        description: 'Which log file. Default `engine`.',
      },
      mode: {
        type: 'string',
        enum: ['tail', 'grep', 'level'],
        description: '`tail` (default): return last N lines. `grep`: substring search. `level`: filter by log level.',
      },
      lines: {
        type: 'number',
        description: 'For `tail` mode. Default 50. Capped at 200.',
      },
      pattern: {
        type: 'string',
        description: 'For `grep` mode. Plain string, case-insensitive. Do not use regex syntax.',
      },
      level: {
        type: 'string',
        enum: ['ERROR', 'WARN', 'INFO', 'DEBUG'],
        description: 'For `level` mode. Filter to lines containing `[LEVEL]`.',
      },
      sessionKey: {
        type: 'string',
        description: 'Optional. Further filter results to lines containing this session key.',
      },
      limit: {
        type: 'number',
        description: 'For `grep`/`level` mode. Max matching lines to return. Default 30. Capped at 100.',
      },
    },
  },
  execute: (params: SearchLogsParams) => Promise.resolve(searchLogs(params)),
}
