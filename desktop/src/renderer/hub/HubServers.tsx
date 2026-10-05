/**
 * HubServers — the servers that report to this hub, one row each: name,
 * whether its link is open, what its own install is doing when it says, and
 * what it last reported. A server's menu
 * refreshes its usage (on a hub that shows Quota), restarts it, updates it, renames it on the hub, or
 * removes it from the hub. A server whose link is closed keeps its last report, dimmed, with
 * its age.
 */
import React, { useState } from 'react'
import { ArrowClockwise, ArrowsClockwise, DownloadSimple, PencilSimple, Trash } from '@phosphor-icons/react'
import type { HubAction, HubServer } from '@ion/shared/fleet-hub'
import { scorePlacement } from '@ion/shared/fleet-placement'
import { Button, Chip, DataList, EmptyState, Muted, Notice, StatusDot, TextInput, type Tone } from '../components/settings/kit'
import { describeHostInstall, formatAgo } from '../components/settings/fleet/fleet-format'
import { ServerFacts, serverFacts } from '../components/settings/pages/fleet/FleetServers'

export interface HubServersProps {
  servers: readonly HubServer[]
  canManage: boolean
  /** The hub shows the Quota view, so reading a server's usage again means something. */
  showUsage: boolean
  revealEmails: boolean
  now: number
  /** Runs one action on one server and resolves to what to tell the person. */
  onAction(server: HubServer, action: HubAction): Promise<{ tone: Tone; text: string }>
  onRemove(server: HubServer): Promise<void>
  /** Gives a server the hub's own name; an empty one goes back to the name it reports under. */
  onRename(server: HubServer, label: string): Promise<void>
}

function standing(server: HubServer, now: number): string {
  return scorePlacement({ id: server.id, label: server.label, online: server.online, manageOnly: false, weight: undefined, report: server.report, readAt: server.readAt ?? undefined }, now).reason
}

export function HubServers({ servers, canManage, showUsage, revealEmails, now, onAction, onRemove, onRename }: HubServersProps): React.JSX.Element {
  const [notice, setNotice] = useState<{ tone: Tone; text: string } | null>(null)
  const [removing, setRemoving] = useState<HubServer | null>(null)
  const [renaming, setRenaming] = useState<{ server: HubServer; label: string } | null>(null)
  const saveName = (): void => {
    if (!renaming) return
    const { server, label } = renaming
    setRenaming(null)
    void onRename(server, label)
  }
  const run = (server: HubServer, action: HubAction): void => {
    setNotice({ tone: 'muted', text: `Asking ${server.label}…` })
    void onAction(server, action).then(setNotice)
  }
  const acts = (server: HubServer): boolean => canManage && server.online && server.manage
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {removing && (
        <Notice tone="warn" action={<><Button onClick={() => setRemoving(null)}>Cancel</Button><Button variant="danger" onClick={() => { const server = removing; setRemoving(null); void onRemove(server) }}>Remove</Button></>}>
          Remove {removing.label} from this hub? It stops showing here and does not rejoin until the hub is added on it again.
        </Notice>
      )}
      {renaming && (
        <Notice action={<><Button onClick={() => setRenaming(null)}>Cancel</Button><Button variant="primary" onClick={saveName}>Save</Button></>}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>Name on this hub</span>
            <TextInput aria-label="Name on this hub" width={220} autoFocus value={renaming.label} onChange={(e) => setRenaming({ server: renaming.server, label: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') saveName() }} placeholder={renaming.server.reportedLabel ?? renaming.server.label} />
            <Muted>Leave it empty to use the name the server reports under.</Muted>
          </div>
        </Notice>
      )}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
      <DataList
        label="Servers"
        items={servers}
        getKey={(s) => s.id}
        noun={['server', 'servers']}
        filter={(s, q) => s.label.toLowerCase().includes(q)}
        columns={[
          { id: 'name', render: (s) => (
            <>
              <StatusDot tone={s.online ? 'ok' : 'muted'} label={s.online ? 'reporting' : 'not connected'} />
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</span>
              {s.reportedLabel && <Muted>reports as {s.reportedLabel}</Muted>}
            </>
          ) },
          { id: 'state', align: 'end', render: (s) => {
            const install = describeHostInstall(s.install, now)
            return (
            <span style={{ display: 'inline-flex', gap: 4 }}>
              {install && <Chip tone={install.tone}>{install.text}</Chip>}
              {!s.manage && <Chip>Reports only</Chip>}
              <Chip tone={s.online ? 'ok' : 'muted'}>{s.online ? 'reporting' : 'not connected'}</Chip>
            </span>
            )
          } },
        ]}
        detail={(s) => (
          <ServerFacts
            items={serverFacts(s.report, standing(s, now), revealEmails)}
            staleNote={s.online || s.readAt === null ? null : `Not connected now. Last report ${formatAgo(s.readAt, now)}.`}
          />
        )}
        rowMenu={(s) => [
          acts(s) && showUsage && { label: 'Refresh usage', icon: ArrowsClockwise, onSelect: () => run(s, 'fleet.refreshAccounts') },
          acts(s) && { label: 'Restart', icon: ArrowClockwise, onSelect: () => run(s, 'environment.server.restart') },
          acts(s) && { label: 'Update to latest release', icon: DownloadSimple, onSelect: () => run(s, 'environment.server.update') },
          canManage && { label: 'Rename…', icon: PencilSimple, onSelect: () => setRenaming({ server: s, label: s.reportedLabel ? s.label : '' }) },
          canManage && { label: 'Remove from this hub…', icon: Trash, danger: true, onSelect: () => setRemoving(s) },
        ]}
        empty={<EmptyState title="No servers report to this hub yet." detail="On a server, add this hub with its web address and its enrollment token: Settings → the server → Fleet hubs." />}
      />
    </div>
  )
}
