import type {
  AutomationDefinition,
  AutomationLayers,
  AutomationListing,
  AutomationSource,
  AutomationSourceEntry,
  EffectiveAutomations,
} from './types'

const DEFAULT_HISTORY_ENTRIES = 500

/** Highest-precedence layer first: the first layer that owns an id, wins it. */
const PRECEDENCE: readonly AutomationSource[] = ['enterprise', 'project', 'user', 'built-in']

interface ResolvedAutomations {
  effective: EffectiveAutomations
  listing: AutomationListing
}

/**
 * Resolve automation layers once, producing both the effective set the runtime
 * evaluates and the source-aware listing Settings renders. A single precedence
 * algorithm serves both so the two views can never disagree about who wins an id.
 *
 * Precedence is enterprise > project > user > built-in. Enterprise `disabledIds`
 * removes an id entirely; the project disable ledger only suppresses the
 * project-layer definition, so a lower layer with the same id becomes effective
 * again rather than vanishing.
 */
export function resolveAutomations(layers: AutomationLayers): ResolvedAutomations {
  const layerDefs: { source: AutomationSource; defs: readonly AutomationDefinition[] | undefined }[] = [
    { source: 'built-in', defs: layers.builtIn },
    { source: 'user', defs: layers.user },
    { source: 'project', defs: layers.project },
    { source: 'enterprise', defs: layers.enterprise?.definitions },
  ]
  const projectDisabled = new Set(layers.projectDisabledIds ?? [])
  const enterpriseDisabled = new Set(layers.enterprise?.disabledIds ?? [])

  // Every source that defines an id, keyed by source so precedence can pick a winner.
  const byId = new Map<string, Map<AutomationSource, AutomationDefinition>>()
  for (const { source, defs } of layerDefs)
    for (const definition of defs ?? []) {
      const sources = byId.get(definition.id) ?? new Map<AutomationSource, AutomationDefinition>()
      sources.set(source, cloneDefinition(definition))
      byId.set(definition.id, sources)
    }

  const winnerFor = (id: string): AutomationSource | null => {
    if (enterpriseDisabled.has(id)) return null
    const sources = byId.get(id)
    if (!sources) return null
    for (const source of PRECEDENCE) {
      if (!sources.has(source)) continue
      if (source === 'project' && projectDisabled.has(id)) continue
      return source
    }
    return null
  }

  const entries: AutomationSourceEntry[] = []
  for (const { source, defs } of layerDefs)
    for (const definition of defs ?? []) {
      const winner = winnerFor(definition.id)
      const entry: AutomationSourceEntry = {
        definition: cloneDefinition(definition),
        source,
        effective: winner === source,
      }
      if (source === 'project') entry.locallyDisabled = projectDisabled.has(definition.id)
      if (winner !== source && winner) entry.overriddenBy = winner
      entries.push(entry)
    }

  const definitions: AutomationDefinition[] = []
  for (const [id, sources] of byId) {
    const winner = winnerFor(id)
    if (winner) definitions.push(cloneDefinition(sources.get(winner) as AutomationDefinition))
  }

  const locked = layers.enterprise?.locked === true
  return {
    effective: {
      definitions,
      locked,
      maxHistoryEntries: normalizeHistoryLimit(layers.enterprise?.maxHistoryEntries),
    },
    listing: { entries, locked },
  }
}

/**
 * Resolve automation layers by stable identifier for the runtime. Retained as
 * the effective-only entry point; it delegates to {@link resolveAutomations} so
 * there is one precedence algorithm.
 */
export function mergeAutomationLayers(layers: AutomationLayers): EffectiveAutomations {
  return resolveAutomations(layers).effective
}

/** Source-aware layer resolution for Settings. Same precedence pass as the runtime. */
export function listAutomationLayers(layers: AutomationLayers): AutomationListing {
  return resolveAutomations(layers).listing
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
