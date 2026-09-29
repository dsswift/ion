/**
 * EngineProfilesSection — one server's engine profiles: a named set of
 * extensions and the mode a conversation started with it opens in. Rows open
 * the edit panel; Add profile opens an empty one; Delete asks first.
 */
import React, { useState } from 'react'
import { FilePlus, Plus, Trash, X } from '@phosphor-icons/react'
import type { EngineProfile } from '@ion/shared/types'
import { host } from '../../../../host/host-instance'
import { rError, rInfo } from '../../../../rendererLogger'
import { useSettingsEnvironment } from '../../settings-servers'
import { editToProfile, emptyProfileEdit, profileToEdit, type ProfileEditState } from '../../engine-profile-edit-helpers'
import { Button, CellText, Chip, DataList, EmptyState, ErrorText, Field, GroupHeader, IconButton, Inline, MonoLine, Muted, Segmented, SidePanel, Stack, TextInput } from '../../kit'
import { useEngineProfilesStore } from './use-engine-profiles-store'

type Editing = { kind: 'new' } | { kind: 'edit'; profile: EngineProfile }

export function EngineProfilesSection(): React.JSX.Element {
  const env = useSettingsEnvironment()
  const store = useEngineProfilesStore(env.id)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<EngineProfile | null>(null)

  return (
    <div>
      <DataList<EngineProfile>
        label="Engine profiles"
        title="Engine profiles"
        description={`Sets of extensions a conversation on ${env.label} can start with.`}
        anchor="engine-profiles"
        items={store.profiles}
        loading={store.loading}
        getKey={(p) => p.id}
        noun={['profile', 'profiles']}
        filter={(p, q) => p.name.toLowerCase().includes(q)}
        showHeader
        onRowClick={(profile) => setEditing({ kind: 'edit', profile })}
        columns={[
          { id: 'name', header: 'Profile', render: (p) => <CellText>{p.name}</CellText> },
          { id: 'extensions', header: 'Extensions', width: '110px', render: (p) => { const n = (p.extensions || []).length; return <Muted>{`${n} ${n === 1 ? 'extension' : 'extensions'}`}</Muted> } },
          { id: 'mode', header: 'Mode', width: '70px', render: (p) => <Chip tone={p.defaultMode === 'plan' ? 'accent' : 'muted'}>{p.defaultMode === 'plan' ? 'Plan' : 'Auto'}</Chip> },
        ]}
        rowMenu={(profile) => [{ label: 'Delete', icon: Trash, danger: true, onSelect: () => setDeleting(profile) }]}
        actions={<Button variant="primary" icon={Plus} onClick={() => setEditing({ kind: 'new' })}>Add profile</Button>}
        empty={<EmptyState title="No engine profiles" detail="A profile loads a set of extensions into a new conversation." />}
      />
      <ErrorText>{store.error}</ErrorText>
      {editing && (
        <ProfilePanel
          key={editing.kind === 'edit' ? editing.profile.id : 'new'}
          editing={editing}
          onClose={() => setEditing(null)}
          onSave={(profile) => {
            if (editing.kind === 'edit') store.update(profile.id, profile)
            else store.add(profile)
            rInfo('engine-config', 'engine profile saved', { environment_id: env.id, profile_id: profile.id, created: editing.kind === 'new', extension_count: profile.extensions.length })
            setEditing(null)
          }}
        />
      )}
      <SidePanel
        open={deleting !== null}
        title={`Delete ${deleting?.name ?? 'profile'}?`}
        subtitle={`Removes the profile from ${env.label}. Its extension files stay where they are.`}
        onClose={() => setDeleting(null)}
        footer={<>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" icon={Trash} onClick={() => {
            if (!deleting) return
            store.remove(deleting.id)
            rInfo('engine-config', 'engine profile deleted', { environment_id: env.id, profile_id: deleting.id })
            setDeleting(null)
          }}>Delete</Button>
        </>}
      >
        <Muted>This cannot be undone.</Muted>
      </SidePanel>
    </div>
  )
}

function ProfilePanel({ editing, onClose, onSave }: { editing: Editing; onClose(): void; onSave(profile: EngineProfile): void }): React.JSX.Element {
  const [edit, setEdit] = useState<ProfileEditState>(editing.kind === 'edit' ? profileToEdit(editing.profile) : emptyProfileEdit)
  const canSave = edit.name.trim() !== '' && edit.extensions.filter((x) => x.trim()).length > 0
  // A native file picker over this machine's filesystem: the Electron host only.
  const canPickFiles = host.capabilities().includes('pickFile')

  const addExtensionFiles = async (): Promise<void> => {
    const files = await host.shell.selectExtensionFiles()
    if (files && files.length > 0) setEdit((prev) => ({ ...prev, extensions: [...prev.extensions, ...files] }))
  }
  const save = (): void => {
    if (!canSave) return
    onSave(editToProfile(editing.kind === 'edit' ? editing.profile.id : crypto.randomUUID().slice(0, 8), edit))
  }

  return (
    <SidePanel
      open
      title={editing.kind === 'edit' ? editing.profile.name : 'New engine profile'}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} onClick={save}>Save</Button>
      </>}
    >
      <Stack gap={16}>
        <Field label="Name">
          <TextInput aria-label="Profile name" value={edit.name} placeholder="e.g. cos" onChange={(e) => setEdit((prev) => ({ ...prev, name: e.target.value }))} />
        </Field>
        {/* Not a Field: a <label> would forward a click on the list to its first button. */}
        <div>
          <GroupHeader title="Extensions" description={canPickFiles ? 'At least one extension is required.' : 'At least one extension is required. Adding files needs the desktop app’s file picker.'} />
          <Stack gap={4}>
            {edit.extensions.length === 0 && <Muted>No extensions yet.</Muted>}
            {edit.extensions.map((ext, i) => (
              <Inline key={`${ext}-${i}`}>
                <div style={{ flex: 1, minWidth: 0 }}><MonoLine>{ext}</MonoLine></div>
                <IconButton icon={X} label="Remove extension" onClick={() => setEdit((prev) => ({ ...prev, extensions: prev.extensions.filter((_, j) => j !== i) }))} />
              </Inline>
            ))}
            {canPickFiles && (
              <div>
                <Button icon={FilePlus} onClick={() => { void addExtensionFiles().catch((err: unknown) => rError('settings', 'add extension files failed', { error: String(err) })) }}>Add extension</Button>
              </div>
            )}
          </Stack>
        </div>
        <div>
          <GroupHeader title="Default mode" />
          <Segmented<'auto' | 'plan'> label="Default mode" value={edit.defaultMode} onChange={(defaultMode) => setEdit((prev) => ({ ...prev, defaultMode }))} options={[{ value: 'auto', label: 'Auto' }, { value: 'plan', label: 'Plan' }]} />
        </div>
      </Stack>
    </SidePanel>
  )
}
