import React from 'react'
import { ArrowCounterClockwise, CheckCircle, WarningCircle, FolderOpen } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import type { ConflictPolicy, RestoreManifest, RestoreResult } from './BackupRestoreCategory.types'
import { BackupRestoreOptionRadio } from './BackupRestoreOptionRadio'

// Restore-side UI for the Backup & Restore settings panel.
//
// Split out from BackupRestoreCategory.tsx so each file fits comfortably
// under the 600-line cap. The split is by feature half (export vs.
// restore), not by abstraction layer — the export modal stays in the
// parent file because it's tightly coupled to the preview-refresh flow.

interface RestoreModalContentProps {
  preview: { sourcePath?: string; manifest?: RestoreManifest } | null
  conflictPolicy: ConflictPolicy
  restoreTabs: boolean
  restoring: boolean
  result: RestoreResult | null
  onConflictPolicyChange: (p: ConflictPolicy) => void
  onRestoreTabsChange: (v: boolean) => void
  onRestore: () => void
  onClose: () => void
  cardStyle: React.CSSProperties
  colors: ReturnType<typeof useColors>
}

export function RestoreModalContent({
  preview, conflictPolicy, restoreTabs, restoring, result,
  onConflictPolicyChange, onRestoreTabsChange, onRestore, onClose, cardStyle, colors,
}: RestoreModalContentProps) {
  return (
    <div style={{ ...cardStyle, padding: 14, marginTop: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>Restore from backup</span>
        <button
          onClick={onClose}
          disabled={restoring}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textTertiary, fontSize: 12 }}
        >
          {restoring ? '' : 'Cancel'}
        </button>
      </div>

      {!preview?.manifest && !result && (
        <div style={cardStyle}>
          <span style={{ fontSize: 12, color: colors.textTertiary }}>Choose a backup file to inspect…</span>
        </div>
      )}

      {preview?.manifest && (
        <div style={{ ...cardStyle, marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <FolderOpen size={16} color={colors.accent} />
            <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>Backup summary</span>
          </div>
          <div style={{ fontSize: 11, color: colors.textTertiary, lineHeight: 1.5 }}>
            Created {new Date(preview.manifest.createdAt).toLocaleString()}<br />
            On host <strong style={{ color: colors.textSecondary }}>{preview.manifest.hostname}</strong>{' '}
            (Ion {preview.manifest.ionVersion}, backend {preview.manifest.backendSnapshot})<br />
            Contains <strong style={{ color: colors.textSecondary }}>{preview.manifest.conversationCount}</strong> conversations
            ({preview.manifest.scope === 'all' ? 'full archive' : 'currently-open subset'})
          </div>
        </div>
      )}

      {preview?.manifest && !result && (
        <>
          <div style={{ fontSize: 12, color: colors.textSecondary, marginBottom: 6 }}>Conflict policy</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            <BackupRestoreOptionRadio
              label="Skip existing"
              description="Keep local files when the backup contains the same conversation ID. Default — safest."
              checked={conflictPolicy === 'skip'}
              onChange={() => onConflictPolicyChange('skip')}
              disabled={restoring}
              colors={colors}
            />
            <BackupRestoreOptionRadio
              label="Overwrite existing"
              description="Replace local files with the backup version. Use only when you trust the backup is newer."
              checked={conflictPolicy === 'overwrite'}
              onChange={() => onConflictPolicyChange('overwrite')}
              disabled={restoring}
              colors={colors}
            />
            <BackupRestoreOptionRadio
              label="Restore as new IDs"
              description="Give every restored conversation a fresh ID. Useful when carrying a backup from another machine."
              checked={conflictPolicy === 'rename'}
              onChange={() => onConflictPolicyChange('rename')}
              disabled={restoring}
              colors={colors}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, cursor: restoring ? 'default' : 'pointer' }}>
            <input
              type="checkbox"
              checked={restoreTabs}
              onChange={(e) => onRestoreTabsChange(e.target.checked)}
              disabled={restoring}
              style={{ accentColor: colors.accent }}
            />
            <span style={{ fontSize: 12, color: colors.textSecondary }}>
              Also restore tab layout from backup (merged — local tabs are preserved)
            </span>
          </label>

          <button
            onClick={onRestore}
            disabled={restoring}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              width: '100%', padding: '8px 12px',
              background: restoring ? colors.containerBg : colors.accent, border: 'none', borderRadius: 8,
              color: restoring ? colors.textTertiary : '#fff',
              cursor: restoring ? 'default' : 'pointer', fontSize: 13, fontWeight: 600,
            }}
          >
            <ArrowCounterClockwise size={16} />
            {restoring ? 'Restoring…' : 'Restore'}
          </button>
        </>
      )}

      {result && (
        <RestoreResultCard result={result} cardStyle={cardStyle} colors={colors} onClose={onClose} />
      )}
    </div>
  )
}

function RestoreResultCard({ result, cardStyle, colors, onClose }: { result: RestoreResult; cardStyle: React.CSSProperties; colors: ReturnType<typeof useColors>; onClose: () => void }) {
  if (result.ok) {
    return (
      <div style={{ ...cardStyle, borderColor: '#34d399' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <CheckCircle size={16} color="#34d399" weight="fill" />
          <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>Restore complete</span>
        </div>
        <div style={{ fontSize: 11, color: colors.textTertiary, lineHeight: 1.5 }}>
          Restored {result.restored} new files
          {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}
          {result.overwritten > 0 ? `, overwrote ${result.overwritten}` : ''}
          {result.renamed > 0 ? `, renamed ${result.renamed}` : ''}.
          {result.errors.length > 0 && ` ${result.errors.length} file error${result.errors.length === 1 ? '' : 's'} (see desktop.log).`}
        </div>
        <div style={{ fontSize: 11, color: colors.textTertiary, marginTop: 6, fontStyle: 'italic' }}>
          Restart Ion to see restored tabs in the tab strip.
        </div>
        <button
          onClick={onClose}
          style={{
            marginTop: 8, width: '100%', padding: '6px 10px', fontSize: 12,
            background: colors.containerBg, border: `1px solid ${colors.containerBorder}`,
            borderRadius: 6, color: colors.textPrimary, cursor: 'pointer',
          }}
        >
          Done
        </button>
      </div>
    )
  }
  return (
    <div style={{ ...cardStyle, borderColor: '#f87171' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <WarningCircle size={16} color="#f87171" weight="fill" />
        <span style={{ fontSize: 12, fontWeight: 600, color: colors.textPrimary }}>Restore failed</span>
      </div>
      <div style={{ fontSize: 11, color: colors.textTertiary }}>{result.error}</div>
    </div>
  )
}
