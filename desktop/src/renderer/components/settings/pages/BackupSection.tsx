/**
 * BackupSection — export conversations to a zip, or restore them from one.
 * Each flow runs in its own side panel. Restoring is always opt-in and
 * never overwrites local files unless the conflict policy says so.
 */
import React from 'react'
import { Archive, ArrowCounterClockwise } from '@phosphor-icons/react'
import { useColors } from '../../../theme'
import { Button, Field, FormGroup, FormRow, Group, KIT, Muted, Notice, Segmented, SidePanel, Stack, ToggleRow } from '../kit'
import { formatBytes, useExportFlow, useRestoreFlow, type ConflictPolicy, type ExportFlow, type ExportScope, type RestoreFlow } from './backup-flows'

const SCOPES = [
  { value: 'currently-open', label: 'Currently open' },
  { value: 'all', label: 'All conversations' },
] as const

const SCOPE_HINT: Record<ExportScope, string> = {
  'currently-open': 'Just the conversations your tabs reference, plus their chained continuations.',
  all: 'Every conversation file on disk: a full archival backup.',
}

const POLICIES = [
  { value: 'skip', label: 'Skip existing' },
  { value: 'overwrite', label: 'Overwrite existing' },
  { value: 'rename', label: 'Restore as new IDs' },
] as const

const POLICY_HINT: Record<ConflictPolicy, string> = {
  skip: 'Keep local files when the backup has the same conversation ID. The safest choice.',
  overwrite: 'Replace local files with the backup version. Use only when the backup is newer.',
  rename: 'Give every restored conversation a fresh ID. Useful for a backup from another machine.',
}

const plural = (n: number, word: string): string => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

export function BackupSection(): React.JSX.Element {
  const exportFlow = useExportFlow()
  const restoreFlow = useRestoreFlow()
  return (
    <>
      <FormGroup
        title="Backup and restore"
        description="Export a zip of your conversations as a portable backup. Restoring is always opt-in and never overwrites local files without your confirmation."
        anchor="backup"
      >
        <FormRow label="Export conversations" description="Write the conversations on this device to a zip archive.">
          <Button icon={Archive} onClick={exportFlow.begin}>Export conversations…</Button>
        </FormRow>
        <FormRow label="Restore from backup" description="Read a backup zip and bring its conversations back.">
          <Button icon={ArrowCounterClockwise} onClick={restoreFlow.begin}>Restore from backup…</Button>
        </FormRow>
      </FormGroup>
      <ExportPanel flow={exportFlow} />
      <RestorePanel flow={restoreFlow} />
    </>
  )
}

