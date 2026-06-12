// Conversation backup: export side.
//
// Streams every collected conversation file plus the desktop's tabs,
// chains, and labels files into a .zip via the archiver library.
// archiver's streaming writer means we never buffer the whole archive
// in memory — this is important when a user picks the 'all' scope with
// 7K conversations totaling 6.9 GB on disk.

import { createWriteStream, existsSync, readFileSync, statSync } from 'fs'
import { hostname } from 'os'
import { basename } from 'path'
import archiver from 'archiver'
import { log as _log } from '../logger'
import { collectExportConversations, type ConversationFiles } from './collect-conversations'
import { buildManifest, type ExportScope } from './manifest'

function log(msg: string): void { _log('backup-export', msg) }

export interface ExportSources {
  conversationsDir: string
  tabsFiles: string[]      // [tabs-api.json, tabs-cli.json]
  chainsFiles: string[]    // [session-chains-api.json, session-chains-cli.json]
  labelsFiles: string[]    // [session-labels-api.json, session-labels-cli.json]
}

export interface ExportPreview {
  conversationCount: number
  totalUncompressedBytes: number
  estimatedCompressedBytes: number
  /**
   * Tab count across all input tabs files, only populated for
   * scope='currently-open'. Undefined for scope='all' because the tabs
   * files are not consulted in that path. The renderer uses this to
   * render "N tabs across M conversation sessions" so the user can
   * relate the export size to their visible workspace.
   */
  tabCount?: number
}

export interface ExportResult {
  ok: boolean
  error?: string
  destinationPath?: string
  conversationCount?: number
  bytesWritten?: number
}

export type ProgressCallback = (current: number, total: number, label: string) => void

/**
 * Compute a fast preview for the export modal — no zip is created.
 *
 * estimatedCompressedBytes is a rough guess (50% of uncompressed for
 * JSONL/text; conversations compress very well). It's only used to
 * give the user a "this will be roughly X MB" hint in the UI, never
 * for a hard size budget.
 */
export function previewExport(args: {
  scope: ExportScope
  sources: ExportSources
}): ExportPreview {
  const { files, tabCount } = collectExportConversations({
    scope: args.scope,
    conversationsDir: args.sources.conversationsDir,
    tabsFiles: args.sources.tabsFiles,
    chainsFiles: args.sources.chainsFiles,
  })
  const totalUncompressedBytes = files.reduce((sum, f) => sum + f.totalBytes, 0)
  return {
    conversationCount: files.length,
    totalUncompressedBytes,
    estimatedCompressedBytes: Math.round(totalUncompressedBytes * 0.5),
    tabCount,
  }
}

/**
 * Run the export. Streams every file into the zip and returns when
 * the zip stream is fully flushed to disk.
 *
 * Progress events fire once per included conversation (not once per file)
 * so the UI's "Compressing N of M…" message advances at a meaningful rate.
 * The metadata files (manifest + tabs + chains + labels) all flush before
 * the first conversation progress event, so the user sees movement
 * starting on conversation 1.
 *
 * The destination is written atomically-ish: archiver writes to the
 * destination path directly, and on error we attempt to unlink the
 * partial file. We do NOT use a sibling temp file + rename here because
 * archiver's stream-end is the natural fsync point and writing 6 GB
 * to a temp file just to rename it doubles the I/O cost.
 */
export async function runExport(args: {
  scope: ExportScope
  destinationPath: string
  sources: ExportSources
  ionVersion: string
  backendSnapshot: 'api' | 'cli'
  onProgress?: ProgressCallback
}): Promise<ExportResult> {
  const { files: conversationFiles } = collectExportConversations({
    scope: args.scope,
    conversationsDir: args.sources.conversationsDir,
    tabsFiles: args.sources.tabsFiles,
    chainsFiles: args.sources.chainsFiles,
  })

  log(`runExport: scope=${args.scope} destination=${args.destinationPath} conversations=${conversationFiles.length}`)

  if (conversationFiles.length === 0 && args.scope === 'currently-open') {
    return { ok: false, error: 'No conversations found for the selected scope. Open at least one tab before exporting.' }
  }

  const manifest = buildManifest({
    scope: args.scope,
    conversationCount: conversationFiles.length,
    backendSnapshot: args.backendSnapshot,
    ionVersion: args.ionVersion,
    hostname: hostname(),
  })

  return new Promise((resolve) => {
    const output = createWriteStream(args.destinationPath)
    const archive = archiver('zip', { zlib: { level: 6 } })

    let bytesWritten = 0
    let settled = false
    const settle = (result: ExportResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    output.on('close', () => {
      log(`runExport: closed bytesWritten=${bytesWritten} destination=${args.destinationPath}`)
      settle({
        ok: true,
        destinationPath: args.destinationPath,
        conversationCount: conversationFiles.length,
        bytesWritten,
      })
    })
    output.on('error', (err: Error) => {
      log(`runExport: write stream error err=${err.message}`)
      settle({ ok: false, error: `write stream: ${err.message}` })
    })
    archive.on('error', (err: Error) => {
      log(`runExport: archive error err=${err.message}`)
      settle({ ok: false, error: `archive: ${err.message}` })
    })
    archive.on('warning', (err: Error) => {
      // ENOENT warnings are non-fatal (a metadata file disappeared mid-export);
      // log them so the user sees what was skipped.
      log(`runExport: archive warning err=${err.message}`)
    })
    archive.on('progress', (data: archiver.ProgressData) => {
      bytesWritten = data.fs.processedBytes
    })

    archive.pipe(output)

    // 1) Manifest first — restore UI can stream-read just this entry to
    //    show the summary before extracting anything.
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' })

    // 2) Metadata files (tabs, chains, labels for both backends).
    appendMetadataFiles(archive, args.sources)

    // 3) Conversation files.
    let conversationIndex = 0
    for (const conv of conversationFiles) {
      conversationIndex++
      for (const path of conv.paths) {
        archive.file(path, { name: 'conversations/' + basename(path) })
      }
      args.onProgress?.(conversationIndex, conversationFiles.length, conv.id)
    }

    // archive.finalize() flushes the zip central directory and ends the
    // stream. The 'close' handler on `output` will fire after that.
    archive.finalize().catch((err: Error) => {
      log(`runExport: finalize error err=${err.message}`)
      settle({ ok: false, error: `finalize: ${err.message}` })
    })
  })
}

/**
 * Append the desktop's bookkeeping files (tabs, chains, labels for both
 * backends) into the zip at the root level. Missing files are skipped
 * silently — a fresh install may not have all of them yet.
 */
function appendMetadataFiles(
  archive: archiver.Archiver,
  sources: ExportSources,
): void {
  const allMetadata = [
    ...sources.tabsFiles,
    ...sources.chainsFiles,
    ...sources.labelsFiles,
  ]
  for (const path of allMetadata) {
    if (!path || !existsSync(path)) continue
    try {
      // Read the file content and append it under its bare basename
      // (e.g. "tabs-api.json" at the zip root, not "/Users/.../tabs-api.json").
      const content = readFileSync(path)
      archive.append(content, { name: basename(path) })
      const size = statSync(path).size
      log(`appendMetadataFiles: included ${basename(path)} (${size} bytes)`)
    } catch (err: any) {
      log(`appendMetadataFiles: skipped ${path} due to read error: ${err.message}`)
    }
  }
}

// Re-export the file shape so tests and callers can introspect a planned
// export without running it.
export type { ConversationFiles }
