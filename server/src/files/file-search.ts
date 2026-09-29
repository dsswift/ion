/**
 * Project file search — the source behind the composer's `@file` mentions.
 *
 * Inside a git checkout the candidate set is what git itself considers part of
 * the project: tracked files plus untracked files that are not ignored. That
 * is one `git ls-files` call, fast enough to run per search, so there is no
 * cache to go stale when a file is added or a branch switches. Outside a git
 * checkout the set comes from a bounded directory walk.
 *
 * Matching is a subsequence match scored so that the results a person expects
 * come first: a hit in the file name beats a hit in a directory, a hit at the
 * start of a path segment beats one mid-word, and a contiguous run beats a
 * scattered one.
 */
import { readdirSync } from 'fs'
import { join, relative, sep } from 'path'
import { isValidProjectPath } from '../ipc-validation'
import { runGit } from '../git/git-runner'
import { debug as _debug, log as _log, warn as _warn } from '../logger'

const TAG = 'file-search'

export const FILE_SEARCH_DEFAULT_LIMIT = 50
export const FILE_SEARCH_MAX_LIMIT = 200
const MAX_QUERY_LENGTH = 256
/** Walk bounds for a directory that is not a git checkout. */
const WALK_MAX_FILES = 20_000
const WALK_MAX_DEPTH = 12
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn'])

export interface FileSearchResult {
  /** Paths relative to the searched directory, forward-slashed, best first. */
  files: string[]
  /** Where the candidate set came from. */
  source: 'git' | 'walk'
  /** True when the walk stopped at its bound before seeing everything. */
  truncated: boolean
  error?: string
}

/** True when the character at `at` starts a word: after a separator, or a camelCase hump. */
function startsWord(text: string, at: number): boolean {
  if (at === 0) return true
  const before = text[at - 1]
  if (before === '/' || before === '.' || before === '-' || before === '_' || before === ' ') return true
  const ch = text[at]
  return ch !== ch.toLowerCase() && before === before.toLowerCase()
}

/** Leftmost subsequence match of `needle` in `text` from `start`; null when it does not fit. */
function subsequenceScore(text: string, needle: string, start: number): number | null {
  const hay = text.toLowerCase()
  let score = 0
  let from = start
  let previous = -2
  for (const ch of needle) {
    const at = hay.indexOf(ch, from)
    if (at === -1) return null
    score += 1
    if (at === previous + 1) score += 3
    if (startsWord(text, at)) score += 4
    previous = at
    from = at + 1
  }
  return score
}

/**
 * Score `path` against `query`, or null when `query` is not a subsequence.
 * Higher is better. Pure; exported for the ordering tests.
 */
export function scoreFileMatch(path: string, query: string): number | null {
  if (query.length === 0) return 0
  const needle = query.toLowerCase()
  const baseStart = path.lastIndexOf('/') + 1
  // A match that fits wholly inside the file name is tried first and favored:
  // the file name is what the operator is almost always typing.
  const inName = subsequenceScore(path, needle, baseStart)
  const anywhere = inName === null ? subsequenceScore(path, needle, 0) : null
  if (inName === null && anywhere === null) return null
  let score = inName !== null ? inName + 10 : (anywhere as number)
  if (path.slice(baseStart).toLowerCase().includes(needle)) score += 12
  // Among equals, the shallower and shorter path wins.
  return score - path.length / 200
}

/** Rank `candidates` against `query`; an empty query keeps the given order. */
export function rankFiles(candidates: readonly string[], query: string, limit: number): string[] {
  if (query.length === 0) return candidates.slice(0, limit)
  const scored: Array<{ path: string; score: number }> = []
  for (const path of candidates) {
    const score = scoreFileMatch(path, query)
    if (score !== null) scored.push({ path, score })
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, limit).map((entry) => entry.path)
}

export function walkFiles(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = []
  let truncated = false
  const visit = (dir: string, depth: number): void => {
    if (truncated) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      _debug(TAG, 'walk skipped an unreadable directory', { directory: dir, error: String(err) })
      return
    }
    for (const entry of entries) {
      if (files.length >= WALK_MAX_FILES) { truncated = true; return }
      if (entry.isDirectory()) {
        if (WALK_SKIP_DIRS.has(entry.name) || depth >= WALK_MAX_DEPTH) continue
        visit(join(dir, entry.name), depth + 1)
      } else if (entry.isFile()) {
        files.push(relative(root, join(dir, entry.name)).split(sep).join('/'))
      }
    }
  }
  visit(root, 0)
  return { files, truncated }
}

async function listCandidates(directory: string): Promise<{ files: string[]; source: 'git' | 'walk'; truncated: boolean }> {
  try {
    // -z keeps a path with unusual characters intact instead of C-quoting it.
    const out = await runGit(directory, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    return { files: out.split('\0').filter(Boolean), source: 'git', truncated: false }
  } catch (err) {
    _debug(TAG, 'not a git checkout; walking the directory instead', { directory, error: String(err) })
    return { ...walkFiles(directory), source: 'walk' }
  }
}

export async function searchFiles(payload: unknown): Promise<FileSearchResult> {
  const request = (payload ?? {}) as { directory?: unknown; query?: unknown; limit?: unknown }
  const directory = typeof request.directory === 'string' ? request.directory : ''
  const query = typeof request.query === 'string' ? request.query.slice(0, MAX_QUERY_LENGTH) : ''
  const limit = Math.min(FILE_SEARCH_MAX_LIMIT, Math.max(1, typeof request.limit === 'number' ? Math.floor(request.limit) : FILE_SEARCH_DEFAULT_LIMIT))
  if (!isValidProjectPath(directory)) {
    _warn(TAG, 'search refused: invalid directory', { directory_length: directory.length })
    return { files: [], source: 'walk', truncated: false, error: 'Invalid path' }
  }
  const started = Date.now()
  const candidates = await listCandidates(directory)
  const files = rankFiles(candidates.files, query, limit)
  _log(TAG, 'search complete', {
    directory,
    query_length: query.length,
    source: candidates.source,
    candidates: candidates.files.length,
    returned: files.length,
    truncated: candidates.truncated,
    duration_ms: Date.now() - started,
  })
  return { files, source: candidates.source, truncated: candidates.truncated }
}
