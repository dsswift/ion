import React, { useState } from 'react'
import { PencilSimple, Trash, Plus, FolderOpen } from '@phosphor-icons/react'
import { useColors, useThemeStore } from '../../theme'
import { SettingHeading } from './SettingHeading'
import type { EngineProfile } from '../../../shared/types'

interface EditState {
  name: string
  extensionDir: string
  agentsRoot: string
  defaultTeam: string
  model: string
  damageControlRules: string
  universalStandards: string
}

const emptyEdit: EditState = {
  name: '',
  extensionDir: '',
  agentsRoot: '',
  defaultTeam: '',
  model: '',
  damageControlRules: '',
  universalStandards: '',
}

function profileToEdit(p: EngineProfile): EditState {
  return {
    name: p.name,
    extensionDir: p.extensionDir,
    model: p.model || '',
    agentsRoot: p.options?.agentsRoot || '',
    defaultTeam: p.options?.defaultTeam || '',
    damageControlRules: p.options?.damageControlRules || '',
    universalStandards: p.options?.universalStandards || '',
  }
}

function editToProfile(id: string, e: EditState): EngineProfile {
  const p: EngineProfile = { id, name: e.name.trim(), extensionDir: e.extensionDir.trim() }
  if (e.model.trim()) p.model = e.model.trim()
  const opts: Record<string, any> = {}
  if (e.agentsRoot.trim()) opts.agentsRoot = e.agentsRoot.trim()
  if (e.defaultTeam.trim()) opts.defaultTeam = e.defaultTeam.trim()
  if (e.damageControlRules.trim()) opts.damageControlRules = e.damageControlRules.trim()
  if (e.universalStandards.trim()) opts.universalStandards = e.universalStandards.trim()
  if (Object.keys(opts).length > 0) p.options = opts
  return p
}

