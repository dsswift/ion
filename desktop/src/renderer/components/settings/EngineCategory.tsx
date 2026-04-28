import React, { useState } from 'react'
import { PencilSimple, Trash, Plus, X, FilePlus } from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingHeading } from './SettingHeading'
import type { EngineProfile } from '../../../shared/types'

interface EditState {
  name: string
  extensions: string[]
}

const emptyEdit: EditState = {
  name: '',
  extensions: [],
}

function profileToEdit(p: EngineProfile): EditState {
  return {
    name: p.name,
    extensions: [...(p.extensions || [])],
  }
}

function editToProfile(id: string, e: EditState): EngineProfile {
  return { id, name: e.name.trim(), extensions: e.extensions.filter(x => x.trim()) }
}

export function EngineCategory() {
  const colors = useColors()
  const profiles = usePreferencesStore((s) => s.engineProfiles)
  const addEngineProfile = usePreferencesStore((s) => s.addEngineProfile)
  const updateEngineProfile = usePreferencesStore((s) => s.updateEngineProfile)
  const removeEngineProfile = usePreferencesStore((s) => s.removeEngineProfile)

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

  const canSave = edit.name.trim() && edit.extensions.filter(x => x.trim()).length > 0

  const saveEdit = () => {
    if (!canSave) return
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

  const addExtensionFiles = async () => {
    const files = await window.ion?.selectExtensionFiles()
    if (files && files.length > 0) {
      setEdit((prev) => ({ ...prev, extensions: [...prev.extensions, ...files] }))
    }
  }

  const removeExtension = (index: number) => {
    setEdit((prev) => ({
      ...prev,
      extensions: prev.extensions.filter((_, i) => i !== index),
    }))
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

  const renderForm = () => (
    <div style={cardStyle}>
      <div style={fieldRow}>
        <label style={labelStyle}>Name *</label>
        <input
          type="text"
          value={edit.name}
          onChange={(e) => setEdit((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="e.g. cos"
          style={inputStyle}
        />
      </div>

      <div style={fieldRow}>
        <label style={labelStyle}>Extensions *</label>
        {edit.extensions.map((ext, i) => (
          <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input
              type="text"
              value={ext}
              onChange={(e) => {
                const updated = [...edit.extensions]
                updated[i] = e.target.value
                setEdit((prev) => ({ ...prev, extensions: updated }))
              }}
              style={inputStyle}
              readOnly
            />
            <button
              onClick={() => removeExtension(i)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: 4,
                color: colors.textTertiary,
                display: 'flex',
                alignItems: 'center',
                flexShrink: 0,
              }}
              title="Remove extension"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={addExtensionFiles}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '4px 10px',
            background: 'transparent',
            border: `1px dashed ${colors.containerBorder}`,
            borderRadius: 6,
            color: colors.textSecondary,
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          <FilePlus size={14} />
          Add Extension
        </button>
      </div>

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
          disabled={!canSave}
          style={{
            padding: '4px 12px',
            background: colors.accent,
            border: 'none',
            borderRadius: 6,
            color: '#fff',
            cursor: 'pointer',
            fontSize: 12,
            opacity: canSave ? 1 : 0.5,
          }}
        >
          Save
        </button>
      </div>
    </div>
  )

  const profileSubtitle = (p: EngineProfile) =>
    (p.extensions || []).map(e => e.split('/').pop()).join(', ')

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
