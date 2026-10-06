/**
 * AddProjectPanel — "Add project" for the server this page is about. Four
 * sources: a folder already on that host (browse it), a git URL to clone
 * there, the projects another environment has that this one does not
 * ("Copy from another environment"), cloned with their remote URL into the
 * base folder, or a new repository created on a git host and cloned there.
 * Clones run as jobs on the server; the row appears in the list when the job
 * registers it.
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { EnvironmentProject } from '@ion/shared/types-environment-admin'
import type { EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { useColors } from '../../../theme'
import { environmentClient } from '../environment/environment-client'
import { readConversationCatalog } from '../../../studio/connection/catalog'
import { useSettingsEnvironment } from '../settings-servers'
import { Button, ErrorText, Field, KIT, MonoLine, Muted, Segmented, SidePanel, Stack, TextInput } from '../kit'
import { DirectoryPicker } from './DirectoryPicker'
import { repoNameFromUrl } from './project-rows'
import { rInfo, rWarn } from '../../../rendererLogger'
import { NewRepositoryPanel } from './NewRepositoryPanel'

type Source = 'folder' | 'url' | 'copy' | 'new'
interface CopyCandidate { from: EnvironmentCatalogEntry; project: EnvironmentProject }

export interface AddProjectPanelProps {
  open: boolean
  /** Where clones land on this server. */
  baseDir: string
  existing: readonly EnvironmentProject[]
  onDone(): void
  onClose(): void
}

export function AddProjectPanel(props: AddProjectPanelProps): React.JSX.Element | null {
  // Mounted only while open, so every open starts a fresh flow.
  return props.open ? <AddProjectFlow {...props} /> : null
}

