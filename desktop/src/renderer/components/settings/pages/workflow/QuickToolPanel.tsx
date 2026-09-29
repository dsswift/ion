/**
 * QuickToolPanel — adds or edits one Quick Tool in a side panel: its name,
 * icon, command, and the directories it is scoped to. A tool needs a name
 * and a command to save.
 */
import React, { useEffect, useState } from 'react'
import {
  ArrowsClockwise, Broom, CheckCircle, Code, Database, Download, Gear, GitBranch, GitCommit, GitMerge, GitPullRequest,
  Globe, Hammer, Lightning, Package, Play, Rocket, Terminal, Upload, type Icon,
} from '@phosphor-icons/react'
import type { QuickTool } from '@ion/shared/types'
import { Button, Field, GroupHeader, IconButton, Inline, SidePanel, Stack, StringListEditor, TextInput } from '../../kit'

const ICONS: ReadonlyArray<{ name: string; icon: Icon }> = [
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

/** The icon a tool names, or Lightning for a name this build does not know. */
export function quickToolIcon(name: string): Icon {
  return ICONS.find((i) => i.name === name)?.icon ?? Lightning
}

interface Draft { name: string; icon: string; command: string; directories: string[] }

const EMPTY: Draft = { name: '', icon: 'Lightning', command: '', directories: [] }

function toDraft(tool: QuickTool | 'new'): Draft {
  return tool === 'new' ? EMPTY : { name: tool.name, icon: tool.icon, command: tool.command, directories: [...(tool.directories ?? [])] }
}

function toQuickTool(id: string, draft: Draft): QuickTool {
  const dirs = draft.directories.filter((d) => d.trim())
  return { id, name: draft.name.trim(), icon: draft.icon, command: draft.command.trim(), ...(dirs.length > 0 ? { directories: dirs } : {}) }
}

export function QuickToolPanel({ tool, onClose, onSave }: { tool: QuickTool | 'new' | null; onClose(): void; onSave(tool: QuickTool): void }): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(EMPTY)
  useEffect(() => { if (tool) setDraft(toDraft(tool)) }, [tool])
  const canSave = draft.name.trim() !== '' && draft.command.trim() !== ''
  const set = (patch: Partial<Draft>): void => setDraft((d) => ({ ...d, ...patch }))
  const save = (): void => {
    if (!canSave || !tool) return
    onSave(toQuickTool(tool === 'new' ? crypto.randomUUID().slice(0, 8) : tool.id, draft))
  }

  return (
    <SidePanel
      open={tool !== null}
      title={tool === 'new' ? 'Add a quick tool' : `Edit ${tool?.name ?? 'tool'}`}
      onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!canSave} onClick={save}>Save</Button>
      </>}
    >
      <Stack>
        <Field label="Name"><TextInput aria-label="Tool name" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Deploy Staging" /></Field>
        {/* Not a Field: a <label> forwards stray clicks to its first button. */}
        <div role="group" aria-label="Icon">
          <GroupHeader title="Icon" />
          <Inline gap={4} wrap>
            {ICONS.map(({ name, icon }) => (
              <IconButton key={name} icon={icon} label={name} aria-pressed={draft.icon === name} variant={draft.icon === name ? 'primary' : 'ghost'} onClick={() => set({ icon: name })} />
            ))}
          </Inline>
        </div>
        <Field label="Command" hint="Use {cwd} for the working directory and {branch} for the current git branch.">
          <TextInput aria-label="Tool command" mono value={draft.command} onChange={(e) => set({ command: e.target.value })} placeholder="e.g. cd {cwd} && git push origin {branch}" spellCheck={false} />
        </Field>
        <div role="group" aria-label="Directories">
          <GroupHeader title="Directories" description="Optional. Scope this tool to these directories. Leave empty to show it in every conversation." />
          <StringListEditor label="Tool directories" values={draft.directories} onChange={(directories) => set({ directories })} placeholder="/path/to/project" emptyText="Shown in every conversation." />
        </div>
      </Stack>
    </SidePanel>
  )
}
