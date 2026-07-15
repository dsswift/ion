// Conversation backup: restore side.
//
// Uses yauzl to stream-read the zip and extract each entry. Conversation
// files go to ~/.ion/conversations/ via atomicWriteFileSync so a partial
// restore (user kills the app, OS crashes) cannot leave a half-written
// .tree.jsonl + .llm.jsonl pair behind.
//
// Tab restoration is opt-in (the user checks a box in the modal). When
// enabled, the backup's tabs file is merged with the local one:
// existing local tabs are preserved (by conversationId), missing tabs
// from the backup are appended. We never overwrite the local tabs file
// outright — that would lose any new tabs created since the export.

import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import yauzl from 'yauzl'
import { log as _log } from '../logger'
import { atomicWriteFileSync } from '../utils/atomicWrite'
import { validateManifest, type BackupManifest } from './manifest'

function log(msg: string, fields?: Record<string, unknown>): void { _log('backup-restore', msg, fields) }

export type ConflictPolicy = 'skip' | 'overwrite' | 'rename'

export interface RestoreSources {
  conversationsDir: string  // ~/.ion/conversations
  ionHomeDir: string        // ~/.ion (for metadata file merge)
}

export interface RestorePreview {
  ok: boolean
  error?: string
  manifest?: BackupManifest
}

export interface RestoreResult {
  ok: boolean
  error?: string
  restored: number
  skipped: number
  overwritten: number
  renamed: number
  errors: string[]
}

/**
 * Read just the manifest entry from the zip and return the parsed manifest
 * (or an error message). The full archive is NOT extracted — this is fast.
 *
 * Used by the restore modal to show "Created YYYY-MM-DD HH:MM on hostname,
 * contains N conversations" before the user commits to extracting.
 */
export async function previewRestore(zipPath: string): Promise<RestorePreview> {
  return new Promise((resolve) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        resolve({ ok: false, error: `open zip: ${err.message}` })
        return
      }
      let found = false
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== 'manifest.json') {
          zipfile.readEntry()
          return
        }
        found = true
        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            resolve({ ok: false, error: `read manifest stream: ${streamErr?.message ?? 'no stream'}` })
            zipfile.close()
            return
          }
          const chunks: Buffer[] = []
          readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
          readStream.on('end', () => {
            zipfile.close()
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
              const validated = validateManifest(parsed)
              if (typeof validated === 'string') {
                resolve({ ok: false, error: validated })
              } else {
                resolve({ ok: true, manifest: validated })
              }
            } catch (parseErr: any) {
              resolve({ ok: false, error: `parse manifest: ${parseErr.message}` })
            }
          })
          readStream.on('error', (readErr) => {
            zipfile.close()
            resolve({ ok: false, error: `manifest read: ${readErr.message}` })
          })
        })
      })
      zipfile.on('end', () => {
        if (!found) resolve({ ok: false, error: 'manifest.json not found in zip' })
      })
      zipfile.on('error', (zipErr) => {
        resolve({ ok: false, error: `zip walk: ${zipErr.message}` })
      })
      zipfile.readEntry()
    })
  })
}

/**
 * Run the restore. Walks every zip entry, dispatching to the appropriate
 * destination based on entry path:
 *   - "manifest.json" — re-validated, never written to disk.
 *   - "tabs.json" (and the legacy "tabs-{api,cli}.json" from older
 *     archives) — merged into the unified local tabs.json (only if
 *     restoreTabs=true), see mergeTabs.
 *   - "session-chains*.json", "session-labels*.json" (unified or legacy
 *     per-backend names) — merged into the unified local files (always —
 *     these are pure additive bookkeeping that drives the engine's
 *     safety guards).
 *   - "conversations/*.{tree,llm,memory,jsonl,json}" — written to
 *     ~/.ion/conversations/ with the chosen conflict policy.
 */
