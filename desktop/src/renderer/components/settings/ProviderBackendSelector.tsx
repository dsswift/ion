import React, { useState } from 'react'
import type { ProviderEntry } from '../../../shared/types-models'
import type { Colors } from './provider-styles'
import { PROVIDER_BACKENDS, backendLabel, providerCliBackend } from './provider-auth-labels'

/**
 * Segmented backend selector for a provider that can run on more than one
 * backend (anthropic: API / Claude Code; openai: API / ChatGPT; xai: API /
 * Grok). Reads the currently selected backend from the engine's ProviderEntry
 * and applies a change via setProviderBackend, which restarts the engine.
 */
export function ProviderBackendSelector({ provider, colors }: { provider: ProviderEntry; colors: Colors }) {
  const options = PROVIDER_BACKENDS[provider.id]
  const [confirming, setConfirming] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)

  if (!options || options.length < 2) return null

  // The selected backend: the engine's projection, else the provider's default.
  const current = provider.backend || (provider.id === 'anthropic' ? 'claude-code' : 'api')

  const handleSelect = (target: string) => {
    if (target === current || restarting) return
    setConfirming(target)
  }

  const confirm = () => {
    if (!confirming || restarting) return
    setRestarting(true)
    void window.ion.setProviderBackend(provider.id, confirming)
  }

  return (
    <div style={{ marginBottom: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, color: colors.textTertiary }}>Backend:</span>
        <div style={{ display: 'inline-flex', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 5, overflow: 'hidden' }}>
          {options.map((mode) => (
            <button key={mode} onClick={() => handleSelect(mode)} style={{
              padding: '2px 10px', background: current === mode ? colors.accent : 'transparent',
              color: current === mode ? '#fff' : colors.textTertiary, border: 'none',
              cursor: 'pointer', fontSize: 11, fontWeight: current === mode ? 600 : 400,
              transition: 'background 0.15s, color 0.15s',
            }}>
              {backendLabel(mode)}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 10, color: colors.textTertiary }}>
          {providerCliBackend(provider.id) === current ? 'Subscription via CLI' : 'Direct API with API key'}
        </span>
      </div>
      {(confirming || restarting) && (
        <div style={{ marginTop: 6, padding: '8px 10px', background: colors.surfacePrimary, border: `1px solid ${colors.containerBorder}`, borderRadius: 6, fontSize: 11, color: colors.textSecondary }}>
          {restarting ? <span style={{ fontWeight: 500 }}>Restarting…</span> : (
            <>
              Switch to <strong>{backendLabel(confirming!)}</strong>? The engine will restart.{' '}
              <button onClick={confirm} style={{ color: colors.accent, background: 'none', border: 'none', fontWeight: 600, cursor: 'pointer', fontSize: 11 }}>Switch</button>
              {' · '}
              <button onClick={() => setConfirming(null)} style={{ color: colors.textTertiary, background: 'none', border: 'none', cursor: 'pointer', fontSize: 11 }}>Cancel</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
