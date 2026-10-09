/**
 * HubApp — the Fleet Hub portal. Three views of the servers that report to
 * the hub: Quota (each provider's limits summed over its accounts, and
 * every account), Servers (the deploys the hub was told of, then each server
 * and what it can be asked to do, and the way to add one), and Compatibility (which servers can
 * work with which). A hub whose `hub.json` turns Quota off opens on Servers.
 */
import React, { useEffect, useMemo, useState } from 'react'
import { Eye, EyeSlash, SignOut } from '@phosphor-icons/react'
import type { HubAction, HubServer } from '@ion/shared/fleet-hub'
import { fleetExpiringQuota, fleetQuotaPools, fleetTotals, mergeFleetAccounts, type FleetServer } from '@ion/shared/fleet-view'
import { DEFAULT_SPARE_QUOTA_RULE } from '@ion/shared/usage-limit'
import { useColors } from '../theme'
import { Button, Chip, EmptyState, KIT, Tabs, type Tone } from '../components/settings/kit'
import { FleetCompatibility } from '../components/settings/pages/fleet/FleetCompatibility'
import { FleetQuotaTab } from '../components/settings/pages/fleet/FleetQuotaTab'
import { FleetTotals } from '../components/settings/pages/fleet/FleetTotals'
import { createEnrollmentToken, removeHubServer, renameHubServer, runHubAction, signOut, useHubFleet, type IssuedEnrollmentToken } from './hub-client'
import { HubDeploys } from './HubDeploys'
import { HubServers } from './HubServers'
import { rError } from '../rendererLogger'

type HubTab = 'quota' | 'servers' | 'compatibility'

const NO_SERVERS: readonly HubServer[] = []
const NOBODY: ReadonlySet<string> = new Set()

const ACTION_DONE: Record<HubAction, string> = {
  'fleet.refreshAccounts': 'read its usage again',
  'environment.server.restart': 'is restarting',
  'environment.server.update': 'is updating to the latest release',
}

const PHONE_QUERY = '(max-width: 600px)'

