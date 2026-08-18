import { IPC } from '../../shared/types'
import { log as _log, warn as _warn, error as _error } from '../logger'
import { state, modelCache, deviceFocusMap, engineBridge } from '../state'
import { broadcast, startTerminalOutputFlushing, stopTerminalOutputFlushing } from '../broadcast'
import { readSettings, writeSettings } from '../settings-store'
import { RemoteTransport } from './transport'
import { handleRemoteCommand } from './command-handler'
import { handlePairRequest } from './pairing-handler'
import { decodeSharedSecret, describeSecretFailure } from './device-secret'
import { revokeDeviceLocally } from './revoke'
import { startTabSnapshotPolling, stopTabSnapshotPolling } from './snapshot-polling'
import { getRemoteTabStates } from './snapshot'
import { startGitWatcherBridge, stopGitWatcherBridge } from './git-watcher-bridge'
import { focusState } from '../git/focus-state'
import { recentLocalDirectories } from '../../shared/recent-directories'
import { probeRelayAuthConfig, composeOidcScope } from './relay-auth'
import {
  clearResolvedRelayAuth,
  sendRelayConfigToPeers,
  setResolvedRelayAuth,
} from './relay-config-push'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

function error(msg: string, fields?: Record<string, unknown>): void {
  _error('main', msg, fields)
}

// ---------------------------------------------------------------------------
// Token refresh timer
// ---------------------------------------------------------------------------

/** How long before token expiry to rotate relay sockets. */
const TOKEN_REFRESH_LEAD_MS = 30 * 1000

/** Module-level token refresh timer. Cleared when transport is torn down. */
let tokenRefreshTimer: ReturnType<typeof setTimeout> | null = null

function clearTokenRefreshTimer(): void {
  if (tokenRefreshTimer !== null) {
    clearTimeout(tokenRefreshTimer)
    tokenRefreshTimer = null
  }
}

/**
 * Schedule a proactive token refresh before expiry. When the timer fires, mint
 * a fresh token and push a relay_config update to iOS as persisted bootstrap
 * recovery data. Autonomous OIDC clients keep their authenticated live socket;
 * legacy clients use the refreshed credential on their next reconnect.
 */
function scheduleTokenRefresh(oidcScope: string, expiresAtMs: number): void {
  clearTokenRefreshTimer()
  const refreshAt = expiresAtMs - TOKEN_REFRESH_LEAD_MS
  const delayMs = Math.max(0, refreshAt - Date.now())
  log('remote_transport: scheduling token refresh', { delay_ms: Math.round(delayMs), expires_at: new Date(expiresAtMs).toISOString() })

  tokenRefreshTimer = setTimeout(() => {
    tokenRefreshTimer = null
    void (async () => {
      try {
        const result = await engineBridge.request<{ accessToken?: string; expiresAt?: number }>('oidc_token', { oidcScope })
        if (!result.ok || !result.data?.accessToken) {
          warn('remote_transport: proactive token refresh failed, relay will reconnect on expiry', { error: result.error ?? 'no token' })
          return
        }
        const freshExpiry = result.data.expiresAt
        if (!freshExpiry) {
          warn('remote_transport: proactive token refresh returned no expiry; relay will reconnect on expiry')
          return
        }
        log('remote_transport: proactive token refresh succeeded, rotating relay sockets')

        // Relay auth happens during WebSocket upgrade. Existing sockets keep
        // their old bearer until relay closes them, so refresh must rebuild the
        // per-device relay clients now rather than only persisting bootstrap
        // config for iOS.
        state.remoteTransport?.updateConfig({ getCredential: buildGetCredential(oidcScope) })
        await sendRelayConfigToPeers('proactive-token-refresh')
        scheduleTokenRefresh(oidcScope, freshExpiry)
      } catch (err) {
        warn('remote_transport: proactive token refresh threw', { error: String(err) })
      }
    })()
  }, delayMs)
}

// ---------------------------------------------------------------------------
// Credential factory
// ---------------------------------------------------------------------------