export function EngineCategory() {
  const colors = useColors()
  const profiles = useThemeStore((s) => s.engineProfiles)
  const addEngineProfile = useThemeStore((s) => s.addEngineProfile)
  const updateEngineProfile = useThemeStore((s) => s.updateEngineProfile)
  const removeEngineProfile = useThemeStore((s) => s.removeEngineProfile)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState>(emptyEdit)
  const [isAdding, setIsAdding] = useState(false)

  const startEdit = (profile: EngineProfile) => {
    setEditingId(profile.id)
    setEdit(profileToEdit(profile))
    setIsAdding(false)
  }

  const startAdd = () => {
    setIsAdding(true)
    setEditingId(null)
    setEdit(emptyEdit)
  }

  const saveEdit = () => {
    if (!edit.name.trim() || !edit.extensionDir.trim()) return
    if (editingId) {
      const updated = editToProfile(editingId, edit)
      updateEngineProfile(editingId, updated)
      setEditingId(null)
    } else if (isAdding) {
      const profile = editToProfile(crypto.randomUUID().slice(0, 8), edit)
      addEngineProfile(profile)
      setIsAdding(false)
    }
  }

  const cancel = () => {
    setEditingId(null)
    setIsAdding(false)
  }

  const browseDirectory = async (field: keyof EditState) => {
    const dir = await window.ion?.selectDirectory()
    if (dir) setEdit((prev) => ({ ...prev, [field]: dir }))
  }

  const cardStyle: React.CSSProperties = {
    background: colors.surfacePrimary,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 8,
    padding: '10px 12px',
    marginBottom: 8,
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    background: colors.containerBg,
    border: `1px solid ${colors.containerBorder}`,
    borderRadius: 6,
    padding: '6px 10px',
    color: colors.textPrimary,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  }

  const labelStyle: React.CSSProperties = {
    fontSize: 11,
    color: colors.textTertiary,
    display: 'block',
    marginBottom: 3,
  }

  const fieldRow: React.CSSProperties = {
    marginBottom: 6,
  }

  const browseBtn: React.CSSProperties = {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 4,
    color: colors.textSecondary,
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
  }

  const renderPathInput = (label: string, field: keyof EditState, placeholder: string, browseable: boolean, optional: boolean) => (
    <div style={fieldRow}>
      <label style={labelStyle}>{label}{optional ? '' : ' *'}</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <input
          type="text"
          value={edit[field]}
          onChange={(e) => setEdit((prev) => ({ ...prev, [field]: e.target.value }))}
          placeholder={placeholder}
          style={inputStyle}
        />
        {browseable && (
          <button onClick={() => browseDirectory(field)} style={browseBtn} title="Browse...">
            <FolderOpen size={16} />
          </button>
        )}
      </div>
    </div>
  )

  const renderTextInput = (label: string, field: keyof EditState, placeholder: string, optional: boolean) => (
    <div style={fieldRow}>
      <label style={labelStyle}>{label}{optional ? '' : ' *'}</label>
      <input
        type="text"
        value={edit[field]}
        onChange={(e) => setEdit((prev) => ({ ...prev, [field]: e.target.value }))}
        placeholder={placeholder}
        style={inputStyle}
      />
    </div>
  )

  const renderForm = () => (
    <div style={cardStyle}>
      {renderTextInput('Name', 'name', 'e.g. cos', false)}
      {renderPathInput('Extension Directory', 'extensionDir', '~/.ion/extensions/chief-of-staff', true, false)}
      {renderPathInput('Agents Root', 'agentsRoot', '~/.pi/agents/cloudops', true, true)}
      {renderTextInput('Default Team', 'defaultTeam', 'cloudops-full', true)}
      {renderTextInput('Model', 'model', 'claude-sonnet-4-20250514', true)}
      {renderPathInput('Damage Control Rules', 'damageControlRules', '~/.pi/damage-control-rules.yaml', false, true)}
      {renderPathInput('Universal Standards', 'universalStandards', '~/.pi/agents/cloudops/_universal-standards.md', false, true)}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
        <button
          onClick={cancel}
          style={{
            padding: '4px 12px',
            background: 'transparent',
            border: `1px solid ${colors.containerBorder}`,
            borderRadius: 6,
            color: colors.textSecondary,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          Cancel
        </button>
        <button
          onClick={saveEdit}
          disabled={!edit.name.trim() || !edit.extensionDir.trim()}
          style={{
            padding: '4px 12px',
            background: colors.accent,
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
            opacity: (!edit.name.trim() || !edit.extensionDir.trim()) ? 0.5 : 1,
          }}
        >
          Save
        </button>
      </div>
    </div>
  )

  const profileSubtitle = (p: EngineProfile) => {
    const parts: string[] = []
    const dirBase = p.extensionDir.split('/').pop() || p.extensionDir
    parts.push(dirBase)
    if (p.options?.defaultTeam) parts.push(p.options.defaultTeam)
    return parts.join(' | ')
  }

  return (
    <>
      <SettingHeading first>Engine Profiles</SettingHeading>

      {profiles.map((profile) => {
        if (editingId === profile.id) return <React.Fragment key={profile.id}>{renderForm()}</React.Fragment>
        return (
          <div key={profile.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>{profile.name}</div>
                <div style={{ fontSize: 11, color: colors.textTertiary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
                  {profileSubtitle(profile)}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                <button
                  onClick={() => startEdit(profile)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: colors.textSecondary, display: 'flex', alignItems: 'center' }}
                  title="Edit profile"
                >
                  <PencilSimple size={14} />
                </button>
                <button
                  onClick={() => removeEngineProfile(profile.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: colors.textTertiary, display: 'flex', alignItems: 'center' }}
                  title="Delete profile"
                >
                  <Trash size={14} />
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {isAdding ? renderForm() : (
        <button
          onClick={startAdd}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 12px',
            background: 'transparent',
            border: `1px dashed ${colors.containerBorder}`,
            borderRadius: 8,
            color: colors.textSecondary,
            cursor: 'pointer',
            fontSize: 12,
            width: '100%',
          }}
        >
          <Plus size={14} />
          Add Profile
        </button>
      )}
    </>
  )
}
