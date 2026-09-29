/**
 * EnvironmentUnavailable — what the operator sees in place of another
 * machine's conversation while this desktop cannot reach it.
 *
 * Two surfaces, one rule: never render another machine's state as though it
 * were current. `EnvironmentReconnectingNotice` replaces the composer for
 * the few seconds a dropped wire is being retried -- the transcript stays,
 * seconds old, but nothing can be sent into it. `EnvironmentOfflinePanel`
 * replaces the transcript once that Environment's rows have been dropped
 * altogether, so the conversation the operator was reading does not silently
 * become a blank one.
 */
import React from 'react'
import { useSessionStore } from '@ion/server/store/sessionStore'
import { useColors } from '../../theme'
import { registry } from './registry'
import { rInfo } from '../../rendererLogger'
import type { EnvironmentAvailability } from './environment-availability'

/** Opens Settings on the Environments category, where every catalogued server and its state lives. */
export function openEnvironmentSettings(): void {
  useSessionStore.getState().openSettings('environments')
}

/** Sits where the composer would be: says which machine is gone, and refuses input by existing. */
export function EnvironmentReconnectingNotice({ label, availability }: { label: string; availability: EnvironmentAvailability }): React.JSX.Element {
  const colors = useColors()
  return (
    <div data-ion-ui data-testid="environment-unavailable-notice" className="flex items-center w-full" style={{ minHeight: 50 }}>
      <span style={{ fontSize: 12, color: colors.textTertiary, paddingLeft: 2 }}>
        {availability === 'reconnecting'
          ? `Reconnecting to ${label}… nothing can be sent until it answers.`
          : `${label} is offline. Its conversations are hidden until it answers.`}
      </span>
    </div>
  )
}

/** Sits where the transcript would be, once the Environment's rows have been dropped. */
export function EnvironmentOfflinePanel({ environmentId, label }: { environmentId: string; label: string }): React.JSX.Element {
  const colors = useColors()
  return (
    <div
      data-testid="environment-offline-panel"
      style={{
        display: 'flex', flexDirection: 'column', height: '100%', gap: 10,
        alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center',
      }}
    >
      <span style={{ color: colors.textSecondary, fontSize: 14, fontWeight: 600 }}>{label} is offline</span>
      <span style={{ color: colors.textTertiary, fontSize: 12, maxWidth: 380, lineHeight: 1.5 }}>
        This conversation lives on {label}, and nothing it does reaches this machine right now. Its transcript is hidden rather than
        shown out of date — it comes back, current, the moment the connection does.
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => {
            rInfo('studio.availability', 'manual reconnect requested from the offline panel', { environment_id: environmentId })
            registry.refresh()
          }}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: `1px solid ${colors.containerBorder}`, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' }}
        >
          Reconnect now
        </button>
        <button
          type="button"
          onClick={openEnvironmentSettings}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: colors.accent, cursor: 'pointer' }}
        >
          Environments…
        </button>
      </div>
    </div>
  )
}
