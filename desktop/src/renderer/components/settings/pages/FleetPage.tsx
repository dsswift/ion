/**
 * FleetPage — every Ion Studio Server this device is paired with, as one
 * Fleet, in three tabs. Quota: each provider's limits summed over its
 * accounts, and every account with its own. Servers: the servers
 * themselves, with what each last reported, and the ones the connection
 * registry hid or blocked. Compatibility: which servers can work with which.
 *
 * A server row opens that server's Overview; its `…` menu renames it, makes
 * it a Manage-Only Server, restarts or updates it, deploys a build of a
 * checkout on this device to it (a deploy that is running, or just ended, is
 * shown above the servers, from this device's own server's record of it), switches the account a provider CLI on it
 * is signed in to, removes a custom provider from it, sets the Fleet Hubs it reports to, or removes it. The menu also sets how often
 * this device opens new conversations on it when the picker is on Auto. Add server opens the add flow in
 * a side panel (also opened by the sidebar's + button). Account emails stay
 * hidden until Show emails, for every visit, so the page is safe to share
 * or capture. A search hit or a link to a part of the page opens the tab
 * that part is on.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { ArrowClockwise, ArrowSquareOut, Broadcast, Compass, DownloadSimple, Eye, EyeSlash, PencilSimple, Plugs, Plus, RocketLaunch, Trash, UserSwitch } from '@phosphor-icons/react'
import { isManageOnlyTarget, LOCAL_ENVIRONMENT_ID, type EnvironmentCatalogEntry } from '@ion/shared/types-environments'
import { fleetExpiringQuota, fleetQuotaPools, fleetTotals, mergeFleetAccounts, type FleetServer } from '@ion/shared/fleet-view'
import { PLACEMENT_WEIGHTS, PLACEMENT_WEIGHT_LABELS, scorePlacement, type PlacementWeight } from '@ion/shared/fleet-placement'
import { DEFAULT_SPARE_QUOTA_RULE } from '@ion/shared/usage-limit'
import { usePreferencesStore } from '../../../preferences'
import { placementWeights, setPlacementWeight } from '../../../studio/connection/placement'
import type { FleetReport } from '@ion/shared/types-fleet'
import { rError } from '../../../rendererLogger'
import { useSettingsServers } from '../settings-servers'
import { useSettingsNav } from '../settings-nav'
import { host } from '../../../host/host-instance'
import { Button, Notice, Stack, Tabs } from '../kit'
import { useFleet } from '../fleet/use-fleet'
import { useHostInstall } from '../fleet/use-host-install'
import { AddServerPanel } from './AddServerPanel'
import { RemoveServerPanel } from './RemoveServerPanel'
import { RenameServerPanel } from './RenameServerPanel'
import { DeployPanel } from './fleet/DeployPanel'
import { FleetDeploys } from './fleet/FleetDeploys'
import { useFleetDeploys } from '../fleet/use-fleet-deploys'
import { FleetServers } from './fleet/FleetServers'
import { FleetCompatibility } from './fleet/FleetCompatibility'
import { FleetTotals } from './fleet/FleetTotals'
import { FleetQuotaTab } from './fleet/FleetQuotaTab'
import { HiddenServers } from './fleet/HiddenServers'
import { SwitchAccountPanel } from './fleet/SwitchAccountPanel'
import { CustomProvidersPanel } from './fleet/CustomProvidersPanel'
import { FleetHubsPanel } from './fleet/FleetHubsPanel'

const isLocalEntry = (e: EnvironmentCatalogEntry): boolean => e.target.kind === 'local'
const isManaged = (e: EnvironmentCatalogEntry): boolean => e.target.kind !== 'local' && e.target.managed === true

type FleetTab = 'quota' | 'servers' | 'compatibility'

/** The tab each linkable part of the page is on. */
const ANCHOR_TABS: Record<string, FleetTab> = {
  'fleet-quota': 'quota',
  'fleet-accounts': 'quota',
  'fleet-totals': 'servers',
  'servers-list': 'servers',
  'add-server': 'servers',
  'hidden-servers': 'servers',
  'fleet-compatibility': 'compatibility',
}

function anchorTab(anchor: string | null): FleetTab | null {
  return anchor ? ANCHOR_TABS[anchor] ?? null : null
}

/** Whether an earlier fleet file's hosts were moved into the server list this session. */
let migrationAsked = false

/** TEST ONLY. */
export function _resetFleetPageForTest(): void { migrationAsked = false }

