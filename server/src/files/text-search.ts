/**
 * Workspace Search — find literal text across every file in the workspace
 * folders, for the Studio sidebar's Search view.
 *
 * Inside a git checkout the candidate lines come from `git grep`: it is
 * multithreaded, skips binaries, and searches exactly what git considers part
 * of the project (tracked plus untracked-but-not-ignored), which is the same
 * set the `@file` mention search offers. The server already requires git, so
 * this adds no dependency. Outside a checkout a bounded directory walk reads
 * each file instead.
 *
 * Either way every candidate line then goes through the shared
 * `buildLineMatch`, so the ranges a client highlights come from the same
 * matcher on both paths.
 */
import { spawn } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { join } from 'path'
import {
  buildLineMatch,
  TEXT_SEARCH_DEFAULT_MAX_RESULTS,
  TEXT_SEARCH_MAX_RESULTS,
  type TextSearchFileResult,
  type TextSearchOptions,
  type TextSearchResult,
} from '@ion/shared/text-search'
import { isValidProjectPath } from '../ipc-validation'
import { runGit, withGitSlot } from '../git/git-runner'
import { walkFiles } from './file-search'
import { debug as _debug, log as _log, warn as _warn } from '../logger'

const TAG = 'text-search'

const MAX_QUERY_LENGTH = 1000
/** Files larger than this are skipped by the walk; the editor refuses them too. */
const WALK_MAX_FILE_BYTES = 2 * 1024 * 1024
const WALK_READ_CONCURRENCY = 16

interface RootOutcome {
  files: TextSearchFileResult[]
  matches: number
  truncated: boolean
  source: 'git' | 'walk'
}

/** Collects matching lines for one root into per-file groups, stopping at `budget`. */
class RootCollector {
  readonly files: TextSearchFileResult[] = []
  private readonly byPath = new Map<string, TextSearchFileResult>()
  matches = 0

  constructor(
    private readonly root: string,
    private readonly query: string,
    private readonly options: TextSearchOptions,
    private readonly budget: number,
  ) {}

  get full(): boolean {
    return this.matches >= this.budget
  }

  add(relativePath: string, lineNumber: number, text: string): void {
    if (this.full) return
    const match = buildLineMatch(lineNumber, text, this.query, this.options)
    if (!match) return
    let file = this.byPath.get(relativePath)
    if (!file) {
      file = { root: this.root, path: join(this.root, relativePath), relativePath, matches: [] }
      this.byPath.set(relativePath, file)
      this.files.push(file)
    }
    file.matches.push(match)
    this.matches++
  }
}

async function isGitCheckout(root: string): Promise<boolean> {
  try {
    return (await runGit(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'
  } catch (err) {
    _debug(TAG, 'not a git checkout; walking instead', { root, error: String(err) })
    return false
  }
}

/**
 * Stream `git grep` output into the collector. `-z` makes each record
 * `path\0line\0text\n`: a path cannot hold NUL and a line cannot hold a
 * newline, so the parse is exact for any file name. The child is killed as
 * soon as the budget is spent.
 */
function gitGrep(root: string, collector: RootCollector, query: string, options: TextSearchOptions): Promise<{ truncated: boolean }> {
  const args = [
    '--no-optional-locks',
    // Paths relative to the searched directory, whatever the user's config says.
    '-c', 'grep.fullName=false',
    'grep', '-n', '-I', '-z', '--no-color', '--untracked', '-F',
    ...(options.caseSensitive ? [] : ['-i']),
    ...(options.wholeWord ? ['-w'] : []),
    '-e', query,
  ]
  return withGitSlot(() => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    let stderr = ''
    let stopped = false
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (stopped) return
      buffer += chunk
      let pos = 0
      for (;;) {
        const pathEnd = buffer.indexOf('\0', pos)
        if (pathEnd === -1) break
        const lineEnd = buffer.indexOf('\0', pathEnd + 1)
        if (lineEnd === -1) break
        const textEnd = buffer.indexOf('\n', lineEnd + 1)
        if (textEnd === -1) break
        collector.add(buffer.slice(pos, pathEnd), Number(buffer.slice(pathEnd + 1, lineEnd)), buffer.slice(lineEnd + 1, textEnd))
        pos = textEnd + 1
        if (collector.full) {
          stopped = true
          child.kill()
          break
        }
      }
      buffer = buffer.slice(pos)
    })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      // 1 is git grep's "no lines matched"; a kill for the budget exits by signal.
      if (stopped || code === 0 || code === 1) resolve({ truncated: stopped })
      else reject(new Error(stderr.trim() || `git grep exited with ${String(code)}`))
    })
  }))
}