export async function runRestore(args: {
  zipPath: string
  conflictPolicy: ConflictPolicy
  restoreTabs: boolean
  sources: RestoreSources
}): Promise<RestoreResult> {
  const result: RestoreResult = {
    ok: false, restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [],
  }

  log('backup_restore: start', { zip: args.zipPath, conflict_policy: args.conflictPolicy, restore_tabs: args.restoreTabs })

  // Make sure the destination directory exists before we extract.
  try {
    mkdirSync(args.sources.conversationsDir, { recursive: true })
  } catch (err: any) {
    log('backup_restore: failed to create conversations dir', { error: err.message })
    return { ...result, error: `create conversations dir: ${err.message}` }
  }

  return new Promise((resolve) => {
    yauzl.open(args.zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        log('backup_restore: open zip failed', { error: err.message })
        resolve({ ...result, error: `open zip: ${err.message}` })
        return
      }
      zipfile.on('entry', (entry: yauzl.Entry) => {
        handleEntry(zipfile, entry, args, result).finally(() => zipfile.readEntry())
      })
      zipfile.on('end', () => {
        result.ok = true
        log('backup_restore: done', { restored: result.restored, skipped: result.skipped, overwritten: result.overwritten, renamed: result.renamed, errors: result.errors.length })
        resolve(result)
      })
      zipfile.on('error', (zipErr) => {
        log('backup_restore: zip walk error', { error: zipErr.message })
        resolve({ ...result, error: `zip walk: ${zipErr.message}` })
      })
      zipfile.readEntry()
    })
  })
}

async function handleEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  args: { conflictPolicy: ConflictPolicy; restoreTabs: boolean; sources: RestoreSources },
  result: RestoreResult,
): Promise<void> {
  const name = entry.fileName

  // Directory entries (trailing /) are skipped.
  if (name.endsWith('/')) return

  // Manifest is validated by previewRestore; it never gets written to disk.
  if (name === 'manifest.json') return

  // Bookkeeping JSON files — merged into the local equivalents. Legacy
  // per-backend entries (from archives exported before the unified tab
  // storage) map onto the unified local files via unifiedNameFor.
  if (unifiedNameFor(name) !== null) {
    if (unifiedNameFor(name) === 'tabs.json' && !args.restoreTabs) {
      log('backup_restore: skipping entry', { name, reason: 'restoreTabs=false' })
      return
    }
    await mergeMetadataFile(zipfile, entry, args.sources.ionHomeDir, result)
    return
  }

  if (!name.startsWith('conversations/')) {
    log('backup_restore: unknown entry ignored', { name })
    return
  }

  const fileName = name.slice('conversations/'.length)
  if (!fileName) return

  await extractConversationFile(zipfile, entry, fileName, args, result)
}

/**
 * Extract a single conversation file into ~/.ion/conversations/ with
 * conflict-policy enforcement.
 *
 * Conflict detection is per-file: if the exact same filename (i.e. same
 * conversationId AND same suffix) exists locally, we apply the policy.
 * Different suffixes for the same ID are independent — restoring a backup's
 * .tree.jsonl when only the local .llm.jsonl exists is not a conflict.
 *
 * 'rename' policy intentionally rewrites only the part of the filename
 * before the suffix. For ID `1780888135109-c1c03e998388` and suffix
 * `.tree.jsonl`, we generate a new ID via the existing format
 * `<unix-millis>-<12hex>` and append the original suffix. The renamed
 * pair (.tree + .llm + .memory) all share the same new ID.
 */
