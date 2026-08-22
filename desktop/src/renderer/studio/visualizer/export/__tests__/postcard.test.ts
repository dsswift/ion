import { describe, it, expect } from 'vitest'
import { postcardFooter } from '../postcard'

describe('postcardFooter', () => {
  it('composes agents, tasks, cost, and seed', () => {
    const perAgent = new Map([
      ['dev', { costUsd: 1, elapsedSec: 5, inputTokens: 0, outputTokens: 0, dispatches: 3 }],
      ['gfx', { costUsd: 2, elapsedSec: 5, inputTokens: 0, outputTokens: 0, dispatches: 2 }],
    ])
    expect(postcardFooter({ agentCount: 7, perAgent, conversationCostUsd: 3.456, seed: 'ion-office' }))
      .toBe('7 agents · 5 tasks · $3.46 · seed ion-office')
  })
  it('omits cost when zero', () => {
    expect(postcardFooter({ agentCount: 1, perAgent: new Map(), conversationCostUsd: 0, seed: 's' }))
      .toBe('1 agents · 0 tasks · seed s')
  })
})
