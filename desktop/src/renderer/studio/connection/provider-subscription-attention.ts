/**
 * provider-subscription-attention — which connected environment has a
 * Provider Subscription that needs a person, for the Provider Subscription
 * Prompt.
 *
 * It reads each environment's state when that environment connects and
 * follows `ion:provider-subscription-changed`, a complete snapshot sent on
 * every change. A dismissal is kept while the environment stays in the same
 * state, across reconnects too, so the prompt shows once per transition into
 * a state.
 */
import { useSyncExternalStore } from 'react'
import type { EnvironmentPhaseState } from '@ion/shared/types-environments'
import type { ProviderSubscriptionStatus } from '@ion/shared/types-engine-event'
import {
  nextSubscriptionAttention,
  type ProviderSubscriptionResult,
  type SubscriptionAttention,
} from '@ion/shared/provider-subscription'
import { action, host } from '../../host/host-instance'
import { rInfo, rWarn } from '../../rendererLogger'
import { registry } from './registry'

export const PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL = 'ion:provider-subscription-changed'

/** The prompt to show now: one environment and the snapshot that needs a person. */
export interface SubscriptionPrompt {
  environmentId: string
  attention: SubscriptionAttention
}

type Listener = () => void

class SubscriptionAttentionStore {
  private attention = new Map<string, SubscriptionAttention>()
  private connected = new Set<string>()
  /** Bumped by every pushed snapshot, so a slower read never overwrites a newer push. */
  private pushes = new Map<string, number>()
  private listeners = new Set<Listener>()
  private current: SubscriptionPrompt | null = null

  /** Follows every environment's connection and snapshots until the returned function is called. */
  start(): () => void {
    const offPhases = registry.subscribe((states) => this.onPhases(states))
    const offFrames = host.onFrame((environmentId, frame) => {
      if (frame.type !== 'studio_event' || frame.channel !== PROVIDER_SUBSCRIPTION_CHANGED_CHANNEL) return
      if (!frame.payload || typeof frame.payload !== 'object') return
      this.pushes.set(environmentId, (this.pushes.get(environmentId) ?? 0) + 1)
      this.apply(environmentId, frame.payload as ProviderSubscriptionStatus, 'push')
    })
    return () => {
      offPhases()
      offFrames()
    }
  }

  private onPhases(states: Map<string, EnvironmentPhaseState>): void {
    let changed = false
    for (const [environmentId, state] of states) {
      const isConnected = state.phase === 'connected'
      if (isConnected === this.connected.has(environmentId)) continue
      changed = true
      if (isConnected) {
        this.connected.add(environmentId)
        void this.read(environmentId)
      } else {
        this.connected.delete(environmentId)
      }
    }
    if (changed) this.recompute()
  }

  private async read(environmentId: string): Promise<void> {
    const pushesBefore = this.pushes.get(environmentId) ?? 0
    try {
      const result = await action(environmentId, 'provider.subscription', []) as ProviderSubscriptionResult
      if ((this.pushes.get(environmentId) ?? 0) !== pushesBefore) {
        rInfo('subscription-prompt', 'state read superseded by a pushed snapshot', { environment_id: environmentId })
        return
      }
      this.apply(environmentId, result.subscription, 'read')
    } catch (err) {
      rWarn('subscription-prompt', 'state read failed', { environment_id: environmentId, error: String(err) })
    }
  }

  /** Replaces one environment's state with a snapshot. */
  apply(environmentId: string, status: ProviderSubscriptionStatus, source: 'read' | 'push' | 'action'): void {
    const previous = this.attention.get(environmentId) ?? null
    const next = nextSubscriptionAttention(previous, status)
    if (next) this.attention.set(environmentId, next)
    else this.attention.delete(environmentId)
    if (previous?.state !== next?.state) {
      rInfo('subscription-prompt', 'attention state changed', {
        environment_id: environmentId, source, state: status.state, from: previous?.state ?? '', to: next?.state ?? '',
      })
    }
    this.recompute()
  }

  /** Hides the prompt for the state this environment is in now. */
  dismiss(environmentId: string): void {
    const current = this.attention.get(environmentId)
    if (!current || current.dismissed) return
    this.attention.set(environmentId, { ...current, dismissed: true })
    rInfo('subscription-prompt', 'prompt dismissed', { environment_id: environmentId, state: current.state })
    this.recompute()
  }

  private recompute(): void {
    let next: SubscriptionPrompt | null = null
    for (const [environmentId, attention] of this.attention) {
      if (attention.dismissed || !this.connected.has(environmentId)) continue
      next = { environmentId, attention }
      break
    }
    if (next?.environmentId === this.current?.environmentId && next?.attention === this.current?.attention) return
    this.current = next
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  prompt = (): SubscriptionPrompt | null => this.current

  /** Test-only reset. */
  _resetForTest(): void {
    this.attention.clear()
    this.connected.clear()
    this.pushes.clear()
    this.listeners.clear()
    this.current = null
  }
}

export const subscriptionAttentionStore = new SubscriptionAttentionStore()

/** The prompt to show now, or null. */
export function useSubscriptionPrompt(): SubscriptionPrompt | null {
  return useSyncExternalStore(subscriptionAttentionStore.subscribe, subscriptionAttentionStore.prompt)
}