function ExportPanel({ flow }: { flow: ExportFlow }): React.JSX.Element {
  const colors = useColors()
  const { preview, progress, result, exporting } = flow
  const ready = !exporting && preview !== null && preview.conversationCount > 0
  return (
    <SidePanel
      open={flow.open}
      title="Export conversations"
      subtitle="Choose what to include, then where to save the archive."
      onClose={flow.close}
      footer={result?.ok ? <Button variant="primary" onClick={flow.close}>Done</Button> : <>
        <Button disabled={exporting} onClick={flow.close}>Cancel</Button>
        {!result && <Button variant="primary" icon={Archive} disabled={!ready} onClick={flow.run}>{exporting ? 'Exporting…' : 'Choose destination and export'}</Button>}
      </>}
    >
      <Stack>
        <Field label="Scope" hint={SCOPE_HINT[flow.scope]}>
          <Segmented<ExportScope> label="Export scope" value={flow.scope} options={SCOPES} disabled={exporting} onChange={flow.setScope} />
        </Field>
        {/* A tab can reference several conversations, so 'currently-open' names both counts; 'all' never reads tabs. */}
        {preview && (
          <Muted>
            {preview.tabCount !== undefined && `${plural(preview.tabCount, 'tab')} across `}
            {plural(preview.conversationCount, 'conversation session')}, ~{formatBytes(preview.estimatedCompressedBytes)} compressed (uncompressed: {formatBytes(preview.totalUncompressedBytes)})
          </Muted>
        )}
        {exporting && progress && (
          <Stack gap={4}>
            <Muted>Compressing {progress.current} of {progress.total}…</Muted>
            <div style={{ height: 4, background: colors.surfaceSecondary, borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', background: colors.accent, width: `${progress.total > 0 ? (progress.current / progress.total) * 100 : 0}%` }} />
            </div>
          </Stack>
        )}
        {result && (result.ok ? (
          <Notice tone="ok">
            <strong>Exported {plural(result.conversationCount ?? 0, 'conversation')}</strong>
            <div style={{ wordBreak: 'break-all', fontSize: KIT.fontTiny }}>{result.destinationPath} ({formatBytes(result.bytesWritten ?? 0)})</div>
          </Notice>
        ) : result.error === 'cancelled' ? <Notice>Export cancelled.</Notice> : (
          <Notice tone="error"><strong>Export failed</strong><div>{result.error}</div></Notice>
        ))}
      </Stack>
    </SidePanel>
  )
}

function RestorePanel({ flow }: { flow: RestoreFlow }): React.JSX.Element {
  const { manifest, result, restoring } = flow
  return (
    <SidePanel
      open={flow.open}
      title="Restore from backup"
      subtitle={flow.sourcePath ?? undefined}
      onClose={flow.close}
      footer={result?.ok ? <Button variant="primary" onClick={flow.close}>Done</Button> : <>
        <Button disabled={restoring} onClick={flow.close}>Cancel</Button>
        {manifest && !result && <Button variant="primary" icon={ArrowCounterClockwise} disabled={restoring} onClick={flow.run}>{restoring ? 'Restoring…' : 'Restore'}</Button>}
      </>}
    >
      <Stack>
        {!manifest && !result && <Muted>Choose a backup file to inspect…</Muted>}
        {manifest && (
          <Field label="Backup summary">
            <Muted>
              Created {new Date(manifest.createdAt).toLocaleString()} on host {manifest.hostname} (Ion {manifest.ionVersion}{manifest.backendSnapshot ? `, backend ${manifest.backendSnapshot}` : ''}).
              {' '}Contains {manifest.conversationCount} conversations ({manifest.scope === 'all' ? 'full archive' : 'currently-open subset'}).
            </Muted>
          </Field>
        )}
        {manifest && !result && <>
          <Field label="Conflict policy" hint={POLICY_HINT[flow.conflictPolicy]}>
            <Segmented<ConflictPolicy> label="Conflict policy" value={flow.conflictPolicy} options={POLICIES} disabled={restoring} onChange={flow.setConflictPolicy} />
          </Field>
          <Group>
            <ToggleRow
              label="Also restore tab layout"
              description="Merged with your current tabs; local tabs are preserved."
              checked={flow.restoreTabs}
              onChange={flow.setRestoreTabs}
              lockedReason={restoring ? 'Restoring…' : undefined}
            />
          </Group>
        </>}
        {result && (result.ok ? (
          <Notice tone="ok">
            <strong>Restore complete</strong>
            <div>
              Restored {result.restored} new files
              {result.skipped > 0 ? `, skipped ${result.skipped}` : ''}
              {result.overwritten > 0 ? `, overwrote ${result.overwritten}` : ''}
              {result.renamed > 0 ? `, renamed ${result.renamed}` : ''}.
              {result.errors.length > 0 && ` ${plural(result.errors.length, 'file error')} (see desktop.log).`}
            </div>
            <div>Restart Ion to see restored conversations in the Inbox.</div>
          </Notice>
        ) : (
          <Notice tone="error"><strong>Restore failed</strong><div>{result.error}</div></Notice>
        ))}
      </Stack>
    </SidePanel>
  )
}
