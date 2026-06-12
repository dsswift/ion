import React, { useState } from 'react'
import { Archive, ArrowCounterClockwise, CheckCircle, WarningCircle, ShieldCheck } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { SettingHeading } from './SettingHeading'
import {
  formatBytes,
  type ConflictPolicy,
  type ExportPreview,
  type ExportResult,
  type ExportScope,
  type RestoreManifest,
  type RestoreResult,
} from './BackupRestoreCategory.types'
import { BackupRestoreOptionRadio } from './BackupRestoreOptionRadio'
import { RestoreModalContent } from './BackupRestoreModal'

export function BackupRestoreCategory() {
  const colors = useColors()

  // ─── Export state ───
  const [exportOpen, setExportOpen] = useState(false)
  const [exportScope, setExportScope] = useState<ExportScope>('all')
  const [exportPreview, setExportPreview] = useState<ExportPreview | null>(null)
  const [exporting, setExporting] = useState(false)
  const [exportProgress, setExportProgress] = useState<{ current: number; total: number; label: string } | null>(null)
  const [exportResult, setExportResult] = useState<ExportResult | null>(null)

  // ─── Restore state ───
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [restorePreview, setRestorePreview] = useState<{ sourcePath?: string; manifest?: RestoreManifest } | null>(null)
  const [conflictPolicy, setConflictPolicy] = useState<ConflictPolicy>('skip')
  const [restoreTabs, setRestoreTabs] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [restoreResult, setRestoreResult] = useState<RestoreResult | null>(null)

  // ─── Card style (matches MigrationCategory) ───
  const cardStyle: React.CSSProperties = {
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 8,
  }

  // ─── Export handlers ───
  const openExportModal = async () => {
    setExportOpen(true)
    setExportResult(null)
    setExportPreview(null)
    await refreshExportPreview(exportScope)
  }

  const refreshExportPreview = async (scope: ExportScope) => {
    try {
      const res = await window.ion?.conversationExportPreview(scope)
      if (res?.ok) {
        setExportPreview({
          conversationCount: res.conversationCount ?? 0,
          totalUncompressedBytes: res.totalUncompressedBytes ?? 0,
          estimatedCompressedBytes: res.estimatedCompressedBytes ?? 0,
          tabCount: res.tabCount,
        })
      } else {
        setExportPreview(null)
      }
    } catch {
      setExportPreview(null)
    }
  }

  const handleScopeChange = async (scope: ExportScope) => {
    setExportScope(scope)
    await refreshExportPreview(scope)
  }

  const handleExport = async () => {
    if (exporting) return
    setExporting(true)
    setExportProgress(null)
    setExportResult(null)
    const unsubscribe = window.ion?.onConversationBackupProgress?.((data) => setExportProgress(data))
    try {
      const res = await window.ion?.conversationExport({ scope: exportScope })
      setExportResult(res || { ok: false, error: 'no response', restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] } as any)
    } catch (err: any) {
      setExportResult({ ok: false, error: err.message })
    } finally {
      setExporting(false)
      setExportProgress(null)
      unsubscribe?.()
    }
  }

  // ─── Restore handlers ───
  const openRestoreModal = async () => {
    setRestoreOpen(true)
    setRestoreResult(null)
    setRestorePreview(null)
    try {
      const res = await window.ion?.conversationRestorePreview()
      if (res?.ok && res.manifest) {
        setRestorePreview({ sourcePath: res.sourcePath, manifest: res.manifest as RestoreManifest })
      } else if (res?.error === 'cancelled') {
        setRestoreOpen(false)
      } else {
        setRestorePreview({ sourcePath: res?.sourcePath })
        setRestoreResult({ ok: false, error: res?.error || 'failed to read backup', restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] })
      }
    } catch (err: any) {
      setRestoreResult({ ok: false, error: err.message, restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] })
    }
  }

  const handleRestore = async () => {
    if (restoring || !restorePreview?.sourcePath) return
    setRestoring(true)
    setRestoreResult(null)
    try {
      const res = await window.ion?.conversationRestore({
        sourcePath: restorePreview.sourcePath,
        conflictPolicy,
        restoreTabs,
      })
      setRestoreResult(res || { ok: false, error: 'no response', restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] })
    } catch (err: any) {
      setRestoreResult({ ok: false, error: err.message, restored: 0, skipped: 0, overwritten: 0, renamed: 0, errors: [] })
    } finally {
      setRestoring(false)
    }
  }

  // ─── Render ───
  return (
    <>
      <SettingHeading>Backup &amp; Restore</SettingHeading>

      <div style={{ ...cardStyle, display: 'flex', alignItems: 'center', gap: 8 }}>
        <ShieldCheck size={16} color={colors.accent} />
        <span style={{ fontSize: 12, color: colors.textSecondary }}>
          Export a zip of your conversations as a portable backup. Restoring is always opt-in and never overwrites local files without explicit confirmation.
        </span>
      </div>

      {!exportOpen && !restoreOpen && (
        <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
          <button onClick={openExportModal} style={primaryButtonStyle(colors)}>
            <Archive size={16} />
            Export conversations…
          </button>
          <button onClick={openRestoreModal} style={secondaryButtonStyle(colors)}>
            <ArrowCounterClockwise size={16} />
            Restore from backup…
          </button>
        </div>
      )}

      {exportOpen && (
        <ExportModalContent
          scope={exportScope}
          preview={exportPreview}
          exporting={exporting}
          progress={exportProgress}
          result={exportResult}
          onScopeChange={handleScopeChange}
          onExport={handleExport}
          onClose={() => { setExportOpen(false); setExportResult(null); setExportPreview(null) }}
          cardStyle={cardStyle}
          colors={colors}
        />
      )}

      {restoreOpen && (
        <RestoreModalContent
          preview={restorePreview}
          conflictPolicy={conflictPolicy}
          restoreTabs={restoreTabs}
          restoring={restoring}
          result={restoreResult}
          onConflictPolicyChange={setConflictPolicy}
          onRestoreTabsChange={setRestoreTabs}
          onRestore={handleRestore}
          onClose={() => { setRestoreOpen(false); setRestoreResult(null); setRestorePreview(null) }}
          cardStyle={cardStyle}
          colors={colors}
        />
      )}
    </>
  )
}

function primaryButtonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    flex: 1, padding: '8px 12px',
    background: colors.accent, border: 'none', borderRadius: 8,
    color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600,
  }
}

function secondaryButtonStyle(colors: ReturnType<typeof useColors>): React.CSSProperties {
  return {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    flex: 1, padding: '8px 12px',
    background: colors.containerBg, border: `1px solid ${colors.containerBorder}`, borderRadius: 8,
    color: colors.textPrimary, cursor: 'pointer', fontSize: 13, fontWeight: 600,
  }
}

// ─── Export modal sub-component ───

interface ExportModalContentProps {
  scope: ExportScope
  preview: ExportPreview | null
  exporting: boolean
  progress: { current: number; total: number; label: string } | null
  result: ExportResult | null
  onScopeChange: (scope: ExportScope) => void
  onExport: () => void
  onClose: () => void
  cardStyle: React.CSSProperties
  colors: ReturnType<typeof useColors>
}

function ExportModalContent({
  scope, preview, exporting, progress, result, onScopeChange, onExport, onClose, cardStyle, colors,
}: ExportModalContentProps) {
  return (
    <div style={{ ...cardStyle, padding: 14, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>Export conversations</span>
        <button
          onClick={onClose}
          disabled={exporting}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textTertiary, fontSize: 12 }}
        >
          {exporting ? '' : 'Cancel'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6 }}>Scope</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        <BackupRestoreOptionRadio
          label="Currently open"
          description="Just the conversations your tabs reference, plus their chained continuations."
          checked={scope === 'currently-open'}
          onChange={() => onScopeChange('currently-open')}
          disabled={exporting}
          colors={colors}
        />
        <BackupRestoreOptionRadio
          label="All conversations"
          description="Every conversation file on disk — full archival backup."
          checked={scope === 'all'}
          onChange={() => onScopeChange('all')}
          disabled={exporting}
          colors={colors}
        />
      </div>

      {preview && (
        <div style={{ ...cardStyle, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: colors.textSecondary }}>
            {/*
              Show tab count alongside conversation count for 'currently-open':
              one tab can reference up to five conversation IDs plus chain
              continuations, so the conversation count is usually much
              larger than the visible tab strip. Spelling both out
              ("23 tabs across 1,047 conversation sessions") makes the
              relationship explicit instead of confusing the user with a
              number that doesn't match what they see.

              For 'all', the tabs files aren't consulted at all (we
              enumerate every file under ~/.ion/conversations/ directly),
              so `tabCount` is undefined and we just show the conversation
              count. Switching wording mid-stream would be misleading
              there — "1,047 conversation sessions across N tabs" would
              imply a per-tab relationship that the 'all' scope ignores.
            */}
            {preview.tabCount !== undefined && (
              <>
                <strong style={{ color: colors.textPrimary }}>{preview.tabCount.toLocaleString()}</strong>
                {' tab'}{preview.tabCount === 1 ? '' : 's'}{' across '}
              </>
            )}
            <strong style={{ color: colors.textPrimary }}>{preview.conversationCount.toLocaleString()}</strong>
            {' conversation session'}{preview.conversationCount === 1 ? '' : 's'}{', ~'}
            {formatBytes(preview.estimatedCompressedBytes)} compressed
            (uncompressed: {formatBytes(preview.totalUncompressedBytes)})
          </div>
        </div>
      )}

      {exporting && progress && (
        <div style={{ ...cardStyle, marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: colors.textPrimary, marginBottom: 4 }}>
            Compressing {progress.current} of {progress.total}…
          </div>
          <div style={{ height: 4, background: colors.containerBg, borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%', background: colors.accent,
              width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%`,
              transition: 'width 0.15s ease',
            }} />
          </div>
        </div>
      )}

      {!result && (
        <button
          onClick={onExport}
          disabled={exporting || !preview || preview.conversationCount === 0}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 12px',
            background: !exporting && preview && preview.conversationCount > 0 ? colors.accent : colors.containerBg,
            border: 'none', borderRadius: 8,
            color: !exporting && preview && preview.conversationCount > 0 ? '#fff' : colors.textTertiary,
            cursor: !exporting && preview && preview.conversationCount > 0 ? 'pointer' : 'default',
            fontSize: 13, fontWeight: 600,
          }}
        >
          <Archive size={16} />
          {exporting ? 'Exporting…' : 'Choose destination and export'}
        </button>
      )}

      {result && (
        <ExportResultCard result={result} cardStyle={cardStyle} colors={colors} onClose={onClose} />
      )}
    </div>
  )
}

function ExportResultCard({ result, cardStyle, colors, onClose }: { result: ExportResult; cardStyle: React.CSSProperties; colors: ReturnType<typeof useColors>; onClose: () => void }) {
  if (result.ok) {
    return (
      <div style={{ ...cardStyle, borderColor: '#34d399' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <CheckCircle size={16} color="#34d399" weight="fill" />
          <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>
            Exported {result.conversationCount} conversation{result.conversationCount === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ fontSize: 11, color: colors.textTertiary, wordBreak: 'break-all', marginBottom: 8 }}>
          {result.destinationPath} ({formatBytes(result.bytesWritten ?? 0)})
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            onClick={onClose}
            style={{
              flex: 1, padding: '6px 10px', fontSize: 12,
              background: colors.containerBg, border: `1px solid ${colors.containerBorder}`,
              borderRadius: 6, color: colors.textPrimary, cursor: 'pointer',
            }}
          >
            Done
          </button>
        </div>
      </div>
    )
  }
  if (result.error === 'cancelled') {
    return (
      <div style={cardStyle}>
        <span style={{ fontSize: 12, color: colors.textTertiary }}>Export cancelled.</span>
      </div>
    )
  }
  return (
    <div style={{ ...cardStyle, borderColor: '#f87171' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <WarningCircle size={16} color="#f87171" weight="fill" />
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>Export failed</span>
      </div>
      <div style={{ fontSize: 11, color: colors.textTertiary }}>{result.error}</div>
    </div>
  )
}

// ─── End of export modal sub-component ───
//
// Restore modal (RestoreModalContent, RestoreResultCard) lives in
// BackupRestoreModal.tsx, and the shared radio component lives in
// BackupRestoreOptionRadio.tsx. The split keeps each file under the
// 600-line cap; see the rationale comments at the top of those files.

// ─── Restore modal sub-component ───
//
// Lives in BackupRestoreModal.tsx — see the comment in the End of
// export modal banner above for the split rationale.