export function FleetPage(): React.JSX.Element {
  const servers = useSettingsServers()
  const { location, navigate } = useSettingsNav()
  const fleet = useFleet(servers.entries)
  const [tab, setTab] = useState<FleetTab>(() => anchorTab(location.anchor) ?? 'quota')
  const [adding, setAdding] = useState(location.anchor === 'add-server')
  const [renaming, setRenaming] = useState<EnvironmentCatalogEntry | null>(null)
  const [removing, setRemoving] = useState<EnvironmentCatalogEntry | null>(null)
  const [deploying, setDeploying] = useState<EnvironmentCatalogEntry | null>(null)
  const [deployOpen, setDeployOpen] = useState(false)
  // This device's own server holds the record of every deploy started here.
  const localId = servers.entries.find(isLocalEntry)?.id ?? LOCAL_ENVIRONMENT_ID
  const deploys = useFleetDeploys(localId)
  const [switching, setSwitching] = useState<EnvironmentCatalogEntry | null>(null)
  const [customizing, setCustomizing] = useState<EnvironmentCatalogEntry | null>(null)
  const [hubsOf, setHubsOf] = useState<EnvironmentCatalogEntry | null>(null)
  const install = useHostInstall(servers.entries)
  const [now, setNow] = useState(() => Date.now())
  const [revealEmails, setRevealEmails] = useState(false)

  // The sidebar's + navigates here with this anchor; each such navigation opens the panel.
  useEffect(() => {
    const wanted = anchorTab(location.anchor)
    if (wanted) setTab(wanted)
    if (location.anchor === 'add-server') setAdding(true)
  }, [location])
  // An earlier `ion fleet` kept its own host list. Once per session its
  // hosts are moved into this one; the list updates when the file changes.
  useEffect(() => {
    if (migrationAsked) return
    migrationAsked = true
    host.fleetRun({ kind: 'migrate' }).catch((err: unknown) => rError('settings.fleet', 'fleet migration could not start', { error: String(err) }))
  }, [])
  // Ages and reset times are relative to now; a new read of the Fleet is when they move.
  useEffect(() => { setNow(Date.now()) }, [fleet.servers])

  const byId = useMemo(() => new Map<string, FleetServer>(fleet.servers.map((s) => [s.id, s])), [fleet.servers])
  const accounts = useMemo(() => mergeFleetAccounts(fleet.servers), [fleet.servers])
  // A sign-in runs on the server itself, so only a connected one can switch accounts.
  const switchable = useMemo(() => new Set(fleet.servers.filter((s) => s.online).map((s) => s.id)), [fleet.servers])
  const switchOn = (serverId: string): void => setSwitching(servers.entries.find((e) => e.id === serverId) ?? null)
  // The ledger changes when a sign-in finishes; closing the panel reads it again.
  const closeSwitching = (): void => { setSwitching(null); fleet.refresh() }
  const totals = useMemo(() => fleetTotals(fleet.servers, accounts), [fleet.servers, accounts])
  const pools = useMemo(() => fleetQuotaPools(accounts, now), [accounts, now])
  // The burn-down uses this device's own server's rule for what counts as
  // about to expire; with that alert off, the built-in rule still applies here.
  const alertHours = usePreferencesStore((s) => s.quotaExpiryAlertHours)
  const alertPercent = usePreferencesStore((s) => s.quotaExpiryUnusedPercent)
  const expiring = useMemo(() => fleetExpiringQuota(accounts, now, alertHours > 0 ? { withinHours: alertHours, unusedPercent: alertPercent } : DEFAULT_SPARE_QUOTA_RULE), [accounts, now, alertHours, alertPercent])
  // Where a new conversation would go: each server's standing, and this device's weight for it.
  const [weights, setWeights] = useState(placementWeights)
  const setWeight = (entry: EnvironmentCatalogEntry, weight: PlacementWeight): void => { setPlacementWeight(entry.id, weight); setWeights(placementWeights()) }
  const standing = (e: EnvironmentCatalogEntry): string => {
    const server = byId.get(e.id)
    const score = scorePlacement({ id: e.id, label: e.label, online: server?.online ?? false, manageOnly: isManageOnlyTarget(e.target), weight: weights[e.id], report: server?.report ?? null, readAt: fleet.readAt[e.id] }, now)
    const weight = weights[e.id]
    return weight && weight !== 'never' && score.score > 0 ? `${score.reason} · ${PLACEMENT_WEIGHT_LABELS[weight].toLowerCase()}` : score.reason
  }
  const report = (e: EnvironmentCatalogEntry): FleetReport | null => byId.get(e.id)?.report ?? null
  const staleSince = (e: EnvironmentCatalogEntry): number | null => {
    const server = byId.get(e.id)
    return server && !server.online ? fleet.readAt[e.id] ?? null : null
  }

  const open = (entry: EnvironmentCatalogEntry): void => navigate({ pageId: 'overview', environmentId: entry.id, anchor: null })
  const setManageOnly = (entry: EnvironmentCatalogEntry, manageOnly: boolean): void => {
    servers.setManageOnly(entry, manageOnly).catch((err: unknown) => rError('settings.fleet', 'manage-only change failed', { environment_id: entry.id, error: String(err) }))
  }

  return (
    <Stack gap={20}>
      <Tabs<FleetTab>
        label="Fleet views"
        value={tab}
        onChange={setTab}
        // Emails are on both the Quota and the Servers view, so the control is beside the tabs.
        actions={<Button icon={revealEmails ? EyeSlash : Eye} onClick={() => setRevealEmails(!revealEmails)}>{revealEmails ? 'Hide emails' : 'Show emails'}</Button>}
        options={[
          { value: 'quota', label: 'Quota', count: accounts.length },
          { value: 'servers', label: 'Servers', count: servers.entries.length },
          { value: 'compatibility', label: 'Compatibility' },
        ]}
      />
      {tab === 'quota' && (
        <FleetQuotaTab accounts={accounts} pools={pools} expiring={expiring} loading={fleet.loading} refreshing={fleet.refreshing} onRefresh={fleet.refresh} switchable={switchable} onSwitch={switchOn} revealEmails={revealEmails} now={now} />
      )}
      {tab === 'servers' && <FleetTotals totals={totals} loading={fleet.loading} />}
      {tab === 'servers' && <FleetDeploys deploys={deploys} now={now} onOpen={() => { setDeploying(null); setDeployOpen(true) }} />}
      {tab === 'servers' && (
      <div data-settings-anchor="add-server">
        <FleetServers
          entries={servers.entries}
          report={report}
          staleSince={staleSince}
          standing={standing}
          revealEmails={revealEmails}
          now={now}
          onOpen={open}
          menu={(e) => [
            { label: 'Open', icon: ArrowSquareOut, onSelect: () => open(e) },
            !isLocalEntry(e) && { label: 'Rename', icon: PencilSimple, onSelect: () => setRenaming(e) },
            !isLocalEntry(e) && (isManageOnlyTarget(e.target)
              ? { label: 'Use for conversations', icon: Eye, onSelect: () => setManageOnly(e, false) }
              : { label: 'Manage only', icon: EyeSlash, onSelect: () => setManageOnly(e, true) }),
            ...PLACEMENT_WEIGHTS.filter((weight) => weight !== (weights[e.id] ?? 'normal')).map((weight) => ({ label: `New conversations: ${PLACEMENT_WEIGHT_LABELS[weight].toLowerCase()}`, icon: Compass, onSelect: () => setWeight(e, weight) })),
            switchable.has(e.id) && { label: 'Switch account…', icon: UserSwitch, onSelect: () => setSwitching(e) },
            switchable.has(e.id) && { label: 'Custom providers…', icon: Plugs, onSelect: () => setCustomizing(e) },
            switchable.has(e.id) && { label: 'Fleet hubs…', icon: Broadcast, onSelect: () => setHubsOf(e) },
            !isLocalEntry(e) && { label: 'Restart', icon: ArrowClockwise, onSelect: () => install.restart(e) },
            !isLocalEntry(e) && { label: 'Update to latest release', icon: DownloadSimple, onSelect: () => install.update(e) },
            !isLocalEntry(e) && { label: 'Deploy from source…', icon: RocketLaunch, onSelect: () => { setDeploying(e); setDeployOpen(true) } },
            !isLocalEntry(e) && !isManaged(e) && { label: 'Remove…', icon: Trash, danger: true, onSelect: () => setRemoving(e) },
          ]}
          actions={<Button variant="primary" icon={Plus} onClick={() => setAdding(true)}>Add server</Button>}
        />
        {servers.entries.map((e) => install.status[e.id]).filter((s) => s !== undefined).map((s, i) => (
          <div key={i} style={{ marginTop: 8 }}><Notice tone={s.tone}>{s.text}</Notice></div>
        ))}
      </div>
      )}
      {tab === 'servers' && <HiddenServers />}
      {tab === 'compatibility' && <FleetCompatibility servers={fleet.servers} />}
      <AddServerPanel open={adding} onClose={() => setAdding(false)} />
      <RenameServerPanel entry={renaming} onClose={() => setRenaming(null)} />
      <RemoveServerPanel entry={removing} onClose={() => setRemoving(null)} />
      <SwitchAccountPanel entry={switching} onClose={closeSwitching} />
      <CustomProvidersPanel entry={customizing} onClose={() => setCustomizing(null)} />
      <FleetHubsPanel entry={hubsOf} onClose={() => setHubsOf(null)} />
      <DeployPanel open={deployOpen} entry={deploying} entries={servers.entries.filter((e) => !isLocalEntry(e))} deploys={deploys} onClose={() => { setDeployOpen(false); setDeploying(null) }} />
    </Stack>
  )
}
