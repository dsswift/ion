/**
 * AutomationActivityList — the last ten automation runs, newest first. A row
 * opens the run's stored evaluation path in a side panel. Older runs saved
 * without a trace still show their final outcome.
 */
import React, { useState } from 'react'
import type { AutomationHistoryEntry } from '@ion/shared/types-automation'
import { CellText, Chip, DataList, EmptyState, ErrorText, Muted, SidePanel, Stack, StatusDot, type Tone } from '../../kit'
import { traceRows, triggerLabel } from './automation-describe'

function outcomeTone(outcome: AutomationHistoryEntry['outcome']): Tone {
  return outcome === 'succeeded' ? 'ok' : outcome === 'failed' ? 'error' : 'warn'
}

export function AutomationActivityList({ history, nameFor }: { history: AutomationHistoryEntry[]; nameFor(automationId: string): string }): React.JSX.Element {
  const [open, setOpen] = useState<AutomationHistoryEntry | null>(null)
  const recent = history.slice(-10).reverse()
  return (
    <>
      <DataList
        label="Recent activity"
        title="Recent activity"
        description="Select a run to see the stored evaluation path."
        items={recent}
        getKey={(item) => item.id}
        showHeader
        onRowClick={(item) => setOpen(item)}
        columns={[
          { id: 'name', header: 'Automation', render: (item) => <><StatusDot tone={outcomeTone(item.outcome)} label={item.outcome} /><CellText>{nameFor(item.automationId)}</CellText></> },
          { id: 'trigger', header: 'Trigger', width: 'minmax(0, 1fr)', render: (item) => <CellText muted>{triggerLabel(item.eventType)}</CellText> },
          { id: 'time', header: 'Finished', render: (item) => <CellText muted>{new Date(item.finishedAt).toLocaleString()}</CellText> },
          { id: 'outcome', header: 'Outcome', render: (item) => <Chip tone={outcomeTone(item.outcome)}>{item.outcome}</Chip> },
        ]}
        empty={<EmptyState title="No workflow activity yet." />}
      />
      <SidePanel
        open={open !== null}
        title={open ? nameFor(open.automationId) : ''}
        subtitle={open ? `${triggerLabel(open.eventType)} · ${new Date(open.finishedAt).toLocaleString()} · ${open.outcome}` : undefined}
        onClose={() => setOpen(null)}
      >
        {open && (
          <Stack gap={8}>
            {open.trace
              ? <ol aria-label="Evaluation path" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {traceRows(open.trace).map((row, index) => <li key={`${index}-${row}`}><Muted>{row}</Muted></li>)}
                </ol>
              : <Muted>This older activity record has no step-by-step trace.</Muted>}
            <ErrorText>{open.error ? `Error: ${open.error}` : null}</ErrorText>
          </Stack>
        )}
      </SidePanel>
    </>
  )
}
