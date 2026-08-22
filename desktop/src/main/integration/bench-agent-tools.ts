/**
 * Bench agent tools — the desktop's client-tool implementations of the three
 * read-only bench provenance tools.
 *
 * Ported from engine/internal/tools/workspace_attribution.go and
 * bench_tools.go as these tools move from the Go engine to the desktop, which
 * declares them over Ion's tool-gate wire. The names, descriptions, input
 * schemas, and JSON output shapes are copied from the Go definitions verbatim
 * so the model-facing surface does not change with the move.
 *
 * All three are read-only reads of state the desktop already owns (the
 * workspace records plus the bench repository's object store), and exist for
 * one measured reason: resolving a bench conflict without them means
 * reconstructing facts by hand. A fifteen-minute merge in this repo spent
 * twelve shell calls reading one file out of eight sibling worktrees, and
 * re-derived a decision an earlier conversation had already made and thrown
 * away.
 *
 * `WorkspaceAttribution` answers WHO owns a line. The others answer the two
 * questions that come next: WHAT does each owner's version say, and WHAT was
 * decided about this file last time.
 *
 * Plan-mode safe, all of them: nothing here writes, and every git invocation
 * is a query.
 */
import { log as _log, warn as _warn } from '../logger'
import { attribute, resolveRequestPath } from './bench-attribution'
import { benchForPath, canonicalizePath } from './bench-attribution-support'
import { memberFile } from './bench-member-file'
import { loadResolutionsDetailed, type BenchResolutionEntry } from './bench-resolution-journal'

function log(tag: string, msg: string, fields?: Record<string, unknown>): void { _log(tag, msg, fields) }
function warn(tag: string, msg: string, fields?: Record<string, unknown>): void { _warn(tag, msg, fields) }

/** The result shape every client tool returns over the tool-gate wire. */
export interface ClientToolResult {
  content: string
  isError: boolean
}

// ── WorkspaceAttribution ─────────────────────────────────────────────────────

export function executeWorkspaceAttribution(input: Record<string, unknown>, cwd: string): ClientToolResult {
  const file = input.file
  if (typeof file !== 'string' || file === '') {
    return inputError('WorkspaceAttribution', 'file is required')
  }
  const line = optionalPositiveInt(input, 'line')
  if (line.error) return inputError('WorkspaceAttribution', line.error)
  const endLine = optionalPositiveInt(input, 'endLine')
  if (endLine.error) return inputError('WorkspaceAttribution', endLine.error)
  if (endLine.value > 0 && line.value === 0) {
    return inputError('WorkspaceAttribution', 'endLine requires line')
  }
  if (endLine.value > 0 && endLine.value < line.value) {
    return inputError('WorkspaceAttribution', 'endLine must be greater than or equal to line')
  }

  log('tools.workspace_attribution', 'workspace attribution started', {
    cwd, file, line: line.value, end_line: endLine.value,
  })
  const result = attribute({
    benchPath: cwd,
    path: file,
    startLine: line.value,
    endLine: endLine.value,
  })
  const raw = JSON.stringify(result)
  if (result.rejection) {
    warn('tools.workspace_attribution', 'workspace attribution rejected', {
      cwd, file, reason: result.rejection,
    })
    return { content: raw, isError: true }
  }
  log('tools.workspace_attribution', 'workspace attribution completed', {
    cwd, file, outcome: result.outcome,
    candidate_count: result.candidates.length,
    warning_count: result.warnings?.length ?? 0,
    error_count: result.errors?.length ?? 0,
  })
  return { content: raw, isError: false }
}

// ── BenchMemberFile ──────────────────────────────────────────────────────────

export function executeBenchMemberFile(input: Record<string, unknown>, cwd: string): ClientToolResult {
  const file = input.file
  if (typeof file !== 'string' || file === '') {
    return inputError('BenchMemberFile', 'file is required')
  }
  // A non-string here reads as absent: `member` is then caught by the
  // required-member refusal in memberFile, and `source` by the enum check
  // below. Both produce an actionable message rather than a silent default.
  const member = typeof input.member === 'string' ? input.member : ''
  const source = typeof input.source === 'string' ? input.source : ''
  if (source !== '' && source !== 'member' && source !== 'base') {
    return inputError('BenchMemberFile', 'source must be "member" or "base"')
  }

  log('tools.bench_member_file', 'bench member file read started', {
    cwd, file, member, source,
  })
  const result = memberFile({
    benchPath: cwd,
    path: file,
    member,
    source: source as 'member' | 'base' | '' || undefined,
  })
  return finishBenchTool('BenchMemberFile', 'tools.bench_member_file', result, result.rejection, {
    cwd, file, member: result.memberBranch ?? '',
    exists: result.exists, binary: result.binary ?? false, truncated: result.truncated ?? false,
  })
}

