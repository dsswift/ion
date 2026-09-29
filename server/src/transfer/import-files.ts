/**
 * transfer/import-files — put a moved conversation's files where they belong
 * on this machine, and point every stored path at them.
 *
 * Everything lands in the conversation's own space, so nothing it brings can
 * collide with anything else here:
 *
 *   conversations/<id>.*, <id>/...  -> <conversationsDir>/
 *   tool-results/<id>/...           -> <conversationsDir>/tool-results/<id>/
 *   charts/<id>/...                 -> <dataDir>/resources/<id>/
 *   attachments/<n> (a plan)        -> <conversationsDir>/<owner>/plans/<name>,
 *                                      or <working dir>/.ion/plans/<name> for a
 *                                      claude-code plan, which the CLI can only
 *                                      write inside the project
 *   attachments/<n> (a file)        -> <conversationsDir>/<owner>/attachments/<name>
 *   attachments/<n> (tool output)   -> <conversationsDir>/tool-results/<owner>/<name>
 *
 * A name already taken by a different file gets `-<first 8 of its sha256>`.
 * A file already there with the same bytes is reused, never overwritten.
 *
 * The conversation files are rewritten in staging, before anything is
 * committed, so a refusal at any point leaves this machine untouched.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { basename, extname, join, sep } from 'path'
import type { TransferAttachment, TransferManifest } from './manifest'
import { sha256OfBuffer } from './entries'
import { rewriteJsonText, type PathMap } from './path-rewrite'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.import-files'
function log(msg: string, fields?: Record<string, unknown>): void { _log(TAG, msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn(TAG, msg, fields) }

export interface DestinationRoots {
  conversationsDir: string
  dataDir: string
}

/** Where one attachment lands. */
export interface Placement {
  attachment: TransferAttachment
  destination: string
  /** True when an identical file was already there; it is reused and never removed. */
  existing: boolean
}

/** A source path's last segment, split by the source's own separator. */
function sourceBasename(path: string, separator: string): string {
  const parts = path.split(separator)
  return parts[parts.length - 1] || basename(path)
}

/** Whether a source plan path is a claude-code project plan (`<project>/.ion/plans/<name>`). */
function isProjectPlan(sourcePath: string, manifest: TransferManifest): boolean {
  const s = manifest.sourceRoots.separator
  const parts = sourcePath.split(s)
  if (parts.length < 3 || parts[parts.length - 2] !== 'plans' || parts[parts.length - 3] !== '.ion') return false
  const legacy = manifest.sourceRoots.dataDir + s + 'plans' + s
  return !sourcePath.startsWith(legacy)
}

function withDigestSuffix(path: string, digest: string): string {
  const ext = extname(path)
  return `${path.slice(0, path.length - ext.length)}-${digest.slice(0, 8)}${ext}`
}

/**
 * Decides where every attachment lands. `workingDirectory` is where the
 * conversation lands here; a claude-code plan goes into its `.ion/plans`.
 */
export function placeAttachments(
  stagingDir: string,
  manifest: TransferManifest,
  dest: DestinationRoots,
  workingDirectory: string,
): Placement[] {
  const taken = new Set<string>()
  const placements: Placement[] = []
  for (const attachment of manifest.attachments) {
    const name = sourceBasename(attachment.sourcePath, manifest.sourceRoots.separator)
    let candidate: string
    switch (attachment.kind) {
      case 'plan':
        candidate = isProjectPlan(attachment.sourcePath, manifest) && workingDirectory
          ? join(workingDirectory, '.ion', 'plans', name)
          : join(dest.conversationsDir, attachment.ownerId, 'plans', name)
        break
      case 'tool-result':
        candidate = join(dest.conversationsDir, 'tool-results', attachment.ownerId, name)
        break
      default:
        candidate = join(dest.conversationsDir, attachment.ownerId, 'attachments', name)
    }
    const digest = manifest.files[attachment.entry] ?? sha256OfBuffer(readFileSync(join(stagingDir, attachment.entry)))
    let existing = false
    if (taken.has(candidate)) {
      candidate = withDigestSuffix(candidate, digest)
    } else if (existsSync(candidate)) {
      if (sha256OfBuffer(readFileSync(candidate)) === digest) existing = true
      else candidate = withDigestSuffix(candidate, digest)
    }
    if (!existing && existsSync(candidate) && sha256OfBuffer(readFileSync(candidate)) === digest) existing = true
    taken.add(candidate)
    placements.push({ attachment, destination: candidate, existing })
  }
  log('attachments placed', {
    count: placements.length,
    reused: placements.filter((p) => p.existing).length,
    project_plans: placements.filter((p) => p.attachment.kind === 'plan' && !p.destination.startsWith(dest.conversationsDir)).length,
  })
  return placements
}

