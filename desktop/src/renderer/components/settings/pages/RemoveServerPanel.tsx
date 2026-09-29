/**
 * RemoveServerPanel — the reverse of Add server. Appraises what Ion left on
 * the host, then removes exactly the degree the operator picks: Studio
 * (always: the services and bundle), git credentials, the clones Ion made,
 * all data (conversations, config, credentials). The purge runs on the
 * server itself (`environment.purge.run`), and the catalog entry is
 * forgotten afterward. "Forget on this device only" leaves the host
 * untouched, for a machine you will pair again.
 *
 * After a purge the result stays on screen; the entry is forgotten when the
 * panel closes, because forgetting it removes the page the panel may be on.
 * Either way the dialog then shows the Servers page.
 */
import React, { useEffect, useRef, useState } from 'react'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import type { EnvironmentPurgeAppraisal, EnvironmentPurgeResult } from '@ion/shared/types-environment-admin'
import { environmentClient, formatBytes } from '../environment/environment-client'
import { useSettingsServers } from '../settings-servers'
import { useSettingsNav } from '../settings-nav'
import { Button, ErrorText, FormRow, Group, Muted, MonoLine, Notice, SidePanel, Stack, Switch } from '../kit'
import { rInfo, rWarn } from '../../../rendererLogger'

export function RemoveServerPanel({ entry, onClose }: { entry: EnvironmentCatalogEntry | null; onClose(): void }): React.JSX.Element | null {
  return entry ? <RemoveFlow key={entry.id} entry={entry} onClose={onClose} /> : null
}

type Level = 'gitCredentials' | 'clones' | 'data'