async function walkSearch(root: string, collector: RootCollector): Promise<{ truncated: boolean }> {
  const walked = walkFiles(root)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < walked.files.length && !collector.full) {
      const relativePath = walked.files[next++]
      const fullPath = join(root, relativePath)
      try {
        if ((await stat(fullPath)).size > WALK_MAX_FILE_BYTES) continue
        const buf = await readFile(fullPath)
        if (buf.subarray(0, Math.min(8192, buf.length)).includes(0)) continue
        const lines = buf.toString('utf8').split(/\r?\n/)
        for (let i = 0; i < lines.length && !collector.full; i++) collector.add(relativePath, i + 1, lines[i])
      } catch (err) {
        _debug(TAG, 'walk skipped an unreadable file', { path: fullPath, error: String(err) })
      }
    }
  }
  await Promise.all(Array.from({ length: WALK_READ_CONCURRENCY }, worker))
  return { truncated: walked.truncated || collector.full }
}

async function searchRoot(root: string, query: string, options: TextSearchOptions, budget: number): Promise<RootOutcome> {
  const collector = new RootCollector(root, query, options, budget)
  if (await isGitCheckout(root)) {
    const { truncated } = await gitGrep(root, collector, query, options)
    return { files: collector.files, matches: collector.matches, truncated, source: 'git' }
  }
  const { truncated } = await walkSearch(root, collector)
  return { files: collector.files, matches: collector.matches, truncated, source: 'walk' }
}

export async function searchText(payload: unknown): Promise<TextSearchResult> {
  const request = (payload ?? {}) as { roots?: unknown; query?: unknown; caseSensitive?: unknown; wholeWord?: unknown; maxResults?: unknown }
  const roots = Array.isArray(request.roots) ? request.roots.filter((r): r is string => typeof r === 'string') : []
  const query = typeof request.query === 'string' ? request.query : ''
  const options: TextSearchOptions = { caseSensitive: request.caseSensitive === true, wholeWord: request.wholeWord === true }
  const maxResults = Math.min(
    TEXT_SEARCH_MAX_RESULTS,
    Math.max(1, typeof request.maxResults === 'number' ? Math.floor(request.maxResults) : TEXT_SEARCH_DEFAULT_MAX_RESULTS),
  )
  const empty = (error?: string): TextSearchResult => ({ files: [], totalMatches: 0, truncated: false, ...(error ? { error } : {}) })

  if (query.length === 0) return empty()
  if (query.length > MAX_QUERY_LENGTH) {
    _warn(TAG, 'search refused: query too long', { query_length: query.length })
    return empty(`Search text is longer than ${MAX_QUERY_LENGTH} characters`)
  }
  if (/[\r\n]/.test(query)) {
    _warn(TAG, 'search refused: multi-line query', { query_length: query.length })
    return empty('Search text must be a single line')
  }
  const invalid = roots.filter((root) => !isValidProjectPath(root))
  if (roots.length === 0 || invalid.length > 0) {
    _warn(TAG, 'search refused: invalid roots', { roots: roots.length, invalid: invalid.length })
    return empty('Invalid path')
  }

  const started = Date.now()
  const files: TextSearchFileResult[] = []
  let totalMatches = 0
  let truncated = false
  for (const root of roots) {
    const budget = maxResults - totalMatches
    if (budget <= 0) { truncated = true; break }
    try {
      const outcome = await searchRoot(root, query, options, budget)
      files.push(...outcome.files)
      totalMatches += outcome.matches
      truncated ||= outcome.truncated
      _debug(TAG, 'root searched', { root, source: outcome.source, files: outcome.files.length, matches: outcome.matches, truncated: outcome.truncated })
    } catch (err) {
      _warn(TAG, 'root search failed', { root, error: String(err) })
      return { files, totalMatches, truncated, error: `Search failed in ${root}: ${String(err)}` }
    }
  }
  _log(TAG, 'search complete', {
    roots: roots.length,
    query_length: query.length,
    case_sensitive: options.caseSensitive,
    whole_word: options.wholeWord,
    files: files.length,
    matches: totalMatches,
    truncated,
    duration_ms: Date.now() - started,
  })
  return { files, totalMatches, truncated }
}