// ── BenchResolutionHistory ───────────────────────────────────────────────────

/**
 * How many entries an unnarrowed query returns.
 *
 * A busy bench accumulates entries indefinitely, and an agent asking "what was
 * decided here" wants the recent decisions, not the archive. The cap is stated
 * in the result (`truncated`) so a caller that genuinely wants more can ask.
 * Matches the engine's DefaultResolutionHistoryLimit.
 */
export const DEFAULT_RESOLUTION_HISTORY_LIMIT = 20

/**
 * The complete answer. Never an error: a missing or unreadable journal is an
 * empty history, which is the honest answer — nothing has been recorded that
 * this caller can use. JSON shape mirrors the engine's ResolutionHistoryResult.
 */
export interface ResolutionHistoryResult {
  benchPath: string
  repoPath?: string
  sourceBranch?: string
  /** Echo of the bench-relative paths the query was narrowed to. */
  paths?: string[]
  /** Matching resolutions, newest first. */
  entries: BenchResolutionEntry[]
  /** How many matched before the limit was applied. */
  total: number
  truncated?: boolean
  /** Facts that change how the entries should be read. */
  warnings?: string[]
  /** Set when the request itself was refused. */
  rejection?: string
}

/**
 * Prior recorded resolutions for the bench containing cwd.
 *
 * The journal file (`~/.ion/integration-resolutions.json`) is written by
 * bench-resolution-journal.ts in this same process; this reads through the
 * same module so the writer and reader can never disagree about the format.
 * The port from the engine adds only what the Go reader added on top of the
 * raw journal: bench scoping, path narrowing with the same
 * refuse-outside-the-bench rule attribution applies, newest-first ordering,
 * and the stated limit.
 */
export function resolutionHistory(req: { benchPath: string; paths?: string[]; limit?: number }): ResolutionHistoryResult {
  const res: ResolutionHistoryResult = { benchPath: '', entries: [], total: 0 }

  const bench = benchForPath(canonicalizePath(req.benchPath))
  if (!bench) {
    res.rejection = `${req.benchPath} is not inside a registered integration bench, so it has no resolution history`
    logResolutionHistory(res, req)
    return res
  }
  res.benchPath = bench.benchPath
  if (bench.repoPath) res.repoPath = bench.repoPath
  if (bench.sourceBranch) res.sourceBranch = bench.sourceBranch

  // Narrow to bench-relative paths, refusing anything outside the bench for
  // the same reason attribution does: a question about a file elsewhere is not
  // a question this bench can answer.
  const wanted = new Set<string>()
  for (const p of req.paths ?? []) {
    const resolved = resolveRequestPath(p, bench)
    if (resolved.rejection) {
      res.rejection = resolved.rejection
      logResolutionHistory(res, req)
      return res
    }
    wanted.add(resolved.rel)
    ;(res.paths ??= []).push(resolved.rel)
  }

  const journal = loadResolutionsDetailed()
  if (journal.warning) {
    (res.warnings ??= []).push(journal.warning)
  }

  const matched = journal.entries
    .filter((e) => e.repoPath === bench.repoPath && e.sourceBranch === bench.sourceBranch)
    .filter((e) => wanted.size === 0 || wanted.has(e.path))
  // Newest first: the most recent decision about a file is the one most likely
  // to still describe the code.
  matched.sort((a, b) => b.resolvedAt - a.resolvedAt)

  res.total = matched.length
  const limit = req.limit && req.limit > 0 ? req.limit : DEFAULT_RESOLUTION_HISTORY_LIMIT
  if (matched.length > limit) {
    res.entries = matched.slice(0, limit)
    res.truncated = true
  } else {
    res.entries = matched
  }

  logResolutionHistory(res, req)
  return res
}

function logResolutionHistory(res: ResolutionHistoryResult, req: { paths?: string[] }): void {
  const fields: Record<string, unknown> = {
    bench_path: res.benchPath,
    requested_paths: req.paths?.length ?? 0,
    entries: res.entries.length,
    total: res.total,
    truncated: res.truncated ?? false,
  }
  if (res.rejection) {
    fields.rejection = res.rejection
    warn('tools.bench_resolution_history', 'bench resolution history rejected', fields)
    return
  }
  if (res.warnings && res.warnings.length > 0) fields.warning_count = res.warnings.length
  log('tools.bench_resolution_history', 'bench resolution history read', fields)
}

export function executeBenchResolutionHistory(input: Record<string, unknown>, cwd: string): ClientToolResult {
  const paths = optionalStringArray(input, 'paths')
  if (paths.error) return inputError('BenchResolutionHistory', paths.error)
  const limit = optionalPositiveInt(input, 'limit')
  if (limit.error) return inputError('BenchResolutionHistory', limit.error)

  log('tools.bench_resolution_history', 'bench resolution history requested', {
    cwd, paths: paths.value.length, limit: limit.value,
  })
  const result = resolutionHistory({ benchPath: cwd, paths: paths.value, limit: limit.value })
  return finishBenchTool('BenchResolutionHistory', 'tools.bench_resolution_history', result, result.rejection, {
    cwd, entries: result.entries.length, total: result.total, truncated: result.truncated ?? false,
  })
}

