/**
 * engine-readiness -- the server's `/readyz` view of its engine, and the
 * work that waits for the first engine connection.
 */
import { log as _log, warn as _warn } from './logger'
import { settleEnterprisePolicyUnread } from './enterprise-policy-publish'
import { cacheEnterprisePolicy } from './enterprise-policy-cache'
import { checkEngineVersion } from './engine/version-check'
import type { HealthHandle } from './http/health'
import { sharedTenancyIsExplicit, noteEnginePrincipalPartitioning } from './config/current'
import { engineBridge, enterprisePolicyCache } from './state'
import { getEngineHostInfo } from './engine/engine-bridge-fs'
import { startConversationCleanup } from './maintenance/conversation-cleanup'
import {
  tabsFile,
  sessionChainsFile,
  sessionLabelsFile,
  legacyTabsFileForBackend,
  legacySessionChainsFileForBackend,
  legacySessionLabelsFileForBackend,
} from './persistence/settings-store'

function log(msg: string, fields?: Record<string, unknown>): void {
  _log('main', msg, fields)
}
function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('main', msg, fields)
}

/**
 * How often to re-check `engineBridge.connected` between the events the
 * bridge itself emits. The bridge's own reconnect loop (`engine-bridge-connection.ts`)
 * flips `connected` on socket close/reconnect but only ever emits a public
 * 'reconnected' event on RECOVERY, not on loss -- polling is what lets
 * `/readyz` notice a drop within one interval instead of only on the next
 * successful reconnect.
 */
const ENGINE_READINESS_POLL_MS = 2000

/**
 * Live engine readiness: connects, resolves the engine's version against
 * `server.json`'s `engine.minVersion`, and keeps polling `engineBridge.connected`
 * so a later drop (or recovery) is reflected on `/readyz` without a restart.
 */
export function wireEngineReadiness(health: HealthHandle, minVersion: string): void {
  health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: 'connecting to engine' })

  async function evaluateOnConnect(): Promise<void> {
    const info = await getEngineHostInfo()
    const version = info.ok && info.data ? info.data.version : undefined
    if (typeof version === 'string' && version) {
      const check = checkEngineVersion(version, minVersion)
      if (!check.ok) {
        health.setReadiness({
          ready: false,
          reason: 'engine_incompatible',
          detail:
            check.reason === 'unparseable_version'
              ? `engine version ${version} cannot be compared with required ${minVersion}`
              : `engine ${version} < required ${minVersion}`,
        })
        return
      }
    } else {
      warn('engine host info has no version field; skipping engine_incompatible check')
    }
    // FR-02: shared tenancy and FR-01 principal partitioning make opposite
    // assumptions -- shared tenancy means every connection sees every
    // tab, partitioning means each principal's own data is walled off
    // from others. Refuse to come up rather than silently let one
    // override the other's intent.
    noteEnginePrincipalPartitioning(info.ok && info.data?.principalPartitioning?.enabled === true)
    if (sharedTenancyIsExplicit() && info.ok && info.data?.principalPartitioning?.enabled) {
      health.setReadiness({
        ready: false,
        reason: 'tenancy_conflict',
        detail: 'server.json tenancy.mode is "shared" but the connected engine has principal partitioning enabled',
      })
      return
    }
    health.setReadiness({ ready: true })
  }

  engineBridge
    .connect()
    .then(evaluateOnConnect)
    .then(cacheEnterprisePolicy)
    .then(startConversationCleanupOnce)
    .catch((err: unknown) => {
      warn('initial engine connect failed; background reconnect loop will retry', { error: String(err) })
      // Welcomes wait for the first policy read; an unreachable engine must
      // not hold them. The reconnect path reads and publishes it later.
      settleEnterprisePolicyUnread('engine unreachable')
      health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: String(err) })
    })

  engineBridge.on('reconnected', () => {
    log('engine reconnected; re-evaluating readiness')
    void evaluateOnConnect()
      .then(cacheEnterprisePolicy)
      .catch((err: unknown) => warn('post-reconnect readiness evaluation failed', { error: String(err) }))
  })

  const poll = setInterval(() => {
    if (!engineBridge.connected && health.getReadiness().reason !== 'engine_incompatible') {
      health.setReadiness({ ready: false, reason: 'engine_unreachable', detail: 'engine socket not connected' })
    }
  }, ENGINE_READINESS_POLL_MS)
  poll.unref()
}

let conversationCleanupStarted = false

/**
 * Background conversation cleanup (dry-run by default), once per process.
 *
 * Explicit per-backend file paths rather than a lazy closure: an earlier
 * version resolved them inside the callback and silently returned `[]` on
 * any error, which once sent `excludeIds=[]` to the engine. The unified
 * files are the live sources; the legacy per-backend files are still read
 * during the merge-migration window. `conversationRetentionDays` (D-018)
 * turns the dry run into real deletions when the enterprise policy declares
 * a TTL, which is why this runs after the policy is cached.
 */
function startConversationCleanupOnce(): void {
  if (conversationCleanupStarted) return
  conversationCleanupStarted = true
  startConversationCleanup({
    tabsFiles: [tabsFile(), legacyTabsFileForBackend('api'), legacyTabsFileForBackend('cli')],
    chainsFiles: [sessionChainsFile(), legacySessionChainsFileForBackend('api'), legacySessionChainsFileForBackend('cli')],
    labelsFiles: [sessionLabelsFile(), legacySessionLabelsFileForBackend('api'), legacySessionLabelsFileForBackend('cli')],
  }, enterprisePolicyCache.policy?.conversationRetentionDays)
}
