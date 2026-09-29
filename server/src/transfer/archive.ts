/**
 * transfer/archive — the streaming archive writer/reader for a transfer
 * (spec 10). Same shape as `conversation-backup`'s zip (built with the same
 * `archiver`/`yauzl` pair that module already uses), plus two things a
 * backup archive never carries: `transfer.json` at the root (see
 * `manifest.ts`) and an optional `worktree.bundle`.
 *
 * Both directions stream through disk, never through memory: `buildArchive`
 * writes straight to a `createWriteStream` destination (archiver's own
 * streaming write, identical to `conversation-backup/export.ts`), and
 * `extractArchive` reads each zip entry via `yauzl`'s `openReadStream` and
 * pipes it straight to its destination file. What goes in is decided and
 * digested first by `entries.ts`; this module only writes the plan.
 */
import { createWriteStream, existsSync, mkdirSync, statSync } from 'fs'
import { pipeline } from 'stream/promises'
import { dirname, join } from 'path'
import { ZipArchive, type ProgressData } from 'archiver'
import yauzl from 'yauzl'
import { log as _log, warn as _warn } from '../logger'
import type { PlannedEntry } from './entries'
import type { TransferManifest, TransferManifestValidation } from './manifest'
import { validateTransferManifest } from './manifest'

const TAG = 'transfer.archive'
function log(msg: string, fields?: Record<string, unknown>): void {
  _log(TAG, msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn(TAG, msg, fields)
}

export interface BuildArchiveArgs {
  destinationPath: string
  manifest: TransferManifest
  /**
   * Exactly what goes in, already planned and digested by
   * `entries.ts#planTransferEntries`. Passing the plan rather than the
   * members is what makes `manifest.files` describe the bytes actually
   * written: one list produces both.
   */
  entries: readonly PlannedEntry[]
}

export interface BuildArchiveResult {
  ok: boolean
  error?: string
  bytesWritten?: number
}

/**
 * Build the transfer archive to `destinationPath` on disk. A 200MB archive
 * streams through this without buffering it in memory: `archiver` writes
 * incrementally to the destination `WriteStream` exactly as
 * `conversation-backup/export.ts` already does for full backups.
 */
export async function buildTransferArchive(args: BuildArchiveArgs): Promise<BuildArchiveResult> {
  mkdirSync(dirname(args.destinationPath), { recursive: true })
  log('build: start', { destination: args.destinationPath, entry_count: args.entries.length })

  return new Promise((resolve) => {
    const output = createWriteStream(args.destinationPath)
    const archive = new ZipArchive({ zlib: { level: 6 } })

    let bytesWritten = 0
    /** Uncompressed input read off disk. Logged beside the archive size; never published as the transfer total. */
    let inputBytes = 0
    let settled = false
    const settle = (result: BuildArchiveResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    output.on('close', () => {
      // The bytes actually on disk, which is what the archive stream will
      // send. `archiver`'s progress event reports `fs.processedBytes` — the
      // INPUT bytes read off the filesystem — and the zip is deflated, so
      // that number is larger than the file by the compression ratio. It was
      // being published as the transfer's `totalBytes`, and the receiving
      // desktop, which completes when it has counted that many bytes, then
      // waited forever for bytes that never existed.
      bytesWritten = output.bytesWritten
      log('build: closed', { bytes_written: bytesWritten, input_bytes: inputBytes, destination: args.destinationPath })
      settle({ ok: true, bytesWritten })
    })
    output.on('error', (err: Error) => {
      warn('build: write stream error', { error: err.message })
      settle({ ok: false, error: `write stream: ${err.message}` })
    })
    archive.on('error', (err: Error) => {
      warn('build: archive error', { error: err.message })
      settle({ ok: false, error: `archive: ${err.message}` })
    })
    archive.on('warning', (err: Error) => {
      warn('build: archive warning', { error: err.message })
    })
    archive.on('progress', (data: ProgressData) => {
      inputBytes = data.fs.processedBytes
    })

    archive.pipe(output)
    archive.append(JSON.stringify(args.manifest, null, 2), { name: 'transfer.json' })
    for (const entry of args.entries) {
      if (entry.content) archive.append(entry.content, { name: entry.name })
      else archive.file(entry.path!, { name: entry.name })
    }

    archive.finalize().catch((err: Error) => {
      warn('build: finalize error', { error: err.message })
      settle({ ok: false, error: `finalize: ${err.message}` })
    })
  })
}

export interface ExtractedArchive {
  ok: boolean
  error?: string
  manifest?: TransferManifest
  /** Absolute path to `<destDir>/worktree.bundle`, if the archive carried one. */
  bundlePath?: string
}

/**
 * Extract a transfer archive into `destDir` (a staging directory the caller
 * creates and, on any failure, deletes wholesale — this function never
 * partially cleans up, it only ever reports success or failure).
 *
 * `transfer.json` is validated before any conversation file is written, so
 * a version mismatch or malformed manifest is caught before touching disk
 * beyond the destination directory itself.
 */
export async function extractTransferArchive(archivePath: string, destDir: string): Promise<ExtractedArchive> {
  mkdirSync(destDir, { recursive: true })
  mkdirSync(join(destDir, 'conversations'), { recursive: true })

  let manifestValidation: TransferManifestValidation | null = null
  let bundlePath: string | undefined
  // A corrupted entry (truncated archive, bad CRC) must fail the WHOLE
  // extraction — a partially-extracted family is exactly the "nothing is
  // written" contract this function exists to uphold. The first entry
  // failure wins; later entries are still drained (readEntry keeps firing)
  // so the zip walk reaches 'end' and this function settles instead of hanging.
  let entryError: string | null = null

  return new Promise((resolve) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        resolve({ ok: false, error: `open archive: ${err.message}` })
        return
      }
      const pending: Promise<void>[] = []
      zipfile.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName.endsWith('/')) {
          zipfile.readEntry()
          return
        }
        const task = extractEntry(zipfile, entry, destDir)
          .then((result) => {
            if (entry.fileName === 'transfer.json') manifestValidation = result.manifestValidation ?? null
            if (entry.fileName === 'worktree.bundle') bundlePath = join(destDir, 'worktree.bundle')
          })
          .catch((extractErr: unknown) => {
            warn('extract: entry failed', { name: entry.fileName, error: String(extractErr) })
            entryError = entryError ?? `extract ${entry.fileName}: ${String(extractErr)}`
          })
        pending.push(task)
        task.finally(() => zipfile.readEntry())
      })
      zipfile.on('end', () => {
        Promise.all(pending).then(() => {
          if (entryError) {
            resolve({ ok: false, error: entryError })
            return
          }
          if (!manifestValidation) {
            resolve({ ok: false, error: 'transfer.json not found in archive' })
            return
          }
          if (!manifestValidation.ok) {
            resolve({ ok: false, error: manifestValidation.message })
            return
          }
          resolve({ ok: true, manifest: manifestValidation.manifest, bundlePath })
        }).catch((allErr: unknown) => resolve({ ok: false, error: String(allErr) }))
      })
      zipfile.on('error', (zipErr) => resolve({ ok: false, error: `archive walk: ${zipErr.message}` }))
      zipfile.readEntry()
    })
  })
}

