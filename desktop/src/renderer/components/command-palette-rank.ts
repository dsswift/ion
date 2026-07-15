/**
 * command-palette-rank — pure fuzzy ranking for the shared command palette
 * (mounted in BOTH the overlay and the ATV shell; parity by construction).
 *
 * Scoring: subsequence match required; earlier and denser matches rank
 * higher; prefix beats infix; label beats keywords.
 */
export interface PaletteEntry {
  id: string
  label: string
  /** Secondary matcher text (directory, group, action synonyms). */
  keywords?: string
  /** Section header the entry sorts under. */
  section: string
  run(): void
}

export interface RankedEntry {
  entry: PaletteEntry
  score: number
}

/** Subsequence score: -1 = no match; higher is better. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (q.length === 0) return 0
  let qi = 0
  let score = 0
  let lastHit = -1
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Dense (adjacent) matches and early matches score higher.
      score += lastHit === ti - 1 ? 3 : 1
      if (ti === 0) score += 4
      lastHit = ti
      qi++
    }
  }
  if (qi < q.length) return -1
  if (t.startsWith(q)) score += 8
  return score
}

export function rankEntries(query: string, entries: readonly PaletteEntry[], limit = 12): RankedEntry[] {
  const ranked: RankedEntry[] = []
  for (const entry of entries) {
    const label = fuzzyScore(query, entry.label)
    const kw = entry.keywords ? fuzzyScore(query, entry.keywords) : -1
    const score = Math.max(label >= 0 ? label + 2 : -1, kw)
    if (score >= 0) ranked.push({ entry, score })
  }
  ranked.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
  return ranked.slice(0, limit)
}
