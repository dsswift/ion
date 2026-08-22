/** Worktree overlap footprint collection. */
import { runGit } from '../git-runner'
import { lookupWorktreeBase } from './registry'
import type { WorktreeChangeKind, WorktreeChangedFile, WorktreeFootprint } from '../../shared/types-worktree-overlap'
import type { WorktreeInventoryEntry } from '../../shared/types'
import type { IntegrationMember } from '../../shared/types'

export interface FootprintTarget {
  entry: WorktreeInventoryEntry
  member?: IntegrationMember
  basis: 'live' | 'pins'
  order?: number
}

export async function collectFootprint(target: FootprintTarget): Promise<WorktreeFootprint> {
  const { entry, member, basis, order } = target
  const baseSha = basis === 'pins' ? member?.pinnedBaseSha : lookupWorktreeBase(entry.worktreePath)
  const tip = basis === 'pins' ? member?.pinnedSha : await readCommit(entry.worktreePath, entry.branchName)
  const tree = basis === 'pins' ? member?.pinnedTreeHash : await readTree(entry.worktreePath, entry.branchName)
  const foundation: WorktreeFootprint = {
    worktreePath: entry.worktreePath,
    branchName: entry.branchName,
    title: entry.title,
    sourceBranch: entry.sourceBranch,
    baseSha: baseSha || undefined,
    tipSha: tip || undefined,
    treeHash: tree || undefined,
    files: [],
    enrolled: !!member,
    order,
    landed: !!entry.landedAt,
  }
  if (!baseSha || !tip) {
    return { ...foundation, incompleteReason: 'No recorded contribution base exists for this worktree.' }
  }

  try {
    const committed = await changedFiles(entry.worktreePath, baseSha, tip)
    const dirty = basis === 'live' ? await dirtyFiles(entry.worktreePath) : []
    return { ...foundation, files: mergeFiles(committed, dirty) }
  } catch (error) {
    return { ...foundation, incompleteReason: String(error) }
  }
}

async function readCommit(directory: string, branch: string): Promise<string | undefined> {
  try {
    return (await runGit(directory, ['rev-parse', branch])).trim()
  } catch {
    return undefined
  }
}

async function readTree(directory: string, branch: string): Promise<string | undefined> {
  try {
    return (await runGit(directory, ['rev-parse', `${branch}^{tree}`])).trim()
  } catch {
    return undefined
  }
}

async function changedFiles(directory: string, base: string, tip: string): Promise<WorktreeChangedFile[]> {
  const [names, numstat, hunks] = await Promise.all([
    runGit(directory, ['diff', '--name-status', '-z', '--find-renames', base, tip]),
    runGit(directory, ['diff', '--numstat', '-z', '--find-renames', base, tip]),
    runGit(directory, ['diff', '--unified=0', '--no-ext-diff', base, tip]),
  ])
  const files = parseNameStatus(names)
  applyNumstat(files, numstat)
  applyHunks(files, hunks)
  return files
}

async function dirtyFiles(directory: string): Promise<WorktreeChangedFile[]> {
  const [staged, unstaged, untracked] = await Promise.all([
    runGit(directory, ['diff', '--name-status', '-z', '--cached']),
    runGit(directory, ['diff', '--name-status', '-z']),
    runGit(directory, ['ls-files', '--others', '--exclude-standard', '-z']),
  ])
  return mergeFiles(
    parseNameStatus(staged).map((file) => ({ ...file, layers: ['staged'] })),
    parseNameStatus(unstaged).map((file) => ({ ...file, layers: ['unstaged'] })),
    untracked.split('\0').filter(Boolean).map((path) => ({ path, kind: 'added' as const, additions: null, deletions: null, hunks: [], layers: ['untracked'] })),
  )
}

export function parseNameStatus(raw: string): WorktreeChangedFile[] {
  const records = raw.split('\0').filter(Boolean)
  const parsed: WorktreeChangedFile[] = []
  for (let index = 0; index < records.length;) {
    const status = records[index++]
    const code = status.slice(0, 1)
    const path = records[index++]
    if (!path) continue
    if (code === 'R' || code === 'C') {
      const next = records[index++]
      if (!next) continue
      parsed.push(file(next, code === 'C' ? 'added' : 'renamed', path))
    } else {
      parsed.push(file(path, kindFromCode(code)))
    }
  }
  return parsed
}

function file(path: string, kind: WorktreeChangeKind, oldPath?: string): WorktreeChangedFile {
  return { path, oldPath, kind, additions: 0, deletions: 0, hunks: [], layers: ['committed'] }
}

function kindFromCode(code: string): WorktreeChangeKind {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  return 'modified'
}

function applyNumstat(files: WorktreeChangedFile[], raw: string): void {
  const byPath = new Map(files.map((file) => [file.path, file]))
  const records = raw.split('\0').filter(Boolean)
  for (let index = 0; index < records.length; index++) {
    const record = records[index]
    const match = record.match(/^(\d+|-)\t(\d+|-)\t(.+)$/)
    if (!match) continue
    const found = byPath.get(match[3])
    if (!found) continue
    found.additions = match[1] === '-' ? null : Number(match[1])
    found.deletions = match[2] === '-' ? null : Number(match[2])
    if (found.additions === null || found.deletions === null) found.kind = 'binary'
  }
}

function applyHunks(files: WorktreeChangedFile[], raw: string): void {
  let current: WorktreeChangedFile | undefined
  for (const line of raw.split('\n')) {
    if (line.startsWith('+++ b/')) current = files.find((file) => file.path === line.slice(6))
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,\d+)? @@/)
    if (!match || !current) continue
    const start = Number(match[1])
    const count = Number(match[2] ?? '1')
    current.hunks.push({ start, end: start + Math.max(0, count - 1) })
  }
}

export function mergeFiles(...groups: WorktreeChangedFile[][]): WorktreeChangedFile[] {
  const byPath = new Map<string, WorktreeChangedFile>()
  for (const group of groups) for (const incoming of group) {
    const existing = byPath.get(incoming.path)
    if (!existing) {
      byPath.set(incoming.path, { ...incoming, layers: [...incoming.layers], hunks: [...incoming.hunks] })
      continue
    }
    existing.layers = [...new Set([...existing.layers, ...incoming.layers])]
    existing.hunks.push(...incoming.hunks)
    if (incoming.additions !== 0) existing.additions = incoming.additions
    if (incoming.deletions !== 0) existing.deletions = incoming.deletions
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}
