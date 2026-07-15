import { describe, it, expect } from 'vitest'
import { generateOffice } from '../index'
import { deriveRoster } from '../roster'
import { department, rootAgent, testTheme } from './gen-helpers'
import type { AgentStateUpdate } from '../../../../shared/types'

/**
 * Property-style invariant sweep: across many seeds and roster shapes, every
 * generated office must keep every door, seat, and rest tile BFS-reachable
 * from the corridor, inside the 64x64 grid cap.
 */
describe('generator reachability invariants', () => {
  const shapes: Array<{ label: string; agents: AgentStateUpdate[] }> = [
    { label: 'empty', agents: [] },
    { label: 'one solo', agents: [rootAgent('scout')] },
    { label: 'one small department', agents: department('dev-lead', ['a-dev', 'b-dev']) },
    {
      label: 'two departments + solo',
      agents: [
        ...department('dev-lead', ['backend-dev', 'frontend-dev', 'qa-analyst']),
        ...department('docs-lead', ['writer', 'editor']),
        rootAgent('scout'),
      ],
    },
    {
      label: 'large org',
      agents: [
        ...department('dev-lead', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']),
        ...department('ops-lead', ['b1', 'b2', 'b3', 'b4', 'b5']),
        ...department('docs-lead', ['c1', 'c2']),
        rootAgent('s1'),
        rootAgent('s2'),
        rootAgent('s3'),
        rootAgent('s4'),
      ],
    },
  ]

  for (const shape of shapes) {
    it(`${shape.label}: valid across 10 seeds`, () => {
      const roster = deriveRoster(shape.agents)
      for (let i = 0; i < 10; i++) {
        const result = generateOffice(`seed-${i}`, roster, testTheme())
        expect(result.errors, `seed-${i} (${shape.label})`).toEqual([])
        expect(result.layout.width).toBeLessThanOrEqual(64)
        expect(result.layout.height).toBeLessThanOrEqual(64)
        expect(result.droppedRooms, `seed-${i} dropped`).toEqual([])
      }
    })
  }

  it('orientation flag: horizontal (default) reads landscape, vertical reads portrait', () => {
    const agents = [
      ...department('dev-lead', ['a1', 'a2', 'a3', 'a4']),
      ...department('ops-lead', ['b1', 'b2', 'b3']),
      ...department('docs-lead', ['c1', 'c2']),
      rootAgent('s1'),
      rootAgent('s2'),
    ]
    const roster = deriveRoster(agents)
    for (let i = 0; i < 6; i++) {
      const horizontal = generateOffice(`orient-${i}`, roster, testTheme())
      expect(horizontal.errors).toEqual([])
      expect(horizontal.layout.width, `horizontal seed ${i}`).toBeGreaterThanOrEqual(horizontal.layout.height)
      const vertical = generateOffice(`orient-${i}`, roster, testTheme(), { orientation: 'vertical' })
      expect(vertical.errors).toEqual([])
      // Portrait preference: multi-spine stacking makes it at least as tall as wide-ish.
      expect(vertical.layout.height, `vertical seed ${i}`).toBeGreaterThanOrEqual(vertical.layout.width * 0.8)
    }
  })

  it('every roster agent that fits gets a seat', () => {
    const agents = [
      ...department('dev-lead', ['backend-dev', 'frontend-dev']),
      rootAgent('scout'),
    ]
    const roster = deriveRoster(agents)
    const result = generateOffice('seats', roster, testTheme())
    const seated = result.layout.seats.filter((s) => s.agent != null).map((s) => s.agent)
    expect(seated.sort()).toEqual(['backend-dev', 'dev-lead', 'frontend-dev', 'scout'])
    // Manager seat exists and stays synthetic (no roster agent assigned).
    const manager = result.layout.seats.find((s) => s.kind === 'manager')
    expect(manager).toBeDefined()
    expect(manager?.agent).toBeNull()
    // Break room offers rest tiles for done-agents.
    expect(result.layout.restTiles.length).toBeGreaterThan(0)
  })
})
