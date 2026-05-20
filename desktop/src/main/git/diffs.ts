/**
 * Pure diff parsers — no IPC, no side effects.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk'
  content: string
  oldLine: number | null
  newLine: number | null
}

/**
 * Parse a unified diff string into structured lines.
 * Handles: diff headers, hunk markers, add/remove/context lines,
 * dual line number tracking.
 */
export function parseUnifiedDiff(raw: string): DiffLine[] {
  const lines = raw.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  let inHeader = true

  for (const line of lines) {
    if (inHeader) {
      if (line.startsWith('diff --git') || line.startsWith('index ') ||
          line.startsWith('--- ') || line.startsWith('+++ ') ||
          line.startsWith('new file') || line.startsWith('deleted file') ||
          line.startsWith('old mode') || line.startsWith('new mode') ||
          line.startsWith('similarity') || line.startsWith('rename') ||
          line.startsWith('Binary')) {
        continue
      }
      inHeader = false
    }

    if (line.startsWith('@@')) {
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      result.push({ type: 'hunk', content: line, oldLine: null, newLine: null })
    } else if (line.startsWith('+')) {
      result.push({ type: 'add', content: line.substring(1), oldLine: null, newLine: newLine++ })
    } else if (line.startsWith('-')) {
      result.push({ type: 'remove', content: line.substring(1), oldLine: oldLine++, newLine: null })
    } else {
      const content = line.startsWith(' ') ? line.substring(1) : line
      if (line.trim() === '' && result.length === 0) continue
      result.push({ type: 'context', content, oldLine: oldLine++, newLine: newLine++ })
    }
  }

  return result
}

/** Count insertions and deletions from a parsed diff. */
export function diffStats(lines: DiffLine[]): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.type === 'add') insertions++
    else if (line.type === 'remove') deletions++
  }
  return { insertions, deletions }
}

/**
 * Parse git status --porcelain=v1 output into structured file entries.
 */
import type { GitChangedFile, GitConflictKind } from '../../shared/types-session'

export type StatusEntry = GitChangedFile

const CONFLICT_CODES: Record<string, GitConflictKind> = {
  UU: 'UU', AA: 'AA', DD: 'DD', AU: 'AU', UA: 'UA', DU: 'DU', UD: 'UD',
}

export interface PartitionedStatus {
  flat: GitChangedFile[]
  index: GitChangedFile[]
  workingTree: GitChangedFile[]
  untracked: GitChangedFile[]
  merge: GitChangedFile[]
}

function statusFromCode(code: string): GitChangedFile['status'] {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'R') return 'renamed'
  if (code === '?') return 'untracked'
  return 'modified'
}

export function parseGitStatus(porcelainOutput: string): StatusEntry[] {
  return partitionStatus(porcelainOutput).flat
}

export function partitionStatus(porcelainOutput: string): PartitionedStatus {
  const flat: GitChangedFile[] = []
  const index: GitChangedFile[] = []
  const workingTree: GitChangedFile[] = []
  const untracked: GitChangedFile[] = []
  const merge: GitChangedFile[] = []

  for (const line of porcelainOutput.split('\n').filter((l) => l.length >= 4)) {
    const match = line.match(/^(.)(.) (.+)$/)
    if (!match) continue
    const x = match[1]
    const y = match[2]
    const xy = `${x}${y}`
    let filePath = match[3]
    let oldPath: string | undefined
    if (filePath.includes(' -> ')) {
      const parts = filePath.split(' -> ')
      oldPath = parts[0]
      filePath = parts[1]
    }

    const conflictKind = CONFLICT_CODES[xy]
    if (conflictKind) {
      const entry: GitChangedFile = { path: filePath, status: 'conflict', staged: false, conflictKind, oldPath }
      flat.push(entry); merge.push(entry)
      continue
    }

    if (x !== ' ' && x !== '?' && x !== '!') {
      const entry: GitChangedFile = { path: filePath, status: statusFromCode(x), staged: true, oldPath }
      flat.push(entry); index.push(entry)
    }
    if (y === '?') {
      const entry: GitChangedFile = { path: filePath, status: 'untracked', staged: false }
      flat.push(entry); untracked.push(entry)
    } else if (y !== ' ' && y !== '!') {
      const entry: GitChangedFile = { path: filePath, status: statusFromCode(y), staged: false, oldPath }
      flat.push(entry); workingTree.push(entry)
    }
  }

  return { flat, index, workingTree, untracked, merge }
}
