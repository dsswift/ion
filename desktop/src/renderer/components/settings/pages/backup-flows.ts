/**
 * backup-flows — the state and steps of the two conversation-archive flows
 * the Backup section runs: export (scope, preview, destination, progress,
 * result) and restore (file, summary, conflict policy, result).
 *
 * Both call `host.shell` directly: an archive is written and read on the
 * local server's host, whatever server the Settings sidebar has picked.
 */
import { useState } from 'react'
import { host } from '../../../host/host-instance'
import { rError, rInfo, rWarn } from '../../../rendererLogger'

type Shell = typeof host.shell
export type ExportScope = Parameters<Shell['conversationExportPreview']>[0]
export type ConflictPolicy = NonNullable<Parameters<Shell['conversationRestore']>[0]['conflictPolicy']>
export type ExportResult = Awaited<ReturnType<Shell['conversationExport']>>
export type RestoreResult = Awaited<ReturnType<Shell['conversationRestore']>>
export type RestoreManifest = NonNullable<Awaited<ReturnType<Shell['conversationRestorePreview']>>['manifest']>
export type BackupProgress = Parameters<Parameters<Shell['onConversationBackupProgress']>[0]>[0]

export interface ExportPreview {
  conversationCount: number
  totalUncompressedBytes: number
  estimatedCompressedBytes: number
  /** Only for 'currently-open': the tabs the conversations come from. */
  tabCount?: number
}

const ZIP_FILTERS = [{ name: 'Zip Archive', extensions: ['zip'] }]

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** `ion-conversations-YYYYMMDD-HHMMSS.zip`, the name the save dialog opens with. */
function defaultExportFilename(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `ion-conversations-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export interface ExportFlow {
  open: boolean
  scope: ExportScope
  preview: ExportPreview | null
  exporting: boolean
  progress: BackupProgress | null
  result: ExportResult | null
  begin(): void
  setScope(scope: ExportScope): void
  run(): void
  close(): void
}

export function useExportFlow(): ExportFlow {
  const [open, setOpen] = useState(false)
  const [scope, setScopeState] = useState<ExportScope>('all')
  const [preview, setPreview] = useState<ExportPreview | null>(null)
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState<BackupProgress | null>(null)
  const [result, setResult] = useState<ExportResult | null>(null)

  const refreshPreview = async (next: ExportScope): Promise<void> => {
    try {
      const res = await host.shell.conversationExportPreview(next)
      if (res.ok) {
        setPreview({ conversationCount: res.conversationCount ?? 0, totalUncompressedBytes: res.totalUncompressedBytes ?? 0, estimatedCompressedBytes: res.estimatedCompressedBytes ?? 0, tabCount: res.tabCount })
      } else {
        rWarn('backup', 'export preview refused', { scope: next, error: res.error })
        setPreview(null)
      }
    } catch (err: unknown) {
      rWarn('backup', 'export preview failed', { scope: next, error: String(err) })
      setPreview(null)
    }
  }

  const exportTo = async (): Promise<void> => {
    if (exporting) return
    setExporting(true); setProgress(null); setResult(null)
    // The archive path is the client's to choose; a cancel is not a result.
    let destinationPath: string | null
    try {
      const picked = await host.pickSavePath(undefined, defaultExportFilename(), ZIP_FILTERS)
      if (picked.error) { setResult({ ok: false, error: picked.error }); setExporting(false); return }
      destinationPath = picked.filePath
    } catch (err: unknown) {
      setResult({ ok: false, error: message(err) }); setExporting(false); return
    }
    if (!destinationPath) {
      rInfo('backup', 'export cancelled at the save dialog')
      setExporting(false)
      return
    }
    const unsubscribe = host.shell.onConversationBackupProgress((data) => setProgress(data))
    try {
      setResult(await host.shell.conversationExport({ scope, destinationPath }))
    } catch (err: unknown) {
      setResult({ ok: false, error: message(err) })
    } finally {
      setExporting(false); setProgress(null); unsubscribe()
    }
  }

  return {
    open, scope, preview, exporting, progress, result,
    begin: () => {
      setOpen(true); setResult(null); setPreview(null)
      void refreshPreview(scope).catch((err: unknown) => rError('settings', 'open export failed', { error: String(err) }))
    },
    setScope: (next) => {
      setScopeState(next)
      void refreshPreview(next).catch((err: unknown) => rError('settings', 'scope change failed', { error: String(err) }))
    },
    run: () => { void exportTo().catch((err: unknown) => rError('settings', 'export failed', { error: String(err) })) },
    close: () => { if (exporting) return; setOpen(false); setResult(null); setPreview(null) },
  }
}

export interface RestoreFlow {
  open: boolean
  sourcePath: string | null
  manifest: RestoreManifest | null
  conflictPolicy: ConflictPolicy
  restoreTabs: boolean
  restoring: boolean
  result: RestoreResult | null
  begin(): void
  setConflictPolicy(policy: ConflictPolicy): void
  setRestoreTabs(on: boolean): void
  run(): void
  close(): void
}

const failed = (error: string): RestoreResult => ({ ok: false, error, restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] })

export function useRestoreFlow(): RestoreFlow {
  const [open, setOpen] = useState(false)
  const [sourcePath, setSourcePath] = useState<string | null>(null)
  const [manifest, setManifest] = useState<RestoreManifest | null>(null)
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('skip')
  const [restoreTabs, setRestoreTabs] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [result, setResult] = useState<RestoreResult | null>(null)

  const pick = async (): Promise<void> => {
    try {
      const picked = await host.pickFile({ filters: ZIP_FILTERS })
      const path = picked?.[0]
      if (!path) {
        rInfo('backup', 'restore cancelled at the open dialog')
        setOpen(false)
        return
      }
      const res = await host.shell.conversationRestorePreview({ sourcePath: path })
      setSourcePath(res.sourcePath ?? path)
      if (res.ok && res.manifest) setManifest(res.manifest)
      else setResult(failed(res.error || 'failed to read backup'))
    } catch (err: unknown) {
      setResult(failed(message(err)))
    }
  }

  const restore = async (): Promise<void> => {
    if (restoring || !sourcePath) return
    setRestoring(true); setResult(null)
    try {
      setResult(await host.shell.conversationRestore({ sourcePath, conflictPolicy, restoreTabs }))
    } catch (err: unknown) {
      setResult(failed(message(err)))
    } finally {
      setRestoring(false)
    }
  }

  return {
    open, sourcePath, manifest, conflictPolicy, restoreTabs, restoring, result, setConflictPolicy, setRestoreTabs,
    begin: () => {
      setOpen(true); setResult(null); setSourcePath(null); setManifest(null)
      void pick().catch((err: unknown) => rError('settings', 'open restore failed', { error: String(err) }))
    },
    run: () => { void restore().catch((err: unknown) => rError('settings', 'restore failed', { error: String(err) })) },
    close: () => { if (restoring) return; setOpen(false); setResult(null); setSourcePath(null); setManifest(null) },
  }
}
