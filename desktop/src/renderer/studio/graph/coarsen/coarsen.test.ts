/**
 * Tests for coarsen.ts (child 08): below the ratio threshold nothing
 * collapses; above it, only communities at or above the member floor
 * collapse; an expanded community is excluded; the model is
 * byte-identical before and after a plan is computed.
 */
import { describe, expect, it } from 'vitest'
import { computeCoarsening, isCoarsened, COARSEN_RATIO_THRESHOLD, MIN_COARSEN_MEMBERS, syntheticClusterNodeId } from './coarsen'
import type { GraphModel, GraphNode } from '../../../../shared/graph-model-types'

function docNode(id: string, community: number): GraphNode {
  return { id, kind: 'document', label: id, frontMatter: {}, sizeBytes: 0, modifiedMs: 0, degree: 0, community, centrality: 0, orphan: false }
}

function bigCommunityModel(): GraphModel {
  const nodes: GraphNode[] = []
  for (let i = 0; i < MIN_COARSEN_MEMBERS; i++) nodes.push(docNode(`big-${i}`, 0))
  for (let i = 0; i < 3; i++) nodes.push(docNode(`small-${i}`, 1))
  return { nodes, edges: [], dangling: [], anchorSuppressions: [], discoveredFields: [], identityCollisions: [], centralityMethod: 'degree' }
}

const noPosition = (): undefined => undefined

describe('computeCoarsening', () => {
  it('below the ratio threshold, nothing collapses', () => {
    const model = bigCommunityModel()
    const visible = new Set(model.nodes.map((n) => n.id))
    const plan = computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD - 0.1, new Set(), noPosition)
    expect(plan.collapsed.size).toBe(0)
  })

  it('above the threshold, a community at or above the member floor collapses', () => {
    const model = bigCommunityModel()
    const visible = new Set(model.nodes.map((n) => n.id))
    const plan = computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD + 1, new Set(), noPosition)
    expect(plan.collapsed.has(0)).toBe(true)
    expect(plan.collapsed.get(0)?.memberIds).toHaveLength(MIN_COARSEN_MEMBERS)
  })

  it('a community below the member floor never collapses', () => {
    const model = bigCommunityModel()
    const visible = new Set(model.nodes.map((n) => n.id))
    const plan = computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD + 1, new Set(), noPosition)
    expect(plan.collapsed.has(1)).toBe(false)
  })

  it('an expanded community is excluded from the plan', () => {
    const model = bigCommunityModel()
    const visible = new Set(model.nodes.map((n) => n.id))
    const plan = computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD + 1, new Set([0]), noPosition)
    expect(plan.collapsed.has(0)).toBe(false)
  })

  it('the model is byte-identical before and after a plan is computed', () => {
    const model = bigCommunityModel()
    const before = JSON.stringify(model)
    const visible = new Set(model.nodes.map((n) => n.id))
    computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD + 1, new Set(), noPosition)
    expect(JSON.stringify(model)).toBe(before)
  })

  it('a filter reducing a community below the floor stops it from collapsing', () => {
    const model = bigCommunityModel()
    const visible = new Set(model.nodes.filter((n) => n.community !== 0).map((n) => n.id).concat(['big-0', 'big-1']))
    const plan = computeCoarsening(model, visible, COARSEN_RATIO_THRESHOLD + 1, new Set(), noPosition)
    expect(plan.collapsed.has(0)).toBe(false)
  })

  it('syntheticClusterNodeId is stable and namespaced', () => {
    expect(syntheticClusterNodeId(5)).toBe('cluster:5')
  })
})

describe('isCoarsened', () => {
  // Regression: the render effect keyed its coarsening work on the raw
  // camera ratio, so it re-ran on every camera frame — and every run
  // rebuilds the sigma graph twice over. Zooming out locked the app. The
  // camera's whole contribution is this bit, and it is constant across a
  // zoom once the threshold is crossed.
  it('is one stable value for every ratio past the threshold', () => {
    const past = [COARSEN_RATIO_THRESHOLD, 4.01, 7, 40, 4000].map(isCoarsened)
    expect(new Set(past).size).toBe(1)
    expect(past[0]).toBe(true)
  })

  it('is one stable value for every ratio inside the threshold', () => {
    const inside = [0.01, 1, 2.5, COARSEN_RATIO_THRESHOLD - 0.01].map(isCoarsened)
    expect(new Set(inside).size).toBe(1)
    expect(inside[0]).toBe(false)
  })
})
