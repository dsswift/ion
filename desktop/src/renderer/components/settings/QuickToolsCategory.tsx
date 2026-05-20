import React, { useState, type ComponentType } from 'react'
import { PencilSimple, Trash, Plus, X } from '@phosphor-icons/react'
import type { IconProps } from '@phosphor-icons/react'
import {
  Lightning,
  GitBranch,
  GitMerge,
  GitCommit,
  GitPullRequest,
  Terminal,
  Play,
  Rocket,
  ArrowsClockwise,
  Package,
  Hammer,
  Broom,
  Upload,
  Download,
  Database,
  Globe,
  Code,
  Gear,
  CheckCircle,
} from '@phosphor-icons/react'
import { useColors } from '../../theme'
import { usePreferencesStore } from '../../preferences'
import { SettingHeading } from './SettingHeading'
import type { QuickTool } from '../../../shared/types'

const ICON_ENTRIES: { name: string; icon: ComponentType<IconProps> }[] = [
  { name: 'Lightning', icon: Lightning },
  { name: 'GitBranch', icon: GitBranch },
  { name: 'GitMerge', icon: GitMerge },
  { name: 'GitCommit', icon: GitCommit },
  { name: 'GitPullRequest', icon: GitPullRequest },
  { name: 'Terminal', icon: Terminal },
  { name: 'Play', icon: Play },
  { name: 'Rocket', icon: Rocket },
  { name: 'ArrowsClockwise', icon: ArrowsClockwise },
  { name: 'Package', icon: Package },
  { name: 'Hammer', icon: Hammer },
  { name: 'Broom', icon: Broom },
  { name: 'Upload', icon: Upload },
  { name: 'Download', icon: Download },
  { name: 'Database', icon: Database },
  { name: 'Globe', icon: Globe },
  { name: 'Code', icon: Code },
  { name: 'Gear', icon: Gear },
  { name: 'CheckCircle', icon: CheckCircle },
]

const ICON_MAP: Record<string, ComponentType<IconProps>> = Object.fromEntries(
  ICON_ENTRIES.map((e) => [e.name, e.icon])
)

interface EditState {
  name: string
  icon: string
  command: string
  directories: string[]
}

const emptyEdit: EditState = { name: '', icon: 'Lightning', command: '', directories: [] }

function toolToEdit(t: QuickTool): EditState {
  return { name: t.name, icon: t.icon, command: t.command, directories: [...(t.directories || [])] }
}

function editToTool(id: string, e: EditState): QuickTool {
  const dirs = e.directories.filter((d) => d.trim())
  return { id, name: e.name.trim(), icon: e.icon, command: e.command.trim(), ...(dirs.length > 0 ? { directories: dirs } : {}) }
}

