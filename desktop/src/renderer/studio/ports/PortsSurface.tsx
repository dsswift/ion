/**
 * PortsSurface — the `'ports'` singleton body: what is listening on the
 * active conversation's Environment, and which of those ports this desktop
 * forwards (`@ion/shared/port-forward`).
 *
 * Listeners owned by the conversation's own Terminals come first. Everything
 * else listening on that host follows, because a service the page depends on
 * may run in a container or in another conversation's Terminal.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { LOCAL_ENVIRONMENT_ID } from '@ion/shared/types-environments'
import { forwardedUrl, isForwardablePort, type PortForward, type PortListener } from '@ion/shared/port-forward'
import { StudioActionFailure } from '@ion/shared/studio-wire/action-failure'
import { useColors } from '../../theme'
import { useInteractiveState, interactiveBg } from '../../hooks/useInteractiveState'
import { action, host } from '../../host/host-instance'
import { useActiveTabEnvironmentId } from '../connection/tab-environment'
import { useEnvironmentLabel } from '../transfer/environment-label-cache'
import { useSurfaceStore } from '../surface/surface-store'
import { startPortForward, stopPortForward, usePortForwardStore, wirePortForwards } from './port-forward-store'
import { rDebug, rWarn } from '../../rendererLogger'

const REFRESH_MS = 5_000

interface ListenerState {
  /** Null until the first answer, so "still looking" never reads as "nothing is listening". */
  listeners: PortListener[] | null
  error: string | null
}

/** The Environment's listeners, re-read while the surface is on screen. */
function usePortListeners(environmentId: string, enabled: boolean): ListenerState & { refresh: () => void } {
  const [state, setState] = useState<ListenerState>({ listeners: null, error: null })
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    setState({ listeners: null, error: null })
  }, [environmentId])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = (): void => {
      action(environmentId, 'port.listeners', []).then(
        (value) => {
          if (cancelled) return
          setState({ listeners: Array.isArray(value) ? (value as PortListener[]) : [], error: null })
          timer = setTimeout(read, REFRESH_MS)
        },
        (err: unknown) => {
          if (cancelled) return
          const unsupported = err instanceof StudioActionFailure && err.code === 'unknown_action'
          rWarn('studio.ports', 'listeners could not be read', { environment_id: environmentId, unsupported, error: String(err) })
          setState({
            listeners: [],
            error: unsupported
              ? 'The Ion server on this Environment is too old to forward ports. Update it, then reopen this tab.'
              : `Could not read the listening ports: ${err instanceof Error ? err.message : String(err)}`,
          })
          // An old server will not learn the action by being asked again.
          if (!unsupported) timer = setTimeout(read, REFRESH_MS)
        },
      )
    }
    read()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [environmentId, enabled, tick])

  return { ...state, refresh }
}

function PortButton({ label, onClick, emphasis }: { label: string; onClick: () => void; emphasis?: boolean }): React.JSX.Element {
  const colors = useColors()
  const { hover, pressed, handlers } = useInteractiveState()
  return (
    <button
      type="button"
      data-ion-ui
      className="ion-focusable"
      onClick={onClick}
      {...handlers}
      style={{
        fontSize: 11, padding: '2px 8px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${colors.containerBorder}`,
        background: interactiveBg(colors, { hover, pressed }),
        color: emphasis ? colors.accent : colors.textSecondary,
      }}
    >
      {label}
    </button>
  )
}

interface PortRow {
  port: number
  processName: string | null
  url: string | null
  forward: PortForward | undefined
}