/**
 * Build an OIDC credential factory for the given scope. Each call mints a
 * fresh bearer token via the engine's oidc_token command.
 *
 * Also schedules a proactive token refresh so iOS receives fresh credentials
 * before expiry.
 */
function buildGetCredential(oidcScope: string): () => Promise<string> {
  return async () => {
    const result = await engineBridge.request<{ accessToken?: string; expiresAt?: number }>('oidc_token', { oidcScope })
    if (!result.ok || !result.data?.accessToken) {
      throw new Error(result.error ?? 'oidc_token: no token returned')
    }
    const expiresAt = result.data.expiresAt ?? (Date.now() + 60 * 60 * 1000)
    // Schedule proactive refresh each time we mint a credential (idempotent:
    // rescheduling replaces the previous timer so it never double-fires).
    scheduleTokenRefresh(oidcScope, expiresAt)
    return result.data.accessToken
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function initRemoteTransport(settings: Record<string, unknown>): void {
  log('remote_transport: init', { remote_enabled: settings.remoteEnabled, relay_url: settings.relayUrl })

  if (state.remoteTransport) {
    clearTokenRefreshTimer()
    clearResolvedRelayAuth()
    stopTabSnapshotPolling()
    stopGitWatcherBridge()
    state.remoteTransport.stop().catch((err) => warn('remote_transport: stop failed during re-init', { error: String(err) }))
    state.remoteTransport = null
    // No transport = no remote clients; let the git focus gate suspend again.
    focusState.setRemoteClientCount(0)
  }

  if (!settings.remoteEnabled) {
    log('[Remote] remote not enabled, skipping')
    stopTerminalOutputFlushing()
    return
  }

  const relayUrl = (settings.relayUrl as string) || ''
  const relayApiKey = (settings.relayApiKey as string) || ''

  // Stored auth config from previous probe (set after async probe completes).
  // On first call settings.relayAuthMode may be undefined; the async probe
  // below will populate it and re-init the transport if OIDC is detected.
  const authMode = (settings.relayAuthMode as 'psk' | 'oidc' | undefined) || 'psk'
  const oidcAudience = (settings.relayOidcAudience as string) || ''
  const oidcRequiredScope = (settings.relayOidcRequiredScope as string) || ''

  const pairedDevices = settings.pairedDevices as any[] | undefined
  log('remote_transport: paired devices', { count: pairedDevices?.length || 0, has_relay: !!relayUrl, auth_mode: authMode })

  // Quarantine scan: report any stored pairing whose secret cannot be decoded
  // BEFORE a device tries to connect. Without this the operator only learns a
  // pairing is dead when the phone next fails to authenticate, and the failure
  // surfaces as "invalid proof" / "decryption failed" — symptoms that point at
  // the client rather than at this machine's secret store. The auth-time guard
  // in transport-lan-auth stays regardless: records can be written mid-session.
  for (const device of pairedDevices || []) {
    if (!device || typeof device !== 'object') continue
    const decoded = decodeSharedSecret(device.sharedSecret)
    if (!decoded.ok) {
      error('remote_transport: stored pairing secret unusable, device needs re-pair', {
        device_id: device.id,
        device_name: device.name,
        reason: decoded.reason,
        detail: describeSecretFailure(decoded.reason),
        decoded_bytes: decoded.byteLength,
        // Present ⇒ the device can recover over LAN with no PIN.
        has_mobile_device_id: !!device.mobileDeviceId,
      })
    }
  }

  // Build credential factory when in OIDC mode.
  let getCredential: (() => Promise<string>) | undefined
  if (authMode === 'oidc' && oidcAudience && oidcRequiredScope) {
    const scope = composeOidcScope(oidcAudience, oidcRequiredScope)
    log('remote_transport: using OIDC credential provider', { scope })
    getCredential = buildGetCredential(scope)
    // Record what the transport actually resolved so the iOS push doesn't
    // depend on settings.json still holding these keys when it fires.
    setResolvedRelayAuth({
      mode: 'oidc',
      issuer: (settings.relayOidcIssuer as string) || '',
      audience: oidcAudience,
      scope,
    })
  }

  state.remoteTransport = new RemoteTransport({
    relayUrl,
    relayApiKey,
    getCredential,
    lanPort: (settings.lanServerPort as number) || 19837,
    getPairedDevice: (deviceId: string) => {
      try {
        const s = readSettings()
        const devices = Array.isArray(s.pairedDevices) ? s.pairedDevices : []
        return devices.find((d: any) => d.id === deviceId) || null
      } catch (err) {
        // A swallowed failure here reads downstream as "unknown device" and
        // the client is told to re-pair over what may be a transient read
        // error. Never silent.
        warn('remote_transport: paired-device lookup failed', { device_id: deviceId, error: String(err) })
        return null
      }
    },
    getAllPairedDevices: () => {
      try {
        const s = readSettings()
        return Array.isArray(s.pairedDevices) ? s.pairedDevices : []
      } catch (err) {
        warn('remote_transport: paired-device list read failed', { error: String(err) })
        return []
      }
    },
  })

  // If relay URL is set but auth mode is not yet known (first init, no stored
  // config), probe the relay async. If it reports OIDC, swap the relay
  // credentials on the running transport without tearing down the LAN server
  // or Bonjour advertisement.
  if (relayUrl && authMode === 'psk') {
    void (async () => {
      const probed = await probeRelayAuthConfig(relayUrl)
      if (probed?.oidc && state.remoteTransport) {
        const scope = composeOidcScope(probed.audience, probed.requiredScope)
        log('remote_transport: relay requires OIDC, upgrading credential provider in-place', { issuer: probed.issuer, audience: probed.audience, scope })
        const credential = buildGetCredential(scope)
        // Record the probe's resolution before the hot-swap: peer-connect can
        // fire at any moment after this and must see OIDC, not the stale
        // stored mode.
        setResolvedRelayAuth({
          mode: 'oidc',
          issuer: probed.issuer,
          audience: probed.audience,
          scope,
        })
        // Hot-swap: update the relay credential on the running transport.
        // This reconnects relay clients with OIDC tokens but leaves the
        // LAN server, Bonjour, snapshot polling, and git watcher intact.
        state.remoteTransport.updateConfig({
          relayApiKey: '', // clear PSK; credential provider takes precedence
          getCredential: credential,
        })
        // Persist OIDC config to settings so the peer-connected push
        // (and any subsequent restarts) know the auth mode without re-probing.
        // Without this, peerSettings.relayAuthMode is undefined when iOS
        // connects, causing the peer-connected handler to send an empty token.
        try {
          const current = readSettings()
          writeSettings({
            ...current,
            relayAuthMode: 'oidc',
            relayOidcIssuer: probed.issuer,
            relayOidcAudience: probed.audience,
            // Persist the COMPOSED scope (api://<audience>/<scope>), not the
            // bare probed.requiredScope. protocol.ts documents
            // relayOidcRequiredScope as "Full OIDC scope string" and iOS
            // passes it verbatim to Entra — a bare "Relay.Access" resolves
            // against Microsoft Graph and fails with AADSTS650053.
            relayOidcRequiredScope: scope,
          })
          log('remote_transport: persisted OIDC config to settings', { issuer: probed.issuer, scope })
        } catch (err) {
          warn('remote_transport: failed to persist OIDC config to settings', { error: String(err) })
        }
      }
    })()
  }

  startTabSnapshotPolling()

  state.remoteTransport.on('peer-connected', () => {
    try {
      const s = readSettings()
      const devices = Array.isArray(s.pairedDevices) ? s.pairedDevices : []
      if (!devices.some((d: any) => d.sharedSecret)) {
        log('[Remote] peer connected but no paired device with shared secret -- skipping snapshot')
        return
      }
    } catch (err) {
      // A settings read failure here would silently skip the no-paired-device
      // guard and fall through to send a snapshot anyway. Log it.
      warn('[Remote] peer-connected settings read failed', { error: String(err) })
    }
    setTimeout(() => {
      void (async () => {
      const { tabs, resourceManifest } = await getRemoteTabStates()

      try {
        const peerSettings = readSettings()
        const persistedPeerRecentDirs: string[] = Array.isArray(peerSettings.recentBaseDirectories) ? peerSettings.recentBaseDirectories : []
        const peerRecentDirs = recentLocalDirectories(persistedPeerRecentDirs)
        const tabGroupMode = peerSettings.tabGroupMode || 'off'
        const tabGroups = Array.isArray(peerSettings.tabGroups) ? peerSettings.tabGroups.map((g: any) => ({ id: g.id, label: g.label, isDefault: g.isDefault, order: g.order })) : []
        state.remoteTransport?.send({
          type: 'desktop_snapshot',
          tabs,
          recentDirectories: peerRecentDirs,
          tabGroupMode,
          tabGroups,
          preferredModel: peerSettings.preferredModel || undefined,
          engineDefaultModel: peerSettings.engineDefaultModel || undefined,
          availableModels: modelCache.models.length > 0 ? modelCache.models : undefined,
          resources: Object.keys(resourceManifest).length > 0 ? resourceManifest : undefined,
        })
        // Relay config for iOS. The single push path resolves the auth mode
        // from the transport's own resolution (falling back to settings),
        // mints a fresh OIDC token when needed, and refuses to send a
        // credential-less config — an empty relayApiKey would overwrite the
        // phone's stored relay record and break its reconnect.
        const pushed = await sendRelayConfigToPeers('peer-connected')
        if (pushed.expiresAt && pushed.scope) {
          // Scope comes from the push result, not from resolved-auth state:
          // the refresh must mint against the same scope the push used, and a
          // `?? ''` fallback would arm a refresh that fails at mint time and
          // ends the chain (no re-schedule on that path).
          scheduleTokenRefresh(pushed.scope, pushed.expiresAt)
        }
        const profiles = Array.isArray(peerSettings.engineProfiles) ? peerSettings.engineProfiles : []
        state.remoteTransport?.send({ type: 'desktop_engine_profiles', profiles })
      } catch (err) {
        // A throw here means iOS silently never receives its snapshot on peer
        // connect — a view-readiness failure with no trace. Escalate to error.
        error('[Remote] auto-snapshot send failed', { error: String(err) })
      }

      // Start the git watcher bridge so tab directories get push-driven freshness
      const directories = new Set(tabs.map(t => t.workingDirectory).filter(Boolean))
      startGitWatcherBridge(directories)
      })().catch((err) => error('[Remote] peer-connected snapshot task failed', { error: String(err) }))
    }, 300)
  })

  state.remoteTransport.on('command', (cmd: any, deviceId: string) => {
    void handleRemoteCommand(cmd, deviceId).catch((err) => error('remote_transport: command handler failed', { error: String(err) }))
  })

  state.remoteTransport.on('state-change', (transportState: string) => {
    broadcast(IPC.REMOTE_STATE_CHANGED, { transportState })
    // Keep the git focus gate aware of remote attention: a connected iOS
    // device depends on proactive watcher pushes, so the watcher must not
    // suspend just because the desktop window is backgrounded. See
    // git/focus-state.ts for the full rationale.
    focusState.setRemoteClientCount(state.remoteTransport?.getConnectedDeviceIds().length ?? 0)
  })

  state.remoteTransport.on('device-unpaired', (deviceId: string) => {
    log('remote_transport: device unpaired via close code', { device_id: deviceId })
    deviceFocusMap.delete(deviceId)
    revokeDeviceLocally(deviceId)
  })

  state.remoteTransport.on('pair-request', handlePairRequest)

  state.remoteTransport.start().catch((err) => {
    log('remote_transport: failed to start', { error: (err as Error).message })
  })

  startTerminalOutputFlushing()
}
