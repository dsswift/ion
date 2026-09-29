/**
 * DirectoryPicker — pick a folder on one server's host by typing a path or
 * walking the tree. The text box IS the path: `~/source/` lists that folder,
 * a partial last segment filters it, `.` at the start shows hidden folders.
 * Every listing comes from `environment.fs.browse` on that server, so a
 * remote host's disk is what is browsed, never this device's. A git
 * checkout is marked so it can be picked on the spot (double-click).
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Folder, GitBranch, CaretUp, House } from '@phosphor-icons/react'
import type { EnvironmentFsBrowse } from '@ion/shared/types-environment-admin'
import { useColors } from '../../../theme'
import { useInteractiveState } from '../../../hooks/useInteractiveState'
import { environmentClient } from '../environment/environment-client'
import { Button, Chip, ErrorText, IconButton, Inline, KIT, MonoLine, Muted, Stack, TextInput } from '../kit'
import { splitTypedPath } from './project-rows'
import { rWarn } from '../../../rendererLogger'

export interface DirectoryPickerProps {
  environmentId: string
  initialPath?: string
  /** Called with the folder the operator confirmed. */
  onPick(fullPath: string, isGitRepo: boolean): void
  pickLabel?: string
  disabled?: boolean
}

const ENTRY_HEIGHT = 30

export function DirectoryPicker({ environmentId, initialPath = '~/', onPick, pickLabel = 'Choose this folder', disabled }: DirectoryPickerProps): React.JSX.Element {
  const colors = useColors()
  const [typed, setTyped] = useState(initialPath)
  const [listing, setListing] = useState<EnvironmentFsBrowse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { listPath, filter } = useMemo(() => splitTypedPath(typed), [typed])
  const showHidden = filter.startsWith('.')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    environmentClient.browse(environmentId, listPath, showHidden).then((result) => {
      if (cancelled) return
      setListing(result)
      setError(null)
    }).catch((err: unknown) => {
      if (cancelled) return
      rWarn('directory-browser', 'browse failed', { environment_id: environmentId, path: listPath, error: String(err) })
      setError(err instanceof Error ? err.message : String(err))
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [environmentId, listPath, showHidden])

  const entries = useMemo(() => {
    if (!listing) return []
    const needle = filter.toLocaleLowerCase()
    return needle ? listing.entries.filter((e) => e.name.toLocaleLowerCase().startsWith(needle)) : listing.entries
  }, [listing, filter])

  const descend = (fullPath: string): void => setTyped(`${fullPath}/`)

  return (
    <Stack gap={8}>
      <TextInput
        aria-label="Folder path"
        mono
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && entries.length === 1 && filter) { e.preventDefault(); descend(entries[0].fullPath) }
        }}
        spellCheck={false}
        placeholder="~/source/"
      />
      <Inline>
        <IconButton icon={House} label="Home" onClick={() => setTyped('~/')} />
        <IconButton icon={CaretUp} label="Up one folder" disabled={!listing?.parentPath} onClick={() => { if (listing?.parentPath) setTyped(`${listing.parentPath}/`) }} />
        <div style={{ flex: 1, minWidth: 0 }}><MonoLine>{listing?.path ?? listPath}</MonoLine></div>
      </Inline>
      <div role="list" aria-label="Folders" style={{ border: `1px solid ${colors.containerBorder}`, borderRadius: KIT.radius + 2, maxHeight: ENTRY_HEIGHT * 8, overflowY: 'auto' }}>
        {loading && !listing && <div style={{ padding: `6px ${KIT.inset}px` }}><Muted>Listing…</Muted></div>}
        {error && <div style={{ padding: `0 ${KIT.inset}px` }}><ErrorText>{error}</ErrorText></div>}
        {listing && entries.length === 0 && !error && <div style={{ padding: `6px ${KIT.inset}px` }}><Muted>{filter ? `Nothing here starts with ${filter}` : 'No folders here'}</Muted></div>}
        {entries.map((entry) => (
          <EntryRow key={entry.fullPath} name={entry.name} isGitRepo={entry.isGitRepo} onOpen={() => descend(entry.fullPath)} onPick={() => onPick(entry.fullPath, entry.isGitRepo)} />
        ))}
      </div>
      <Inline>
        <div style={{ flex: 1 }} />
        <Button variant="primary" disabled={!listing || disabled} onClick={() => { if (listing) onPick(listing.path, listing.pathIsGitRepo) }}>{pickLabel}</Button>
      </Inline>
    </Stack>
  )
}

function EntryRow({ name, isGitRepo, onOpen, onPick }: { name: string; isGitRepo: boolean; onOpen(): void; onPick(): void }): React.JSX.Element {
  const colors = useColors()
  const { hover, handlers } = useInteractiveState()
  return (
    <button
      type="button"
      role="listitem"
      className="ion-focusable"
      onClick={onOpen}
      onDoubleClick={onPick}
      onMouseEnter={handlers.onMouseEnter}
      onMouseLeave={handlers.onMouseLeave}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', height: ENTRY_HEIGHT, boxSizing: 'border-box', textAlign: 'left',
        padding: `0 ${KIT.inset}px`, background: hover ? colors.surfaceHover : 'transparent', border: 'none', borderBottom: `1px solid ${colors.borderSubtle}`,
        color: colors.textPrimary, fontSize: KIT.fontSmall, cursor: 'pointer',
      }}
    >
      {isGitRepo ? <GitBranch size={13} color={colors.accent} /> : <Folder size={13} color={colors.textTertiary} />}
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
      {isGitRepo && <Chip>git</Chip>}
    </button>
  )
}