// ── Input helpers ────────────────────────────────────────────────────────────

/** Read an optional positive-integer argument. Absent yields 0. */
function optionalPositiveInt(input: Record<string, unknown>, key: string): { value: number; error?: string } {
  const value = input[key]
  if (value === undefined || value === null) return { value: 0 }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { value: 0, error: `${key} must be an integer` }
  }
  if (value < 1) return { value: 0, error: `${key} must be 1 or greater` }
  return { value }
}

/**
 * Read an optional array-of-strings argument.
 *
 * Rejects a bare string rather than accepting it as a one-element array: a
 * model that passes `"paths": "a.ts"` has misread the schema, and silently
 * coercing it would hide that from the next reader of the transcript.
 */
function optionalStringArray(input: Record<string, unknown>, key: string): { value: string[]; error?: string } {
  const value = input[key]
  if (value === undefined || value === null) return { value: [] }
  if (!Array.isArray(value)) return { value: [], error: `${key} must be an array of strings` }
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return { value: [], error: `${key} must contain only strings` }
    if (item !== '') out.push(item)
  }
  return { value: out }
}

/**
 * Serialize a bench tool's result, mapping a typed rejection to an error
 * result so the model sees an actionable message rather than a success
 * carrying a refusal it might ignore.
 */
function finishBenchTool(
  toolName: string, tag: string, payload: unknown, rejection: string | undefined,
  fields: Record<string, unknown>,
): ClientToolResult {
  const raw = JSON.stringify(payload)
  if (rejection) {
    fields.rejection = rejection
    warn(tag, 'request rejected', fields)
    return { content: raw, isError: true }
  }
  log(tag, 'request completed', fields)
  return { content: raw, isError: false }
}

function inputError(toolName: string, message: string): ClientToolResult {
  warn('tools.bench', 'input rejected', { tool: toolName, reason: message })
  return { content: 'Error: ' + message, isError: true }
}

// ── Tool declarations ────────────────────────────────────────────────────────

export interface BenchClientTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  planModeSafe: boolean
  execute: (input: Record<string, unknown>, cwd: string) => ClientToolResult
}

/**
 * The three read-only bench tools the desktop declares as client tools.
 * Descriptions and input schemas are copied verbatim from the Go tool
 * definitions (engine/internal/tools/workspace_attribution.go and
 * bench_tools.go) so the model-facing contract is identical.
 */
export const BENCH_CLIENT_TOOLS: BenchClientTool[] = [
  {
    name: 'WorkspaceAttribution',
    description: 'Attribute a file or inclusive line range in the current integration bench to its source branch, member worktree(s), or recorded merge resolution. Returns every candidate and warning; never edits files.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute or bench-relative file path' },
        line: { type: 'integer', minimum: 1, description: 'Optional 1-based starting line' },
        endLine: { type: 'integer', minimum: 1, description: 'Optional inclusive ending line; requires line' },
      },
      required: ['file'],
    },
    planModeSafe: true,
    execute: executeWorkspaceAttribution,
  },
  {
    name: 'BenchMemberFile',
    description: 'Read a file in the current integration bench as a named member\'s PINNED contribution has it, or as the bench base has it. '
      + 'Use this instead of shelling out to read a member worktree: a worktree\'s files include work done since its pin, which is not what the bench merges. '
      + 'Returns the content with the member and sha it came from; never edits anything.',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: 'Absolute or bench-relative file path' },
        member: {
          type: 'string',
          description: 'Member branch name or worktree path. Required unless source is "base". The result lists the members when this does not match.',
        },
        source: {
          type: 'string',
          enum: ['member', 'base'],
          description: 'Which revision to read: the member\'s pinned contribution (default) or the bench base every contribution is applied onto',
        },
      },
      required: ['file'],
    },
    planModeSafe: true,
    execute: executeBenchMemberFile,
  },
  {
    name: 'BenchResolutionHistory',
    description: 'Report previously recorded conflict resolutions for files in the current integration bench, newest first, with the reasoning that produced each one. '
      + 'Consult this before reasoning about a conflict: the same file frequently conflicts once per member, and git rerere cannot replay across members because its key is the conflict text. '
      + 'Advisory context, not a resolution to apply; never edits anything.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files to narrow to, absolute or bench-relative. Omit for the bench\'s recent history.',
        },
        limit: { type: 'integer', minimum: 1, description: 'Maximum entries to return' },
      },
    },
    planModeSafe: true,
    execute: executeBenchResolutionHistory,
  },
]