function RemoveFlow({ entry, onClose }: { entry: EnvironmentCatalogEntry; onClose(): void }): React.JSX.Element {
  const servers = useSettingsServers()
  const { navigate } = useSettingsNav()
  const [appraisal, setAppraisal] = useState<EnvironmentPurgeAppraisal | null>(null)
  const [appraisalError, setAppraisalError] = useState<string | null>(null)
  const [levels, setLevels] = useState({ gitCredentials: false, clones: false, data: false, force: false })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<EnvironmentPurgeResult | null>(null)
  // A scheduled uninstall still owes a forget; paid on close, or on unmount if the dialog goes first.
  const owesForget = useRef(false)
  const forgetRef = useRef(servers.forget)
  forgetRef.current = servers.forget

  useEffect(() => {
    environmentClient.purgeAppraise(entry.id).then(setAppraisal).catch((err: unknown) => {
      rWarn('remove-environment', 'appraisal failed', { environment_id: entry.id, error: String(err) })
      setAppraisalError(err instanceof Error ? err.message : String(err))
    })
  }, [entry.id])

  useEffect(() => () => {
    if (!owesForget.current) return
    owesForget.current = false
    forgetRef.current(entry).catch((err: unknown) => rWarn('remove-environment', 'forget after purge failed', { environment_id: entry.id, error: String(err) }))
  }, [entry])

  const dirtyClones = appraisal?.clonedProjects.filter((c) => c.dirty) ?? []
  const canPurge = !!appraisal?.bundle

  const forgetAndLeave = async (): Promise<void> => {
    owesForget.current = false
    await servers.forget(entry)
    rInfo('remove-environment', 'forgotten on this device', { environment_id: entry.id })
    onClose()
    navigate({ pageId: 'servers', environmentId: null, anchor: null })
  }

  const close = (): void => {
    if (busy) return
    if (!owesForget.current) { onClose(); return }
    setBusy(true)
    forgetAndLeave().catch((err: unknown) => {
      rWarn('remove-environment', 'forget after purge failed', { environment_id: entry.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  const runPurge = (): void => {
    setBusy(true); setError(null)
    environmentClient.purgeRun(entry.id, { gitCredentials: levels.gitCredentials, clones: levels.clones, data: levels.data, force: levels.force }).then((r) => {
      rInfo('remove-environment', 'purge ran', { environment_id: entry.id, uninstall_scheduled: r.uninstallScheduled, removed_clones: r.removedClones.length })
      setResult(r)
      if (r.uninstallScheduled) owesForget.current = true
    }).catch((err: unknown) => {
      rWarn('remove-environment', 'purge failed', { environment_id: entry.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  const forgetOnly = (): void => {
    setBusy(true); setError(null)
    forgetAndLeave().catch((err: unknown) => {
      rWarn('remove-environment', 'forget failed', { environment_id: entry.id, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  const levelRow = (key: Level, label: string, detail: string, disabled = false): React.JSX.Element => (
    <FormRow label={label} description={detail}>
      <Switch label={label} checked={levels[key]} disabled={disabled} onChange={(on) => setLevels((prev) => ({ ...prev, [key]: on }))} />
    </FormRow>
  )

  return (
    <SidePanel
      open
      title={`Remove ${entry.label}`}
      subtitle="Choose how much of Ion to take off the host. Anything you leave stays for the next time you add it."
      onClose={close}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={close}>{result ? 'Done' : 'Cancel'}</Button>
        {!result && <Button disabled={busy} onClick={forgetOnly}>Forget on this device only</Button>}
        {!result && appraisal && (
          <Button variant="danger" disabled={busy || !canPurge} tooltip={canPurge ? undefined : 'The host has no bundle install to remove'} onClick={runPurge}>{busy ? 'Removing…' : 'Remove from host'}</Button>
        )}
      </>}
    >
      <Stack>
        {!appraisal && !appraisalError && <Muted>Looking at what is on the host…</Muted>}
        {appraisalError && <Muted>Could not read the host ({appraisalError}). You can still forget it on this device.</Muted>}
        {appraisal && !result && (
          <Group>
            <FormRow label="Studio Server services and bundle" description={appraisal.bundle ? `version ${appraisal.bundle.version} at ${appraisal.bundle.root}` : 'not installed from a bundle here; nothing to stop from this panel'}>
              <Switch label="Studio Server services and bundle" checked disabled onChange={() => {}} />
            </FormRow>
            {levelRow('gitCredentials', 'Git credentials', appraisal.gitCredentialHosts.length > 0 ? `keys and tokens for ${appraisal.gitCredentialHosts.join(', ')}` : 'none stored', appraisal.gitCredentialHosts.length === 0)}
            {levelRow('clones', 'Repositories Ion cloned', appraisal.clonedProjects.length > 0 ? `${appraisal.clonedProjects.length} clone(s), ${formatBytes(appraisal.clonedProjects.reduce((n, c) => n + c.bytes, 0))}${dirtyClones.length > 0 ? `; ${dirtyClones.length} with uncommitted changes` : ''}` : 'none', appraisal.clonedProjects.length === 0)}
            {levels.clones && dirtyClones.length > 0 && (
              <FormRow label="Delete the dirty ones too" warning={dirtyClones.map((c) => c.dir.split('/').pop()).join(', ')}>
                <Switch label="Delete the dirty ones too" checked={levels.force} onChange={(on) => setLevels((prev) => ({ ...prev, force: on }))} />
              </FormRow>
            )}
            {levelRow('data', 'All Ion data on the host', `${appraisal.conversations} conversation(s), settings, engine and server config, pairings: ${formatBytes(appraisal.dataBytes)}`)}
          </Group>
        )}
        {result && (
          <Notice tone={result.uninstallScheduled ? 'ok' : 'warn'}>
            <Stack gap={4}>
              <span>{result.uninstallScheduled ? 'Uninstall started on the host; the services stop in a moment.' : `The services were not removed: ${result.uninstallError}`}</span>
              {result.removedClones.length > 0 && <MonoLine>{`removed ${result.removedClones.length} clone(s)`}</MonoLine>}
              {result.keptDirtyClones.length > 0 && <span>kept (uncommitted changes): {result.keptDirtyClones.join(', ')}</span>}
              {result.removedGitCredentialHosts.length > 0 && <MonoLine>{`removed credentials for ${result.removedGitCredentialHosts.join(', ')}`}</MonoLine>}
            </Stack>
          </Notice>
        )}
        <ErrorText>{error}</ErrorText>
      </Stack>
    </SidePanel>
  )
}