export function QuickToolsCategory() {
  const colors = useColors()
  const quickTools = usePreferencesStore((s) => s.quickTools)
  const addQuickTool = usePreferencesStore((s) => s.addQuickTool)
  const updateQuickTool = usePreferencesStore((s) => s.updateQuickTool)
  const removeQuickTool = usePreferencesStore((s) => s.removeQuickTool)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [edit, setEdit] = useState<EditState>(emptyEdit)
  const [isAdding, setIsAdding] = useState(false)

  const startEdit = (tool: QuickTool) => {
    setEditingId(tool.id)
    setEdit(toolToEdit(tool))
    setIsAdding(false)
  }

  const startAdd = () => {
    setIsAdding(true)
    setEditingId(null)
    setEdit(emptyEdit)
  }

  const canSave = edit.name.trim() && edit.command.trim()

  const saveEdit = () => {
    if (!canSave) return
    if (editingId) {
      updateQuickTool(editingId, editToTool(editingId, edit))
      setEditingId(null)
    } else if (isAdding) {
      addQuickTool(editToTool(crypto.randomUUID().slice(0, 8), edit))
      setIsAdding(false)
    }
  }

  const cancel = () => {
    setEditingId(null)
    setIsAdding(false)
  }

  const addDirectory = () => {
    setEdit((prev) => ({ ...prev, directories: [...prev.directories, ''] }))
  }

  const removeDirectory = (index: number) => {
    setEdit((prev) => ({ ...prev, directories: prev.directories.filter((_, i) => i !== index) }))
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

  const fieldRow: React.CSSProperties = { marginBottom: 6 }

  const renderIconPicker = () => (
    <div style={fieldRow}>
      <label style={labelStyle}>Icon</label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {ICON_ENTRIES.map((entry) => {
          const IconComp = entry.icon
          const isSelected = edit.icon === entry.name
          return (
            <button
              key={entry.name}
              onClick={() => setEdit((prev) => ({ ...prev, icon: entry.name }))}
              title={entry.name}
              style={{
                width: 30,
                height: 30,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 6,
                border: isSelected ? `2px solid ${colors.accent}` : `1px solid ${colors.containerBorder}`,
                background: isSelected ? colors.surfaceSecondary : 'transparent',
                cursor: 'pointer',
                color: isSelected ? colors.accent : colors.textSecondary,
                padding: 0,
              }}
            >
              <IconComp size={16} weight={isSelected ? 'fill' : 'regular'} />
            </button>
          )
        })}
      </div>
    </div>
  )

  const renderForm = () => (
    <div style={cardStyle}>
      <div style={fieldRow}>
        <label style={labelStyle}>Name *</label>
        <input
          type="text"
          value={edit.name}
          onChange={(e) => setEdit((prev) => ({ ...prev, name: e.target.value }))}
          placeholder="e.g. Deploy Staging"
          style={inputStyle}
        />
      </div>

      {renderIconPicker()}

      <div style={fieldRow}>
        <label style={labelStyle}>Command *</label>
        <input
          type="text"
          value={edit.command}
          onChange={(e) => setEdit((prev) => ({ ...prev, command: e.target.value }))}
          placeholder="e.g. cd {cwd} && git push origin {branch}"
          style={inputStyle}
        />
        <span style={{ fontSize: 10, color: colors.textTertiary, marginTop: 2, display: 'block' }}>
          Use {'{'}<code>cwd</code>{'}'} for working directory and {'{'}<code>branch</code>{'}'} for current git branch.
        </span>
      </div>

      <div style={fieldRow}>
        <label style={labelStyle}>Directories (optional)</label>
        <span style={{ fontSize: 10, color: colors.textTertiary, display: 'block', marginBottom: 4 }}>
          Scope this tool to specific directories. Leave empty to show in all tabs.
        </span>
        {edit.directories.map((dir, i) => (
          <div key={i} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input
              type="text"
              value={dir}
              onChange={(e) => {
                const updated = [...edit.directories]
                updated[i] = e.target.value
                setEdit((prev) => ({ ...prev, directories: updated }))
              }}
              placeholder="/path/to/project"
              style={inputStyle}
            />
            <button
              onClick={() => removeDirectory(i)}
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
              title="Remove directory"
            >
              <X size={14} />
            </button>
          </div>
        ))}
        <button
          onClick={addDirectory}
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
          <Plus size={14} />
          Add Directory
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

  const toolSubtitle = (tool: QuickTool) => {
    const cmd = tool.command.length > 40 ? tool.command.slice(0, 40) + '…' : tool.command
    return cmd
  }

  return (
    <>
      <SettingHeading first>Quick Tools</SettingHeading>
      <p style={{ fontSize: 11, color: colors.textTertiary, margin: '0 0 10px', lineHeight: 1.4 }}>
        Quick tools run shell commands from the ⚡ menu next to the input bar. Use template
        variables <code>{'{cwd}'}</code> and <code>{'{branch}'}</code> in commands.
      </p>

      {quickTools.map((tool) => {
        if (editingId === tool.id) return <React.Fragment key={tool.id}>{renderForm()}</React.Fragment>
        const IconComp = ICON_MAP[tool.icon] || Lightning
        return (
          <div key={tool.id} style={cardStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
                <IconComp size={16} weight="regular" style={{ flexShrink: 0, color: colors.textSecondary }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: colors.textPrimary }}>{tool.name}</div>
                  <div style={{
                    fontSize: 11,
                    color: colors.textTertiary,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    marginTop: 2,
                  }}>
                    {toolSubtitle(tool)}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0, marginLeft: 8 }}>
                <button
                  onClick={() => startEdit(tool)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: colors.textSecondary, display: 'flex', alignItems: 'center' }}
                  title="Edit tool"
                >
                  <PencilSimple size={14} />
                </button>
                <button
                  onClick={() => removeQuickTool(tool.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: colors.textTertiary, display: 'flex', alignItems: 'center' }}
                  title="Delete tool"
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
          Add Tool
        </button>
      )}
    </>
  )
}