function AddProjectFlow({ baseDir, existing, onDone, onClose }: AddProjectPanelProps): React.JSX.Element {
  const env = useSettingsEnvironment()
  const [source, setSource] = useState<Source>('folder')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [url, setUrl] = useState('')
  const [candidates, setCandidates] = useState<CopyCandidate[] | null>(null)
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const base = baseDir.replace(/\/$/, '')

  const existingRemotes = useMemo(() => new Set(existing.map((p) => p.entry.repoRemote).filter((r): r is string => !!r)), [existing])

  useEffect(() => {
    if (source !== 'copy') return
    let cancelled = false
    void (async () => {
      try {
        const catalog = (await readConversationCatalog()).filter((e) => e.id !== env.id)
        const lists = await Promise.all(catalog.map(async (from) => {
          try { return (await environmentClient.listProjects(from.id)).map((project) => ({ from, project })) } catch (err) { rWarn('add-project', 'copy source list failed', { environment_id: from.id, error: String(err) }); return [] }
        }))
        if (cancelled) return
        const seen = new Set<string>()
        const found = lists.flat().filter(({ project }) => {
          const remote = project.entry.repoRemote
          if (!remote || existingRemotes.has(remote) || seen.has(remote) || !(project.entry.cloneUrl ?? project.originUrl)) return false
          seen.add(remote)
          return true
        })
        setCandidates(found)
        setTicked(new Set(found.map((c) => c.project.entry.repoRemote!)))
      } catch (err) {
        rWarn('add-project', 'copy candidates failed', { environment_id: env.id, error: String(err) })
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => { cancelled = true }
  }, [source, env.id, existingRemotes])

  const finish = (fn: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    fn().then(onDone).catch((err: unknown) => {
      rWarn('add-project', 'failed', { environment_id: env.id, source, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => setBusy(false))
  }

  const cloneUrl = (): void => finish(async () => {
    await environmentClient.cloneProject(env.id, url.trim(), baseDir)
    rInfo('add-project', 'clone started', { environment_id: env.id })
  })

  const cloneCopies = (): void => finish(async () => {
    for (const { project } of candidates ?? []) {
      if (!ticked.has(project.entry.repoRemote!)) continue
      const sourceUrl = project.entry.cloneUrl ?? project.originUrl
      if (!sourceUrl) throw new Error(`${project.displayName} has no origin to clone from`)
      await environmentClient.cloneProject(env.id, sourceUrl, baseDir, project.displayName)
    }
    rInfo('add-project', 'copy clones started', { environment_id: env.id, count: ticked.size })
  })

  const sourceSwitch = (
    <Segmented<Source>
      label="Project source"
      value={source}
      onChange={(next) => { setSource(next); setError(null) }}
      options={[{ value: 'folder', label: 'Folder on this host' }, { value: 'url', label: 'Git URL' }, { value: 'copy', label: 'Copy from another environment' }, { value: 'new', label: 'New repository' }]}
    />
  )
  // A new repository is its own flow, with its own lookups, mounted only when it is the source.
  if (source === 'new') return <NewRepositoryPanel baseDir={baseDir} sourceSwitch={sourceSwitch} onDone={onDone} onClose={onClose} />

  const footer = source === 'url'
    ? <Button variant="primary" disabled={busy || !url.trim()} onClick={cloneUrl}>{busy ? 'Starting…' : 'Clone'}</Button>
    : source === 'copy' && candidates && candidates.length > 0
      ? <Button variant="primary" disabled={busy || ticked.size === 0} onClick={cloneCopies}>{busy ? 'Starting…' : `Clone ${ticked.size} project${ticked.size === 1 ? '' : 's'}`}</Button>
      : undefined

  return (
    <SidePanel open title={`Add project to ${env.label}`} subtitle="Conversations can start in any project on this server." onClose={onClose} footer={footer}>
      <Stack>
        {sourceSwitch}
        <ErrorText>{error}</ErrorText>
        {source === 'folder' && <>
          <Muted>Browse {env.label} for a checkout that is already there. Double-click a folder to add it.</Muted>
          <DirectoryPicker environmentId={env.id} initialPath={`${base}/`} pickLabel="Add this folder" disabled={busy} onPick={(path) => finish(async () => {
            await environmentClient.addProject(env.id, path)
            rInfo('add-project', 'folder added', { environment_id: env.id })
          })} />
        </>}
        {source === 'url' && <>
          <Field label="Repository URL" hint={`Clones onto ${env.label}.`}>
            <TextInput aria-label="Repository URL" mono value={url} onChange={(e) => setUrl(e.target.value)} placeholder="git@github.com:org/repo.git" spellCheck={false} />
          </Field>
          <Field label="Clones into"><MonoLine>{`${base}/${url.trim() ? repoNameFromUrl(url.trim()) : '<name>'}`}</MonoLine></Field>
        </>}
        {source === 'copy' && <CopyList candidates={candidates} ticked={ticked} onToggle={(remote, on) => setTicked((prev) => { const next = new Set(prev); if (on) next.add(remote); else next.delete(remote); return next })} />}
      </Stack>
    </SidePanel>
  )
}

function CopyList({ candidates, ticked, onToggle }: { candidates: CopyCandidate[] | null; ticked: ReadonlySet<string>; onToggle(remote: string, on: boolean): void }): React.JSX.Element {
  const colors = useColors()
  if (candidates === null) return <Muted>Looking at your other environments…</Muted>
  if (candidates.length === 0) return <Muted>Every project your other environments have is already here.</Muted>
  return (
    <div role="list" aria-label="Projects to copy" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, maxHeight: KIT.listMaxHeight, overflowY: 'auto' }}>
      {candidates.map(({ from, project }) => {
        const remote = project.entry.repoRemote!
        return (
          <label key={remote} role="listitem" style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: KIT.rowHeight, padding: `4px ${KIT.inset}px`, boxSizing: 'border-box', borderBottom: `1px solid ${colors.borderSubtle}`, cursor: 'pointer' }}>
            <input type="checkbox" aria-label={`Copy ${project.displayName}`} checked={ticked.has(remote)} onChange={(e) => onToggle(remote, e.target.checked)} style={{ accentColor: colors.accent, margin: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: KIT.fontSmall, color: colors.textPrimary }}>{project.displayName} <span style={{ color: colors.textTertiary }}>from {from.label}</span></span>
              <MonoLine>{remote}</MonoLine>
            </span>
          </label>
        )
      })}
    </div>
  )
}