async function extractConversationFile(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  fileName: string,
  args: { conflictPolicy: ConflictPolicy; sources: RestoreSources },
  result: RestoreResult,
): Promise<void> {
  return new Promise((resolve) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        const msg = `read stream ${fileName}: ${err?.message ?? 'no stream'}`
        log('backup_restore: extractConversationFile', { msg })
        result.errors.push(msg)
        resolve()
        return
      }
      const chunks: Buffer[] = []
      readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      readStream.on('end', () => {
        try {
          const content = Buffer.concat(chunks)
          const destPath = join(args.sources.conversationsDir, fileName)
          const exists = existsSync(destPath)
          if (exists) {
            if (args.conflictPolicy === 'skip') {
              result.skipped++
              resolve()
              return
            }
            if (args.conflictPolicy === 'overwrite') {
              atomicWriteFileSync(destPath, content, 0o644)
              result.overwritten++
              resolve()
              return
            }
            // 'rename' — fall through; the renamer never collides because
            // the new ID is timestamp-based with a fresh random suffix.
            const renamedPath = renameConversationDestination(args.sources.conversationsDir, fileName)
            atomicWriteFileSync(renamedPath, content, 0o644)
            result.renamed++
            resolve()
            return
          }
          atomicWriteFileSync(destPath, content, 0o644)
          result.restored++
          resolve()
        } catch (writeErr: any) {
          const msg = `write ${fileName}: ${writeErr.message}`
          log('backup_restore: extractConversationFile', { msg })
          result.errors.push(msg)
          resolve()
        }
      })
      readStream.on('error', (readErr) => {
        const msg = `stream ${fileName}: ${readErr.message}`
        log('backup_restore: extractConversationFile', { msg })
        result.errors.push(msg)
        resolve()
      })
    })
  })
}

/**
 * Mint a fresh conversation ID for a renamed restore destination.
 *
 * Mirrors the engine's `{unix-millis}-{12-hex}` format from
 * engine/internal/backend/runloop_helpers.go so renamed conversations look
 * indistinguishable from natively-created ones to the engine.
 *
 * Only the ID portion is replaced; the file suffix (.tree.jsonl, .llm.jsonl,
 * etc.) is preserved.
 *
 * We do NOT rewrite the file content — the JSON `id` field inside the
 * .tree.jsonl and .llm.jsonl headers will still reference the old ID. The
 * engine's loader uses the *filename* as the authoritative ID, so this
 * mismatch is harmless for new loads. Power users who care about strict
 * internal consistency can edit the file post-restore.
 */
function renameConversationDestination(conversationsDir: string, originalName: string): string {
  // Strip the suffix to find the original ID.
  const suffixes = ['.tree.jsonl', '.llm.jsonl', '.memory.md', '.jsonl', '.json']
  let suffix = ''
  for (const s of suffixes) {
    if (originalName.endsWith(s)) { suffix = s; break }
  }

  // Generate a fresh ID in `{unix-millis}-{12-hex}` format.
  const millis = Date.now()
  let hex = ''
  for (let i = 0; i < 12; i++) {
    hex += Math.floor(Math.random() * 16).toString(16)
  }
  const newId = `${millis}-${hex}`
  return join(conversationsDir, newId + suffix)
}

/**
 * Merge a metadata JSON file from the backup with the local equivalent.
 *
 * Strategy depends on the file:
 *   tabs-{backend}.json — array (or {tabs: array}). Append backup tabs whose
 *     conversationId is not already present locally.
 *   session-chains-{backend}.json — {chains, reverse}. Union both maps;
 *     local entries win on key collision.
 *   session-labels-{backend}.json — flat {id: label}. Local entries win
 *     on key collision (user just renamed a conversation locally and
 *     restoring shouldn't blow that away).
 *
 * Local entries always win on collision: the user's most recent state is
 * authoritative; the backup is a recovery aid, not a replacement.
 */