/**
 * Every stored path's new location: the source's conversations folder maps
 * to this one (covering each conversation's own folder and spilled tool
 * output), each attachment maps to where it was placed, and the source's
 * working directory maps to the one the conversation lands in.
 */
export function destinationPathMap(manifest: TransferManifest, dest: DestinationRoots, workingDirectory: string, placements: readonly Placement[]): PathMap {
  const s = manifest.sourceRoots.separator
  const map: PathMap = { files: new Map(), dirs: new Map() }
  map.dirs.set(manifest.sourceRoots.conversationsDir + s, dest.conversationsDir + sep)
  if (manifest.sourceRoots.workingDirectory && workingDirectory) {
    // The directory itself (a stored `workingDirectory` field) and anything under it.
    map.files.set(manifest.sourceRoots.workingDirectory, workingDirectory)
    map.dirs.set(manifest.sourceRoots.workingDirectory + s, workingDirectory + sep)
  }
  for (const placement of placements) map.files.set(placement.attachment.sourcePath, placement.destination)
  return map
}

/** Top-level conversation files in staging, which are the ones that store paths. */
function stagedConversationFiles(stagingDir: string): string[] {
  const dir = join(stagingDir, 'conversations')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && (e.name.endsWith('.jsonl') || e.name.endsWith('.json') || e.name.endsWith('.md')))
    .map((e) => e.name)
}

/**
 * Rewrites every mapped path in the staged conversation files, in place.
 * Returns the digest each rewritten file now has, keyed by archive name, so
 * the committed copy is verified against what was actually written.
 */
export function rewriteStagedConversations(stagingDir: string, map: PathMap): { digests: Record<string, string>; files: number; replaced: number } {
  const digests: Record<string, string> = {}
  let replaced = 0
  for (const name of stagedConversationFiles(stagingDir)) {
    const path = join(stagingDir, 'conversations', name)
    const before = readFileSync(path, 'utf-8')
    const result = rewriteJsonText(before, map)
    if (result.replaced === 0) continue
    const bytes = Buffer.from(result.text, 'utf-8')
    writeFileSync(path, bytes)
    digests[`conversations/${name}`] = sha256OfBuffer(bytes)
    replaced += result.replaced
  }
  log('staged conversations rewritten', { files: Object.keys(digests).length, replaced })
  return { digests, files: Object.keys(digests).length, replaced }
}

/** Where an archive entry lives once committed, or null for one that is not committed (the bundle). */
export function committedPathFor(name: string, dest: DestinationRoots, placements: readonly Placement[]): string | null {
  if (name.startsWith('conversations/')) return join(dest.conversationsDir, name.slice('conversations/'.length))
  if (name.startsWith('tool-results/')) return join(dest.conversationsDir, name)
  if (name.startsWith('charts/')) return join(dest.dataDir, 'resources', name.slice('charts/'.length))
  if (name.startsWith('attachments/')) return placements.find((p) => p.attachment.entry === name)?.destination ?? null
  return null
}

/**
 * Copies staged files into place. Returns every path this import created,
 * for `rollBack`: a top-level path that already existed is never listed, so
 * a rollback can never remove something this import did not write.
 */
export function commitStagedFiles(stagingDir: string, dest: DestinationRoots, placements: readonly Placement[]): string[] {
  const written: string[] = []
  const copyTop = (from: string, to: string): void => {
    if (!existsSync(from)) return
    mkdirSync(to, { recursive: true })
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const target = join(to, entry.name)
      const existed = existsSync(target)
      if (entry.isDirectory()) cpSync(join(from, entry.name), target, { recursive: true })
      else copyFileSync(join(from, entry.name), target)
      if (!existed) written.push(target)
    }
  }
  copyTop(join(stagingDir, 'conversations'), dest.conversationsDir)
  copyTop(join(stagingDir, 'tool-results'), join(dest.conversationsDir, 'tool-results'))
  copyTop(join(stagingDir, 'charts'), join(dest.dataDir, 'resources'))
  for (const placement of placements) {
    if (placement.existing) continue
    mkdirSync(join(placement.destination, '..'), { recursive: true })
    copyFileSync(join(stagingDir, placement.attachment.entry), placement.destination)
    written.push(placement.destination)
  }
  log('staged files committed', { written: written.length, attachments: placements.filter((p) => !p.existing).length })
  return written
}

/** Removes what `commitStagedFiles` created. */
export function rollBack(written: readonly string[], fields: Record<string, unknown>): void {
  let failed = 0
  for (const path of written) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch (err) {
      failed++
      warn('rollback: could not remove a committed file', { ...fields, path, error: String(err) })
    }
  }
  log('committed files rolled back', { ...fields, step: 'rollback', outcome: failed ? 'partial' : 'removed', removed: written.length - failed })
}