/** Whether the window is as narrow as a phone. */
function usePhoneWidth(): boolean {
  const [phone, setPhone] = useState(() => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches)
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(PHONE_QUERY)
    const update = (): void => setPhone(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return phone
}

export function HubApp(): React.JSX.Element {
  const colors = useColors()
  const { fleet, live, error } = useHubFleet()
  const [chosen, setTab] = useState<HubTab | null>(null)
  const [revealEmails, setRevealEmails] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const phone = usePhoneWidth()
  const hubServers = fleet?.servers ?? NO_SERVERS
  // Ages and reset times are relative to now; a new read of the Fleet is when they move.
  useEffect(() => { setNow(Date.now()) }, [fleet])
  useEffect(() => { if (fleet) document.title = fleet.hub.label }, [fleet])

  const servers = useMemo<FleetServer[]>(() => hubServers.map((s) => ({ id: s.id, label: s.label, online: s.online, report: s.report })), [hubServers])
  const accounts = useMemo(() => mergeFleetAccounts(servers), [servers])
  const pools = useMemo(() => fleetQuotaPools(accounts, now), [accounts, now])
  const expiring = useMemo(() => fleetExpiringQuota(accounts, now, DEFAULT_SPARE_QUOTA_RULE), [accounts, now])
  const totals = useMemo(() => fleetTotals(servers, accounts), [servers, accounts])
  const canManage = fleet?.hub.canManage ?? false
  const showQuota = fleet?.hub.views.quota ?? true
  const wanted = chosen ?? 'quota'
  const tab: HubTab = wanted === 'quota' && !showQuota ? 'servers' : wanted

  const act = async (server: HubServer, action: HubAction): Promise<{ tone: Tone; text: string }> => {
    try {
      const response = await runHubAction(server.id, action)
      return response.ok ? { tone: 'ok', text: `${server.label} ${ACTION_DONE[action]}.` } : { tone: 'error', text: `${server.label}: ${response.error}` }
    } catch (err) {
      rError('hub.app', 'action failed', { server_id: server.id, action, error: String(err) })
      return { tone: 'error', text: `${server.label}: the hub could not be reached.` }
    }
  }
  /** Has every server that takes this hub's actions read its provider CLIs again. Each sends a new report when it is done. */
  const refreshAll = (): void => {
    setRefreshing(true)
    Promise.all(hubServers.filter((s) => s.online && s.manage).map((s) => runHubAction(s.id, 'fleet.refreshAccounts')))
      .catch((err: unknown) => rError('hub.app', 'refresh failed', { error: String(err) }))
      .finally(() => setRefreshing(false))
  }
  const remove = async (server: HubServer): Promise<void> => {
    await removeHubServer(server.id).catch((err: unknown) => rError('hub.app', 'server removal failed', { server_id: server.id, error: String(err) }))
  }

  const rename = async (server: HubServer, label: string): Promise<void> => {
    await renameHubServer(server.id, label).catch((err: unknown) => rError('hub.app', 'server rename failed', { server_id: server.id, error: String(err) }))
  }

  const issueToken = (): Promise<IssuedEnrollmentToken> =>
    createEnrollmentToken().catch((err: unknown): IssuedEnrollmentToken => {
      rError('hub.app', 'enrollment token request failed', { error: String(err) })
      return { ok: false, error: 'The hub could not be reached.' }
    })

  return (
    // The renderer's base styles lock the window so Studio scrolls inside its own panels. This page has none, so it is its own scroller.
    <div data-hub-scroller style={{ height: '100dvh', overflowY: 'auto', WebkitOverflowScrolling: 'touch', userSelect: 'text', background: colors.containerBg, color: colors.textPrimary, fontFamily: 'var(--ion-font-family, system-ui, sans-serif)' }}>
      <div style={{ maxWidth: 1120, margin: '0 auto', padding: 'clamp(14px, 4vw, 28px)', paddingBottom: 48, display: 'flex', flexDirection: 'column', gap: KIT.groupGap }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* The name comes from the hub's own configuration. A phone has no room for it; it is still the page's title there. */}
          {!phone && <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>{fleet?.hub.label ?? 'Ion Fleet'}</h1>}
          {fleet && <Chip tone={live ? 'ok' : 'warn'}>{live ? 'live' : 'reconnecting'}</Chip>}
          <div style={{ flex: 1 }} />
          {fleet?.hub.user && <span style={{ fontSize: KIT.fontSmall, color: colors.textSecondary }}>{fleet.hub.user}</span>}
          {fleet?.hub.authRequired && <Button icon={SignOut} onClick={() => void signOut()}>Sign out</Button>}
        </header>
        {!fleet ? (
          <EmptyState title={error ? 'This hub could not be read.' : 'Reading the Fleet…'} detail={error ?? undefined} />
        ) : (
          <>
            <Tabs<HubTab>
              label="Fleet views"
              value={tab}
              onChange={setTab}
              // Emails are on both the Quota and the Servers view, so the control is beside the tabs.
              actions={<Button icon={revealEmails ? EyeSlash : Eye} onClick={() => setRevealEmails(!revealEmails)}>{revealEmails ? 'Hide emails' : 'Show emails'}</Button>}
              options={[
                ...(showQuota ? [{ value: 'quota' as const, label: 'Quota', count: accounts.length }] : []),
                { value: 'servers', label: 'Servers', count: hubServers.length },
                { value: 'compatibility', label: 'Compatibility' },
              ]}
            />
            {tab === 'quota' && (
              <FleetQuotaTab accounts={accounts} pools={pools} expiring={expiring} loading={false} refreshing={refreshing} onRefresh={canManage ? refreshAll : undefined} switchable={NOBODY} onSwitch={() => {}} revealEmails={revealEmails} now={now} />
            )}
            {tab === 'servers' && <FleetTotals totals={totals} loading={false} />}
            {tab === 'servers' && <HubDeploys deploys={fleet.deploys} servers={hubServers} now={now} />}
            {tab === 'servers' && <HubServers servers={hubServers} canManage={canManage} showUsage={showQuota} revealEmails={revealEmails} now={now} onAction={act} onRemove={remove} onRename={rename} hubUrl={window.location.origin} onIssueToken={issueToken} />}
            {tab === 'compatibility' && <FleetCompatibility servers={servers} />}
          </>
        )}
      </div>
    </div>
  )
}