function PortRowView({ row, environmentId }: { row: PortRow; environmentId: string }): React.JSX.Element {
  const colors = useColors()
  const { forward } = row
  const open = (): void => {
    if (!forward) return
    // The application's own URL says which scheme it speaks. With no URL to go by, HTTPS.
    const url = row.url ? forwardedUrl(row.url, forward) : `https://localhost:${forward.localPort}`
    useSurfaceStore.getState().openBrowserTab(url, 'browse')
    rDebug('studio.ports', 'opened forwarded port in a browser tab', { environment_id: environmentId, remote_port: row.port, local_port: forward.localPort })
  }
  return (
    <div data-testid={`port-row-${row.port}`} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 1fr) minmax(0, 1fr) auto', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
      <span style={{ color: colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>{row.port}</span>
      <span style={{ color: colors.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {row.processName ?? '—'}{row.url ? ' · web' : ''}
      </span>
      <span style={{ color: forward ? colors.statusBash : colors.textTertiary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {forward ? `localhost:${forward.localPort}` : 'not forwarded'}
      </span>
      <span style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        {forward ? (
          <>
            <PortButton label="Open" onClick={open} emphasis />
            <PortButton label="Stop" onClick={() => void stopPortForward(environmentId, row.port)} />
          </>
        ) : (
          <PortButton label="Forward" onClick={() => void startPortForward(environmentId, row.port)} emphasis />
        )}
      </span>
    </div>
  )
}

function Section({ title, rows, environmentId, empty }: { title: string; rows: PortRow[]; environmentId: string; empty: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 11, fontWeight: 600, color: colors.textTertiary, textTransform: 'uppercase', letterSpacing: 0.4 }}>{title}</span>
      {rows.length === 0
        ? <span style={{ fontSize: 12, color: colors.textTertiary, padding: '4px 0' }}>{empty}</span>
        : rows.map((row) => <PortRowView key={row.port} row={row} environmentId={environmentId} />)}
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  const colors = useColors()
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', fontSize: 12, lineHeight: 1.5, color: colors.textTertiary }}>
      <span style={{ maxWidth: 380 }}>{children}</span>
    </div>
  )
}

export function PortsSurface(): React.JSX.Element {
  const colors = useColors()
  const tabId = useSessionStore((s) => s.activeTabId)
  const environmentId = useActiveTabEnvironmentId()
  const label = useEnvironmentLabel(environmentId) ?? environmentId
  const forwards = usePortForwardStore((s) => s.forwards)
  const lastError = usePortForwardStore((s) => s.lastError)
  const available = Boolean(host.portForward)
  const remote = environmentId !== LOCAL_ENVIRONMENT_ID
  const { listeners, error, refresh } = usePortListeners(environmentId, available && remote)
  const [manualPort, setManualPort] = useState('')

  useEffect(() => wirePortForwards(), [])

  const { mine, others, detached } = useMemo(() => {
    const forwardByPort = new Map(forwards.filter((f) => f.environmentId === environmentId).map((f) => [f.remotePort, f]))
    const toRow = (l: PortListener): PortRow => ({ port: l.port, processName: l.processName, url: l.url, forward: forwardByPort.get(l.port) })
    const all = listeners ?? []
    const listening = new Set(all.map((l) => l.port))
    return {
      mine: all.filter((l) => l.tabId !== null && l.tabId === tabId).map(toRow),
      others: all.filter((l) => l.tabId === null || l.tabId !== tabId).map(toRow),
      // Forwarded, but nothing reports listening there: typed by hand, or its service stopped.
      detached: [...forwardByPort.values()].filter((f) => !listening.has(f.remotePort)).map((f): PortRow => ({ port: f.remotePort, processName: null, url: null, forward: f })),
    }
  }, [forwards, listeners, environmentId, tabId])

  if (!available) return <Notice>Port forwarding listens on this machine, so it needs the desktop app.</Notice>
  if (!remote) return <Notice>This conversation runs on this machine. Its ports are already at localhost.</Notice>

  const manual = Number(manualPort)
  const forwardManual = (): void => {
    if (!isForwardablePort(manual)) return
    void startPortForward(environmentId, manual).then((result) => { if (result.ok) setManualPort('') })
  }
  const forwardMine = (): void => {
    for (const row of mine) if (!row.forward) void startPortForward(environmentId, row.port)
  }

  return (
    <div data-testid="ports-surface" style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: colors.textSecondary, flex: 1, minWidth: 160 }}>
          Ports on {label}, reached from this machine at localhost.
        </span>
        <input
          data-ion-ui
          aria-label="Port to forward"
          inputMode="numeric"
          placeholder="Port"
          value={manualPort}
          onChange={(e) => setManualPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onKeyDown={(e) => { if (e.key === 'Enter') forwardManual() }}
          style={{ width: 64, fontSize: 12, padding: '2px 6px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: colors.inputBg, color: colors.textPrimary, outline: 'none' }}
        />
        <PortButton label="Forward" onClick={forwardManual} emphasis />
        <PortButton label="Forward all" onClick={forwardMine} />
        <PortButton label="Refresh" onClick={refresh} />
      </div>
      {(lastError || error) && (
        <span data-testid="ports-error" style={{ fontSize: 12, color: colors.statusError }}>{lastError ?? error}</span>
      )}
      {listeners === null ? (
        <span style={{ fontSize: 12, color: colors.textTertiary }}>Looking for listening ports on {label}…</span>
      ) : (
        <>
          <Section title="This conversation" rows={mine} environmentId={environmentId} empty="No Terminal in this conversation is listening on a port." />
          {detached.length > 0 && <Section title="Forwarded" rows={detached} environmentId={environmentId} empty="" />}
          <Section title={`Other ports on ${label}`} rows={others} environmentId={environmentId} empty="Nothing else is listening." />
        </>
      )}
    </div>
  )
}
