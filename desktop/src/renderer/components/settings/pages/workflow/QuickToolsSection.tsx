/**
 * QuickToolsSection — the shell commands in the ⚡ menu next to the input
 * bar. Your own tools are edited in a side panel; the tools the active
 * conversation's project ships in its `.ion/studio.json` are listed
 * read-only, since they are edited in that committed file.
 */
import React, { useState } from 'react'
import { Lightning, Plus, Trash } from '@phosphor-icons/react'
import type { QuickTool } from '@ion/shared/types'
import { useSettingsPreferences } from '../../settings-target'
import { useProjectStudioConfig } from '../../../composer/useProjectStudioConfig'
import { Button, CellText, DataList, EmptyState, MonoLine, Notice, Stack } from '../../kit'
import { QuickToolPanel, quickToolIcon } from './QuickToolPanel'

export function QuickToolsSection(): React.JSX.Element {
  const quickTools = useSettingsPreferences((s) => s.quickTools)
  const addQuickTool = useSettingsPreferences((s) => s.addQuickTool)
  const updateQuickTool = useSettingsPreferences((s) => s.updateQuickTool)
  const removeQuickTool = useSettingsPreferences((s) => s.removeQuickTool)
  const [editing, setEditing] = useState<QuickTool | 'new' | null>(null)

  return (
    <Stack gap={20}>
      <DataList
        label="Quick tools"
        title="Quick tools"
        description="Shell commands in the ⚡ menu next to the input bar. Commands can use {cwd} and {branch}."
        anchor="quick-tools"
        items={quickTools}
        getKey={(t) => t.id}
        noun={['tool', 'tools']}
        filter={(t, q) => t.name.toLowerCase().includes(q) || t.command.toLowerCase().includes(q)}
        showHeader
        onRowClick={(t) => setEditing(t)}
        columns={[
          { id: 'name', header: 'Tool', width: 'minmax(120px, 0.8fr)', render: (t) => { const Icon = quickToolIcon(t.icon); return <><Icon size={14} /><CellText>{t.name}</CellText></> } },
          { id: 'command', header: 'Command', width: 'minmax(0, 1.4fr)', render: (t) => <MonoLine>{t.command}</MonoLine> },
        ]}
        rowMenu={(t) => [{ label: 'Delete', icon: Trash, danger: true, onSelect: () => removeQuickTool(t.id) }]}
        actions={<Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>Add tool</Button>}
        empty={<EmptyState icon={Lightning} title="No quick tools yet" detail="Add a command you run often, like a deploy or a sync." />}
      />
      <ProjectQuickTools />
      <QuickToolPanel
        tool={editing}
        onClose={() => setEditing(null)}
        onSave={(tool) => {
          if (editing === 'new') addQuickTool(tool)
          else updateQuickTool(tool.id, tool)
          setEditing(null)
        }}
      />
    </Stack>
  )
}

/** The active conversation's project Quick Tools, read-only. */
function ProjectQuickTools(): React.JSX.Element | null {
  const { snapshot } = useProjectStudioConfig()
  if (!snapshot.root) return null
  const trust = snapshot.quickTools.length > 0
    ? (snapshot.trusted ? ' You have trusted this list.' : ' You have not trusted this list yet; you are asked on the first run.')
    : ''
  return (
    <Stack gap={8}>
      {snapshot.error && <Notice tone="error">The file was refused, so it grants no tools: {snapshot.error}.</Notice>}
      <DataList
        label="From this project"
        title="From this project"
        description={`Shipped by the active conversation's project in .ion/studio.json at ${snapshot.root}.${trust}`}
        items={snapshot.quickTools}
        getKey={(t) => t.id}
        noun={['tool', 'tools']}
        columns={[
          { id: 'name', width: 'minmax(120px, 0.8fr)', render: (t) => <CellText>{t.name}</CellText> },
          { id: 'command', width: 'minmax(0, 1.4fr)', render: (t) => <MonoLine>{t.command}</MonoLine> },
        ]}
        empty={<EmptyState title="This project ships no quick tools" />}
      />
    </Stack>
  )
}
