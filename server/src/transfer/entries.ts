/**
 * transfer/entries — what goes into a transfer archive, and the digest of
 * each piece.
 *
 * A transfer deletes the source once the destination confirms it landed, so
 * "it landed" has to mean more than "the action returned ok". Every entry is
 * hashed here at export time and the digests travel inside the manifest;
 * the destination re-hashes what it extracted and what it committed and
 * compares. Only a full match lets the source be removed.
 *
 * Planning is separated from writing for one reason: the manifest carries
 * the digests, and the manifest is itself an entry in the archive. So the
 * content of every other entry has to be settled before the archive is
 * opened. Planning returns exactly the bytes that will be written — a tree
 * file with its native sessions stripped is planned as the stripped buffer,
 * never as its path — so a digest can never describe something other than
 * what shipped.
 */
import { createHash } from 'crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'
import type { FamilyMember } from './collect-family'
import { log as _log, warn as _warn } from '../logger'

const TAG = 'transfer.entries'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

/** One file in the archive: either bytes already in hand, or a path to stream. */
export interface PlannedEntry {
  /** Archive-relative name, e.g. `conversations/<id>.llm.jsonl`. */
  name: string
  /** Set when the entry's bytes are produced rather than copied. */
  content?: Buffer
  /** Set when the entry is a file on disk, streamed into the archive. */
  path?: string
}

/** sha256 of a file on disk, streamed. */
export function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
    stream.on('error', reject)
  })
}

/** sha256 of bytes already in memory. */
export function sha256OfBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * A `.tree.jsonl` with `nativeSessions` stripped from its header — the
 * provider cursors are meaningless on another machine. Returns the file
 * unchanged when there is nothing to strip or the header will not parse.
 */
export function treeFileWithoutNativeSessions(path: string): Buffer {
  const buffer = readFileSync(path)
  const newline = buffer.indexOf(0x0a)
  const headerEnd = newline === -1 ? buffer.length : newline
  let header: Record<string, unknown>
  try {
    header = JSON.parse(buffer.subarray(0, headerEnd).toString('utf-8')) as Record<string, unknown>
  } catch (err) {
    warn('tree header unparseable, shipping the file unmodified', { path, error: String(err) })
    return buffer
  }
  if (!('nativeSessions' in header)) return buffer
  delete header.nativeSessions
  const rest = newline === -1 ? Buffer.alloc(0) : buffer.subarray(newline)
  return Buffer.concat([Buffer.from(JSON.stringify(header)), rest])
}

/** Every file under `dir`, archive-named relative to `archivePrefix`. */
function planDirectory(dir: string, archivePrefix: string): PlannedEntry[] {
  const out: PlannedEntry[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const parent = (entry as { parentPath?: string; path?: string }).parentPath ?? (entry as { path?: string }).path ?? dir
    const full = join(parent, entry.name)
    if (!statSync(full).isFile()) continue
    out.push({ name: `${archivePrefix}/${relative(dir, full).split('\\').join('/')}`, path: full })
  }
  return out
}

/** The files outside the family's own folders a transfer carries, one archive entry each. */
export interface AttachmentEntry {
  /** Archive name, `attachments/<n>`. */
  name: string
  path: string
}

/**
 * Everything a transfer archive carries except `transfer.json` itself:
 *
 *   conversations/<id>.*     each family member's conversation files
 *   conversations/<id>/...   the folder it owns: plans, attachments, images
 *   tool-results/<id>/...    its spilled tool output
 *   charts/<id>/...          its charts, from `<dataDir>/resources/<id>/`
 *   attachments/<n>          a file outside those folders its history names
 *   worktree.bundle          the worktree, when it travels
 */
export function planTransferEntries(
  conversationsDir: string,
  members: readonly FamilyMember[],
  bundlePath: string | null,
  extras: { chartsRoot?: string; attachments?: readonly AttachmentEntry[] } = {},
): PlannedEntry[] {
  const entries: PlannedEntry[] = []
  for (const member of members) {
    for (const path of member.paths) {
      if (path.endsWith('.tree.jsonl')) {
        entries.push({ name: `conversations/${member.id}.tree.jsonl`, content: treeFileWithoutNativeSessions(path) })
      } else {
        const suffix = path.slice(conversationsDir.length + 1 + member.id.length)
        entries.push({ name: `conversations/${member.id}${suffix}`, path })
      }
    }
    if (member.ownedDir) entries.push(...planDirectory(member.ownedDir, `conversations/${member.id}`))
    if (member.toolResultsDir) entries.push(...planDirectory(member.toolResultsDir, `tool-results/${member.id}`))
    if (extras.chartsRoot) {
      const charts = join(extras.chartsRoot, member.id)
      if (existsSync(charts)) entries.push(...planDirectory(charts, `charts/${member.id}`))
    }
  }
  for (const attachment of extras.attachments ?? []) entries.push({ name: attachment.name, path: attachment.path })
  if (bundlePath) entries.push({ name: 'worktree.bundle', path: bundlePath })
  return entries
}

/** The sha256 of every planned entry, keyed by its archive name. */
export async function digestEntries(entries: readonly PlannedEntry[]): Promise<Record<string, string>> {
  const digests: Record<string, string> = {}
  for (const entry of entries) {
    digests[entry.name] = entry.content ? sha256OfBuffer(entry.content) : await sha256OfFile(entry.path!)
  }
  log('entries digested', { entry_count: entries.length })
  return digests
}

export interface VerificationResult {
  ok: boolean
  /** Entries whose bytes on disk did not match the digest the source recorded. */
  mismatched: string[]
  /** Entries the manifest declared that are not on disk at all. */
  missing: string[]
  checked: number
}

/**
 * Re-hash `files` under `root` and compare against the digests the source
 * recorded. `skip` names entries that legitimately do not exist at `root`
 * (the worktree bundle is consumed by git rather than committed).
 */
export async function verifyAgainstDigests(
  root: string,
  files: Record<string, string>,
  opts: { skip?: (name: string) => boolean; nameToPath?: (name: string) => string } = {},
): Promise<VerificationResult> {
  const mismatched: string[] = []
  const missing: string[] = []
  let checked = 0
  for (const [name, expected] of Object.entries(files)) {
    if (opts.skip?.(name)) continue
    const path = opts.nameToPath ? opts.nameToPath(name) : join(root, name)
    let actual: string
    try {
      actual = await sha256OfFile(path)
    } catch (err) {
      warn('verification: file missing', { name, path, error: String(err) })
      missing.push(name)
      continue
    }
    checked += 1
    if (actual !== expected) {
      warn('verification: digest mismatch', { name, path, expected, actual })
      mismatched.push(name)
    }
  }
  const ok = mismatched.length === 0 && missing.length === 0
  log('verification complete', { root, checked, mismatched: mismatched.length, missing: missing.length, outcome: ok ? 'ok' : 'failed' })
  return { ok, mismatched, missing, checked }
}
