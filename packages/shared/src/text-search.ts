/**
 * Workspace Search — the wire shapes and the one literal matcher behind the
 * Studio sidebar's "search every file" view.
 *
 * The server finds candidate lines (`git grep` inside a checkout, a bounded
 * walk elsewhere) and then runs `findMatchRanges` over each line, so the
 * ranges a client highlights come from the same function that decided the
 * line matched, on every path.
 */

export interface TextSearchOptions {
  /** Match letter case exactly. Off by default, as in every editor. */
  caseSensitive: boolean
  /** Match only where the query is not part of a longer identifier. */
  wholeWord: boolean
}

export interface TextSearchRequest extends Partial<TextSearchOptions> {
  /** Absolute directories to search, in display order (the workspace folders). */
  roots: string[]
  /** Literal text. Never a pattern. */
  query: string
  /** Cap on matching lines across every root. */
  maxResults?: number
}

/** One matching line. */
export interface TextSearchLineMatch {
  /** 1-based line number in the file. */
  line: number
  /** 1-based column of the first match on the line, in the full line. */
  column: number
  /** Length of the first match, so a client can select exactly it. */
  length: number
  /** The line text, clipped around the first match when the line is long. */
  preview: string
  /** `[start, end)` offsets of every match inside `preview`. */
  ranges: Array<[number, number]>
}

export interface TextSearchFileResult {
  /** The workspace folder the file was found under. */
  root: string
  /** Absolute path. */
  path: string
  /** Path relative to `root`, forward-slashed. */
  relativePath: string
  matches: TextSearchLineMatch[]
}

export interface TextSearchResult {
  files: TextSearchFileResult[]
  /** Matching lines returned across every file. */
  totalMatches: number
  /** True when the search stopped at `maxResults` or at a walk bound. */
  truncated: boolean
  error?: string
}

export const TEXT_SEARCH_DEFAULT_MAX_RESULTS = 2000
export const TEXT_SEARCH_MAX_RESULTS = 10_000
/** Longest preview a result line carries. Minified files have megabyte lines. */
export const TEXT_SEARCH_PREVIEW_CHARS = 240
/** Context kept ahead of the first match when a preview is clipped. */
const PREVIEW_LEAD_CHARS = 40

/** `git grep -w` word characters: ASCII letters, digits, underscore. */
function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch)
}

/**
 * Every non-overlapping `[start, end)` occurrence of `query` in `text`.
 * Literal only: no character in the query is special.
 */
export function findMatchRanges(text: string, query: string, options: TextSearchOptions): Array<[number, number]> {
  if (query.length === 0) return []
  const hay = options.caseSensitive ? text : text.toLowerCase()
  const needle = options.caseSensitive ? query : query.toLowerCase()
  const ranges: Array<[number, number]> = []
  let from = 0
  while (from <= hay.length - needle.length) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    const end = at + needle.length
    if (options.wholeWord && (isWordChar(text[at - 1]) || isWordChar(text[end]))) {
      from = at + 1
      continue
    }
    ranges.push([at, end])
    from = end
  }
  return ranges
}

/**
 * Build the wire form of one matching line, or null when `query` does not
 * occur in it under `options`.
 */
export function buildLineMatch(lineNumber: number, text: string, query: string, options: TextSearchOptions): TextSearchLineMatch | null {
  const ranges = findMatchRanges(text, query, options)
  if (ranges.length === 0) return null
  const [firstStart, firstEnd] = ranges[0]
  let offset = 0
  let preview = text
  if (text.length > TEXT_SEARCH_PREVIEW_CHARS) {
    offset = Math.max(0, Math.min(firstStart - PREVIEW_LEAD_CHARS, text.length - TEXT_SEARCH_PREVIEW_CHARS))
    preview = text.slice(offset, offset + TEXT_SEARCH_PREVIEW_CHARS)
  }
  const clipped: Array<[number, number]> = []
  for (const [start, end] of ranges) {
    const s = start - offset
    const e = Math.min(end - offset, preview.length)
    if (s >= 0 && s < preview.length) clipped.push([s, e])
  }
  return {
    line: lineNumber,
    column: firstStart + 1,
    length: firstEnd - firstStart,
    preview,
    ranges: clipped,
  }
}
