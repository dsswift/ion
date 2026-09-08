/**
 * Filter rule evaluation: a rule is `include` (show only matches) or
 * `exclude` (hide matches), evaluated over any catalog dimension.
 *
 * An `exclude` rule with no values/bounds is INERT, not "exclude
 * everything" — an unfinished rule in the panel must never blank the
 * canvas while the operator is still building it.
 *
 * A list-valued field (a YAML `tags:` block) matches on MEMBERSHIP: the
 * rule hits when any member equals any rule value. Comparing the joined
 * array against a single value would make "show only documents tagged Y"
 * — the design's own example of an inclusionary filter — impossible for
 * every document carrying more than one tag.
 *
 * A rule's `match` decides how a member is compared: `exact` (the default)
 * is whole-value equality; `prefix` hits when the member starts with the
 * rule value, which is how "everything under `sections/staff/`" is said
 * against a path dimension whose every value is unique.
 */

import { nodeValue, edgeValue } from '../channels/dimension-values'
import { toValueList } from '../../../../shared/graph-model-resolve'
import type { GraphFilterRule } from '../../../../shared/graph-view-types'
import type { GraphEdge, GraphModel, GraphNode } from '../../../../shared/graph-model-types'

function toNumeric(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') return Number(v)
  return NaN
}

function withinBounds(n: number, min: number | undefined, max: number | undefined): boolean {
  if (Number.isNaN(n)) return false
  if (min !== undefined && n < min) return false
  if (max !== undefined && n > max) return false
  return true
}

function isInert(rule: GraphFilterRule): boolean {
  return (!rule.values || rule.values.length === 0) && rule.min === undefined && rule.max === undefined
}

/** Whether a rule's condition is satisfied by a raw value — direction-agnostic. */
function matchesCondition(value: unknown, rule: GraphFilterRule): boolean {
  if (rule.values && rule.values.length > 0) {
    // Membership, not equality: a scalar expands to a one-member list, so
    // scalar and list fields share one comparison rather than two branches.
    const members = toValueList(value)
    if (rule.match === 'prefix') return members.some((m) => rule.values!.some((v) => m.startsWith(v)))
    return members.some((m) => rule.values!.includes(m))
  }
  if (rule.min !== undefined || rule.max !== undefined) {
    return withinBounds(toNumeric(value), rule.min, rule.max)
  }
  return true
}

/** Evaluate one rule against a node, applying include/exclude direction. `model` is accepted for API symmetry with `matchesEdgeRule` (a node dimension never needs it). */
export function matchesRule(node: GraphNode, rule: GraphFilterRule, _model: GraphModel): boolean {
  // An empty rule (no values, no bounds) is INERT regardless of mode: an
  // unfinished 'exclude' in the panel must never blank the canvas while
  // the operator is still building it.
  if (isInert(rule)) return true
  const value = rule.dimension.source === 'edge' ? undefined : nodeValue(node, rule.dimension)
  const hit = matchesCondition(value, rule)
  return rule.mode === 'include' ? hit : !hit
}

/** Evaluate one rule against an edge, applying include/exclude direction. */
export function matchesEdgeRule(edge: GraphEdge, rule: GraphFilterRule, model: GraphModel): boolean {
  if (isInert(rule)) return true
  const value = rule.dimension.source === 'edge' ? edgeValue(edge, model, rule.dimension) : undefined
  const hit = matchesCondition(value, rule)
  return rule.mode === 'include' ? hit : !hit
}

/** A node passes when every rule passes — rules AND together. */
export function passesFilters(node: GraphNode, rules: GraphFilterRule[], model: GraphModel): boolean {
  return rules.every((r) => matchesRule(node, r, model))
}
