import type { AutomationDefinition, AutomationLayers, EffectiveAutomations } from './types'

const DEFAULT_HISTORY_ENTRIES = 500

/**
 * Resolve automation layers by stable identifier. Higher layers replace lower
 * definitions with the same identifier, then enterprise can remove identifiers.
 * This keeps enterprise policy authoritative without mutating user persistence.
 */
export function mergeAutomationLayers(layers: AutomationLayers): EffectiveAutomations {
  const definitions = new Map<string, AutomationDefinition>()
  apply(definitions, layers.builtIn)
  apply(definitions, layers.user)
  apply(definitions, layers.project)
  for (const id of layers.projectDisabledIds ?? []) definitions.delete(id)
  apply(definitions, layers.enterprise?.definitions)
  for (const id of layers.enterprise?.disabledIds ?? []) definitions.delete(id)

  return {
    definitions: [...definitions.values()],
    locked: layers.enterprise?.locked === true,
    maxHistoryEntries: normalizeHistoryLimit(layers.enterprise?.maxHistoryEntries),
  }
}

function apply(target: Map<string, AutomationDefinition>, definitions: readonly AutomationDefinition[] | undefined): void {
  for (const definition of definitions ?? []) target.set(definition.id, cloneDefinition(definition))
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_ENTRIES
  if (!Number.isInteger(value) || value < 0) return DEFAULT_HISTORY_ENTRIES
  return value
}

export function cloneDefinition(definition: AutomationDefinition): AutomationDefinition {
  return {
    ...definition,
    trigger: { ...definition.trigger },
    condition: definition.condition ? JSON.parse(JSON.stringify(definition.condition)) : undefined,
    steps: (definition.steps ?? definition.actions ?? []).map((step) => cloneStep(step)),
    actions: undefined,
  }
}

function cloneStep(step: import('./types').AutomationStep): import('./types').AutomationStep {
  if ('type' in step) return { ...step, condition: JSON.parse(JSON.stringify(step.condition)), then: step.then.map(cloneStep), else: step.else?.map(cloneStep) }
  return { ...step, payload: clonePayload(step.payload) }
}

function clonePayload(payload: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  // Payloads are explicitly JSON-safe, so serialization gives callers a fully
  // independent value without preserving mutable nested references.
  return payload ? JSON.parse(JSON.stringify(payload)) as Record<string, unknown> : undefined
}
