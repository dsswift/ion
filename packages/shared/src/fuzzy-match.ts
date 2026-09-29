/**
 * Fuzzy matching utilities for slash-command filtering.
 *
 * Pure functions — no React, no DOM dependencies.
 * Algorithm mirrors `ios/IonRemote/Utilities/FuzzyMatch.swift` for
 * cross-platform parity.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FuzzyCandidate {
  command: string
  group?: string
}

export interface FuzzyMatchResult {
  match: boolean
  score: number
}

// ---------------------------------------------------------------------------
// Scoring constants
// ---------------------------------------------------------------------------

const BONUS_EXACT_PREFIX = 20
const BONUS_START_OF_STRING = 10
const BONUS_SEGMENT_BOUNDARY = 8
const BONUS_CONSECUTIVE = 5

const SEPARATORS = new Set(['-', '_', ':'])

const GROUP_ORDER: Record<string, number> = {
  builtin: 0,
  project: 1,
  extension: 2,
  user: 3,
}

// ---------------------------------------------------------------------------
// fuzzyMatchCommand
// ---------------------------------------------------------------------------

/**
 * Attempt a fuzzy subsequence match of `query` against `commandName`.
 *
 * Leading `/` is stripped from both query and command name before matching
 * so that `/clear`, `clear`, and `/clear` vs `/clear` all work identically.
 *
 * Returns `null` when the query is not a subsequence of the candidate.
 * Otherwise returns `{ match: true, score }`.
 */
export function fuzzyMatchCommand(
  query: string,
  commandName: string,
): FuzzyMatchResult | null {
  // Normalise: strip a leading slash from both, lowercase both.
  const q = stripSlash(query).toLowerCase()
  const name = stripSlash(commandName).toLowerCase()

  // Empty query matches everything with a neutral score.
  if (q.length === 0) {
    return { match: true, score: 0 }
  }

  // --- Subsequence gate --------------------------------------------------
  // Walk through `name` consuming characters from `q` in order.
  // Along the way, record the index in `name` where each query char matched
  // so we can compute bonuses in one pass.

  const matchIndices: number[] = []
  let qi = 0

  for (let ni = 0; ni < name.length && qi < q.length; ni++) {
    if (name[ni] === q[qi]) {
      matchIndices.push(ni)
      qi++
    }
  }

  if (qi !== q.length) {
    // Not every query character was consumed — no subsequence match.
    return null
  }

  // --- Scoring -----------------------------------------------------------

  let score = 0

  for (let i = 0; i < matchIndices.length; i++) {
    const idx = matchIndices[i]

    // Base: +1 per matched character.
    score += 1

    // Start-of-string bonus (first character of the name).
    if (idx === 0) {
      score += BONUS_START_OF_STRING
    }

    // Segment-boundary bonus: character immediately after a separator.
    if (idx > 0 && SEPARATORS.has(name[idx - 1])) {
      score += BONUS_SEGMENT_BOUNDARY
    }

    // Consecutive-match bonus: current match index is exactly one past the
    // previous match index (i.e. the characters are adjacent in `name`).
    if (i > 0 && idx === matchIndices[i - 1] + 1) {
      score += BONUS_CONSECUTIVE
    }
  }

  // Exact prefix bonus: the entire query matches the start of the candidate.
  if (matchIndices.length === q.length && matchIndices[0] === 0 && matchIndices[matchIndices.length - 1] === q.length - 1) {
    score += BONUS_EXACT_PREFIX
  }

  return { match: true, score }
}

// ---------------------------------------------------------------------------
// fuzzyFilterAndSort
// ---------------------------------------------------------------------------

/**
 * Filter `commands` to those that fuzzy-match `query`, then sort by:
 *   1. Score descending (best match first)
 *   2. Group order ascending  (builtin → project → extension → user)
 *   3. Alphabetical by command name
 */
export function fuzzyFilterAndSort<T extends FuzzyCandidate>(
  query: string,
  commands: T[],
): T[] {
  const scored: Array<{ item: T; score: number }> = []

  for (const cmd of commands) {
    const result = fuzzyMatchCommand(query, cmd.command)
    if (result !== null) {
      scored.push({ item: cmd, score: result.score })
    }
  }

  scored.sort((a, b) => {
    // 1. Higher score first.
    if (a.score !== b.score) return b.score - a.score

    // 2. Group order.
    const ga = GROUP_ORDER[a.item.group || 'builtin'] ?? 99
    const gb = GROUP_ORDER[b.item.group || 'builtin'] ?? 99
    if (ga !== gb) return ga - gb

    // 3. Alphabetical.
    return a.item.command.localeCompare(b.item.command)
  })

  return scored.map((s) => s.item)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripSlash(s: string): string {
  return s.startsWith('/') ? s.slice(1) : s
}