async function mergeMetadataFile(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  ionHomeDir: string,
  result: RestoreResult,
): Promise<void> {
  return new Promise((resolve) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        const msg = `read metadata ${entry.fileName}: ${err?.message ?? 'no stream'}`
        log('backup_restore: mergeMetadataFile', { msg })
        result.errors.push(msg)
        resolve()
        return
      }
      const chunks: Buffer[] = []
      readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      readStream.on('end', () => {
        try {
          const backupContent = Buffer.concat(chunks).toString('utf-8')
          const backupParsed = JSON.parse(backupContent)
          // Merge into the UNIFIED local file, whatever name the archive
          // carried — a legacy tabs-api.json entry lands in tabs.json, so
          // restores of old archives never strand data in a file the
          // post-unification loader no longer reads.
          const targetName = unifiedNameFor(entry.fileName) ?? entry.fileName
          const localPath = join(ionHomeDir, targetName)
          const merged = existsSync(localPath)
            ? mergeOne(targetName, JSON.parse(readFileSync(localPath, 'utf-8')), backupParsed)
            : backupParsed
          atomicWriteFileSync(localPath, JSON.stringify(merged, null, 2), 0o644)
          log('backup_restore: mergeMetadataFile wrote', { file: entry.fileName, target: targetName })
          resolve()
        } catch (writeErr: any) {
          const msg = `merge metadata ${entry.fileName}: ${writeErr.message}`
          log('backup_restore: mergeMetadataFile', { msg })
          result.errors.push(msg)
          resolve()
        }
      })
      readStream.on('error', (readErr) => {
        const msg = `metadata stream ${entry.fileName}: ${readErr.message}`
        log('backup_restore: mergeMetadataFile', { msg })
        result.errors.push(msg)
        resolve()
      })
    })
  })
}

/**
 * Map an archive entry name onto the unified local file it merges into.
 * Accepts both the unified names (current exports) and the legacy
 * per-backend names (archives exported before tab-storage unification).
 * Returns null for entries that are not bookkeeping files.
 */
function unifiedNameFor(entryName: string): string | null {
  switch (entryName) {
    case 'tabs.json':
    case 'tabs-api.json':
    case 'tabs-cli.json':
      return 'tabs.json'
    case 'session-chains.json':
    case 'session-chains-api.json':
    case 'session-chains-cli.json':
      return 'session-chains.json'
    case 'session-labels.json':
    case 'session-labels-api.json':
    case 'session-labels-cli.json':
      return 'session-labels.json'
    default:
      return null
  }
}

function mergeOne(name: string, local: any, backup: any): any {
  if (name === 'tabs.json') {
    return mergeTabs(local, backup)
  }
  if (name === 'session-chains.json') {
    return mergeChains(local, backup)
  }
  if (name === 'session-labels.json') {
    return mergeLabels(local, backup)
  }
  // Unknown file: prefer local (do not destroy current state).
  return local
}

function mergeTabs(local: any, backup: any): any {
  const localTabs: any[] = Array.isArray(local) ? local : Array.isArray(local?.tabs) ? local.tabs : []
  const backupTabs: any[] = Array.isArray(backup) ? backup : Array.isArray(backup?.tabs) ? backup.tabs : []
  const knownIds = new Set<string>()
  for (const tab of localTabs) {
    if (typeof tab?.conversationId === 'string') knownIds.add(tab.conversationId)
  }
  const appended = [...localTabs]
  for (const tab of backupTabs) {
    if (typeof tab?.conversationId === 'string' && !knownIds.has(tab.conversationId)) {
      appended.push(tab)
      knownIds.add(tab.conversationId)
    }
  }
  // Preserve the top-level shape of `local` (array vs. {tabs}).
  if (Array.isArray(local)) return appended
  return { ...(local || {}), tabs: appended }
}

function mergeChains(local: any, backup: any): any {
  const out: any = { chains: { ...(local?.chains || {}) }, reverse: { ...(local?.reverse || {}) } }
  for (const [k, v] of Object.entries(backup?.chains || {})) {
    if (!(k in out.chains)) out.chains[k] = v
  }
  for (const [k, v] of Object.entries(backup?.reverse || {})) {
    if (!(k in out.reverse)) out.reverse[k] = v
  }
  return out
}

function mergeLabels(local: any, backup: any): any {
  const out: Record<string, string> = { ...(local || {}) }
  for (const [k, v] of Object.entries(backup || {})) {
    if (!(k in out) && typeof v === 'string') out[k] = v
  }
  return out
}