async function extractEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destDir: string,
): Promise<{ manifestValidation?: TransferManifestValidation }> {
  if (entry.fileName === 'transfer.json') {
    const buffer = await readEntryToBuffer(zipfile, entry)
    try {
      return { manifestValidation: validateTransferManifest(JSON.parse(buffer.toString('utf-8'))) }
    } catch (err) {
      return { manifestValidation: { ok: false, code: 'invalid_manifest', message: `parse transfer.json: ${String(err)}` } }
    }
  }

  // Every other entry (conversations/*, tool-results/*, charts/*,
  // attachments/*, worktree.bundle) streams straight to its destination path
  // — never buffered as a whole Buffer. yauzl has already refused any name
  // with `..` or an absolute path (archive-path-escape.test.ts).
  const destPath = join(destDir, entry.fileName)
  mkdirSync(dirname(destPath), { recursive: true })
  await new Promise<void>((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        reject(err ?? new Error('no read stream'))
        return
      }
      pipeline(readStream, createWriteStream(destPath)).then(resolve).catch(reject)
    })
  })
  return {}
}

function readEntryToBuffer(zipfile: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (err, readStream) => {
      if (err || !readStream) {
        reject(err ?? new Error('no read stream'))
        return
      }
      const chunks: Buffer[] = []
      readStream.on('data', (chunk: Buffer) => chunks.push(chunk))
      readStream.on('end', () => resolve(Buffer.concat(chunks)))
      readStream.on('error', reject)
    })
  })
}

/** Size on disk of an archive already built (used for the `totalBytes` ack). */
export function archiveSizeBytes(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}
