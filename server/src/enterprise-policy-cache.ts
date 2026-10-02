/**
 * The enterprise policy blob (D-004), fetched once the bridge is up and kept
 * for the readers that run later: `studio_welcome.enterprisePolicy`, the
 * settings-group visibility filter, the settings policy, the automation
 * policy, the model-cache filter. A null policy (no enterprise config, engine
 * unreachable) means no constraints, the safe default for an unmanaged
 * install.
 */
import { discovery } from './discovery/runtime'
import { getEnterprisePolicy, getEnterprisePolicyNewConversationDefaults } from './engine/engine-bridge-fs'
import { publishEnterprisePolicy, settleEnterprisePolicyUnread } from './enterprise-policy-publish'
import { log as _log, warn as _warn } from './logger'
import { applySettingsPolicy } from './settings-policy-apply'
import { enterprisePolicyCache } from './state'

function log(msg: string, fields?: Record<string, unknown>): void { _log('main', msg, fields) }
function warn(msg: string, fields?: Record<string, unknown>): void { _warn('main', msg, fields) }

export async function cacheEnterprisePolicy(): Promise<void> {
  try {
    publishEnterprisePolicy(await getEnterprisePolicy())
  } catch (err) {
    warn('enterprise policy fetch failed; proceeding unconstrained', { error: String(err) })
    settleEnterprisePolicyUnread('fetch failed')
  }
  try {
    enterprisePolicyCache.newConversationDefaults = await getEnterprisePolicyNewConversationDefaults()
  } catch (err) {
    warn('new-conversation policy fetch failed; proceeding unconstrained', { error: String(err) })
  }
  log('enterprise policy cached', { has_policy: enterprisePolicyCache.policy !== null, has_defaults: enterprisePolicyCache.newConversationDefaults !== null })
  applySettingsPolicy(enterprisePolicyCache.policy, 'policy read')
  // The LAN-discovery seal lives in this policy and can arrive after boot.
  discovery()?.reconcile()
}
