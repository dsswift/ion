/**
 * model-resolution — the one place the server decides which model a
 * conversation runs on.
 *
 * Every surface that needs the answer asks here: the prompt send path, the
 * phone's create echo, and the `resolvedModel` the server publishes so that
 * no client derives it again from settings of its own. A client's local
 * default model says nothing about a conversation on another server, and two
 * resolvers on one server can disagree, so there is exactly one.
 *
 * Precedence:
 *   1. the conversation's own selection (`modelOverride`): a user pick, or an
 *      automatic one from the plan split or a workflow
 *   2. `engineDefaultModel`, when a harness governs the conversation
 *   3. `preferredModel`
 *   4. nothing: the engine applies its own configured default, or refuses
 *
 * No literal fallback past that. Inventing a model id would pick a provider
 * the operator may never have configured.
 *
 * The two defaults are Account settings: they belong to a person, on this
 * server. They are read for the conversation's OWNER, because most callers
 * run with no request in context, and the host account's default is not the
 * owner's.
 */
import type { ConversationInstance } from '@ion/shared/types-engine'
import { tabHasExtensions } from '@ion/shared/tab-predicates'
import { readEffectiveSettings } from './persistence/effective-settings'
import { isModelAllowedByPolicy, type ModelPolicy } from '@ion/shared/enterprise-model-policy'
import { currentEnterprisePolicy } from './enterprise-policy-source'
import { log as _log } from './logger'


/**
 * A saved default the policy forbids is not a default. The engine refuses a
 * prompt on a forbidden model outright, so carrying one forward (a default
 * saved before the policy arrived, or restored from a backup) would fail
 * every prompt in every conversation that never picked a model. Dropping it
 * lets the next default, or the engine's own policy-checked default, apply.
 * An explicit pick is left alone: the engine's refusal is the right answer
 * to a person who chose a forbidden model.
 */
function permittedDefault(key: 'engineDefaultModel' | 'preferredModel', value: unknown, policy: ModelPolicy | null): string {
  if (typeof value !== 'string' || !value) return ''
  if (isModelAllowedByPolicy(value, policy)) return value
  _log('model-resolution', 'saved default model dropped: enterprise policy forbids it', { key, model: value })
  return ''
}

export type ModelSelection =
  | Pick<ConversationInstance, 'modelOverride' | 'modelOverrideSource' | 'modelOverrideProviderId'>
  | null
  | undefined

export type ResolvedModelSource = 'selection' | 'engine-default' | 'preferred' | 'none'

export interface AccountModelDefaults {
  engineDefaultModel: string
  preferredModel: string
}

export interface ResolvedConversationModel {
  /** The model id as the conversation holds it. Empty when nothing resolves. */
  model: string
  /**
   * What goes on the engine wire. An explicit user pick with a known provider
   * is sent fully qualified (`provider/model`), so it cannot silently run on a
   * different provider that mirrors the same bare id. Defaults are sent bare
   * on purpose: the engine's default-provider bias is intended for those.
   */
  wireModel: string | undefined
  source: ResolvedModelSource
}

/** The owner's model defaults on this server. `ownerSubject` absent means the ambient caller, then the host account. */
export function accountModelDefaults(ownerSubject?: string | null): AccountModelDefaults {
  const settings = readEffectiveSettings(ownerSubject)
  const policy = currentEnterprisePolicy()
  return {
    engineDefaultModel: permittedDefault('engineDefaultModel', settings.engineDefaultModel, policy),
    preferredModel: permittedDefault('preferredModel', settings.preferredModel, policy),
  }
}

/** Pure: no settings read, no store read. */
export function resolveConversationModel(
  selection: ModelSelection,
  harnessGoverned: boolean,
  defaults: AccountModelDefaults,
): ResolvedConversationModel {
  const override = selection?.modelOverride
  if (override) {
    const qualify =
      selection.modelOverrideSource === 'user' &&
      !!selection.modelOverrideProviderId &&
      !override.includes('/')
    return {
      model: override,
      wireModel: qualify ? `${selection.modelOverrideProviderId}/${override}` : override,
      source: 'selection',
    }
  }
  if (harnessGoverned && defaults.engineDefaultModel) {
    return { model: defaults.engineDefaultModel, wireModel: defaults.engineDefaultModel, source: 'engine-default' }
  }
  if (defaults.preferredModel) {
    return { model: defaults.preferredModel, wireModel: defaults.preferredModel, source: 'preferred' }
  }
  return { model: '', wireModel: undefined, source: 'none' }
}

/** Resolve for one conversation instance of `tab`, reading the owner's defaults. */
export function resolveModelForTab(
  tab: { engineProfileId: string | null; principalSubject?: string | null },
  selection: ModelSelection,
): ResolvedConversationModel {
  return resolveConversationModel(selection, tabHasExtensions(tab), accountModelDefaults(tab.principalSubject))
}
