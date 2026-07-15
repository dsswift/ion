/**
 * Cross-platform grouping parity — desktop consumer.
 *
 * Runs the shared fixture (src/shared/__tests__/fixtures/grouping-parity.json)
 * through groupMessages in CLASSIC mode and asserts the neutral-vocabulary
 * shape. The iOS consumer (GroupingParityTests.swift) runs the SAME fixture
 * through ToolGrouping's groupConversationItems — if either platform's
 * grouping drifts, its consumer test fails. Same anchor pattern as the engine
 * contract manifest.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { groupMessages } from '../tool-helpers'
import type { Message } from '../../../../shared/types'

interface FixtureCase {
  name: string
  messages: Message[]
  expected: string[]
}

const fixture: { cases: FixtureCase[] } = JSON.parse(
  readFileSync(join(__dirname, '../../../../shared/__tests__/fixtures/grouping-parity.json'), 'utf-8'),
)

/** Map desktop GroupedItem kinds onto the fixture's neutral vocabulary. */
function neutralShape(messages: Message[]): string[] {
  return groupMessages(messages, { includeUser: true }).map((g: any) => {
    switch (g.kind) {
      case 'tool-group': return `toolGroup(${g.messages.length})`
      case 'user': return 'user'
      case 'assistant': return 'assistant'
      case 'thinking': return 'thinking'
      case 'compaction': return 'compaction'
      case 'system': return 'system'
      default: return g.kind
    }
  })
}

describe('grouping parity fixture (desktop consumer)', () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      expect(neutralShape(c.messages)).toEqual(c.expected)
    })
  }
})
