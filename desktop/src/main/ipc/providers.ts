import { ipcMain } from 'electron'
import { IPC } from '../../shared/types'
import { log as _log } from '../logger'
import { engineBridge } from '../state'
import { readEngineConfig } from '../settings-store'
import { writeConfigAndRelaunch } from '../engine-restart'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('providers-ipc', msg, fields)
}

// Providers that have a delegated CLI backend option, and their default backend
// under hybrid routing. Mirrors the engine's providerCliKind / default rule.
const CLI_PROVIDERS = ['anthropic', 'openai', 'xai', 'cursor'] as const
function defaultBackend(provider: string): string {
  if (provider === 'anthropic') return 'claude-code'
  if (provider === 'cursor') return 'cursor'
  return 'api'
}

/**
 * The backend that currently serves a provider, given the top-level backend and
 * any per-provider preference. Mirrors the engine's SelectedBackend so the
 * desktop can pin providers when enabling hybrid without changing behavior.
 */
function effectiveBackend(cfg: Record<string, any>, provider: string): string {
  const top = (cfg.backend as string) || 'api'
  if (top === 'api') return 'api'
  if (top === 'claude-code' || top === 'cli') return provider === 'anthropic' ? 'claude-code' : 'api'
  // hybrid
  const pref = cfg.providers?.[provider]?.backend
  return pref || defaultBackend(provider)
}

export function registerProvidersIpc(): void {
  ipcMain.handle(IPC.PROVIDER_LOGIN, async (_e, { provider }: { provider: string }) => {
    log('provider_login', { provider })
    return engineBridge.providerLogin(provider)
  })

  ipcMain.handle(IPC.PROVIDER_LOGIN_CANCEL, async (_e, { provider }: { provider: string }) => {
    log('provider_login_cancel', { provider })
    return engineBridge.providerLoginCancel(provider)
  })

  ipcMain.handle(IPC.PROVIDER_LOGOUT, async (_e, { provider }: { provider: string }) => {
    log('provider_logout', { provider })
    return engineBridge.providerLogout(provider)
  })

  // Set a provider's run backend. Per-provider preferences only take effect
  // under hybrid routing, so this enables hybrid and pins every CLI-capable
  // provider to the backend it was already using — so only the target provider
  // changes. Requires an engine restart (the daemon re-reads config on boot).
  ipcMain.handle(
    IPC.PROVIDER_SET_BACKEND,
    async (_e, { provider, backend }: { provider: string; backend: string }) => {
      if (typeof provider !== 'string' || typeof backend !== 'string' || !provider || !backend) {
        return { ok: false, error: 'provider and backend are required' }
      }
      const current = readEngineConfig()
      if (effectiveBackend(current, provider) === backend) {
        return { ok: true } // no-op: already the selected backend
      }
      log('provider_set_backend', { provider, backend })
      await writeConfigAndRelaunch((cfg) => {
        // Snapshot every CLI-capable provider's effective backend BEFORE
        // enabling hybrid, so pinning preserves their current behavior.
        const snapshot: Record<string, string> = {}
        for (const p of CLI_PROVIDERS) snapshot[p] = effectiveBackend(cfg, p)
        cfg.backend = 'hybrid'
        cfg.providers = (cfg.providers as Record<string, any>) || {}
        for (const p of CLI_PROVIDERS) {
          cfg.providers[p] = { ...(cfg.providers[p] || {}), backend: snapshot[p] }
        }
        cfg.providers[provider] = { ...(cfg.providers[provider] || {}), backend }
      })
      return { ok: true }
    },
  )
}
