/**
 * Pure ref and log parsers — no IPC, no side effects.
 */

export interface GitRef {
  name: string
  type: 'head' | 'remote' | 'tag'
  isCurrent: boolean
}

export interface GitCommitRaw {
  hash: string
  fullHash: string
  parents: string[]
  authorName: string
  authorDate: string
  subject: string
  refs: GitRef[]
}

/** The git log --format used for graph queries. */
export const LOG_FORMAT = '%h%x00%H%x00%P%x00%an%x00%aI%x00%s%x00%D'

/**
 * Parse a single line of `git log --format=LOG_FORMAT` output.
 */
export function parseLogLine(line: string): GitCommitRaw | null {
  const parts = line.split('\x00')
  if (parts.length < 7) return null
  const [hash, fullHash, parents, authorName, authorDate, subject, decorations] = parts
  const refs: GitRef[] = []
  if (decorations && decorations.trim()) {
    for (const dec of decorations.split(',')) {
      const d = dec.trim()
      if (!d) continue
      if (d.startsWith('HEAD -> ')) {
        refs.push({ name: d.replace('HEAD -> ', ''), type: 'head', isCurrent: true })
      } else if (d.startsWith('tag: ')) {
        refs.push({ name: d.replace('tag: ', ''), type: 'tag', isCurrent: false })
      } else if (d.includes('/')) {
        refs.push({ name: d, type: 'remote', isCurrent: false })
      } else if (d !== 'HEAD') {
        refs.push({ name: d, type: 'head', isCurrent: false })
      }
    }
  }
  return {
    hash,
    fullHash,
    parents: parents ? parents.split(' ') : [],
    authorName,
    authorDate,
    subject,
    refs,
  }
}

/**
 * Parse full git log output (newline-separated LOG_FORMAT lines).
 */
export function parseGitLog(output: string): GitCommitRaw[] {
  return output.trim().split('\n').filter(Boolean).map(parseLogLine).filter((c): c is GitCommitRaw => c !== null)
}

/**
 * Parse `git show --stat --format=` output for commit detail stats.
 */
export function parseCommitStats(output: string): { filesChanged: number; insertions: number; deletions: number } {
  const lines = output.trim().split('\n')
  const summary = lines[lines.length - 1] || ''
  const filesMatch = summary.match(/(\d+)\s+files?\s+changed/)
  const insMatch = summary.match(/(\d+)\s+insertions?\(\+\)/)
  const delMatch = summary.match(/(\d+)\s+deletions?\(-\)/)
  return {
    filesChanged: filesMatch ? parseInt(filesMatch[1], 10) : 0,
    insertions: insMatch ? parseInt(insMatch[1], 10) : 0,
    deletions: delMatch ? parseInt(delMatch[1], 10) : 0,
  }
}

/**
 * Parse `git diff-tree --no-commit-id -r --name-status` output.
 */
export interface CommitFileEntry {
  path: string
  status: string
  oldPath?: string
}

export function parseCommitFiles(output: string): CommitFileEntry[] {
  return output.trim().split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t')
    const statusCode = parts[0][0]
    const statusMap: Record<string, string> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed' }
    const status = statusMap[statusCode] || 'modified'
    if (statusCode === 'R') {
      return { path: parts[2], status, oldPath: parts[1] }
    }
    return { path: parts[1], status }
  })
}

/**
 * Parse `git branch -a --format=...` output.
 */
export interface BranchEntry {
  name: string
  isCurrent: boolean
  upstream: string | null
  isRemote: boolean
}

export function parseBranches(output: string): { branches: BranchEntry[]; current: string } {
  let current = ''
  const branches: BranchEntry[] = []
  for (const line of output.trim().split('\n').filter(Boolean)) {
    const [name, head, upstream] = line.split('\t')
    const isCurrent = head === '*'
    if (isCurrent) current = name
    const isRemote = name.startsWith('origin/') || name.includes('/')
    branches.push({ name, isCurrent, upstream: upstream || null, isRemote })
  }
  return { branches, current }
}
