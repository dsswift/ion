import { describe, it, expect } from 'vitest'
import { pendingCardOutcome, lastPendingCardTool } from '../pending-card'
import { formatClearDivider } from '../clear-divider'

describe('pending-card', () => {
  const ask = { role: 'assistant', toolName: 'AskUserQuestion', toolId: 'tu-1', toolInput: '{"question":"q?"}' }
  const exitPlan = { role: 'assistant', toolName: 'ExitPlanMode', toolId: 'tu-2', toolInput: '{"planFilePath":"/p"}' }
  const userMsg = { role: 'user', content: 'next thing' }
  const clearDivider = { role: 'system', content: formatClearDivider(new Date()) }
  const otherTool = { role: 'assistant', toolName: 'Bash', toolId: 'tu-3' }
  const assistantText = { role: 'assistant', content: 'hello' }

  it('returns found when the last tool is AskUserQuestion', () => {
    const out = pendingCardOutcome([userMsg, ask])
    expect(out).toEqual({ kind: 'found', toolName: 'AskUserQuestion', toolId: 'tu-1', toolInput: '{"question":"q?"}' })
    expect(lastPendingCardTool([userMsg, ask])?.toolName).toBe('AskUserQuestion')
  })

  it('returns found when the last tool is ExitPlanMode', () => {
    expect(lastPendingCardTool([assistantText, exitPlan])?.toolName).toBe('ExitPlanMode')
  })

  it('suppresses when a clear divider follows the pending tool', () => {
    const out = pendingCardOutcome([ask, clearDivider])
    expect(out.kind).toBe('suppressed-by-clear')
    expect(lastPendingCardTool([ask, clearDivider])).toBeNull()
  })

  it('suppresses when a user message follows the pending tool', () => {
    const out = pendingCardOutcome([ask, userMsg])
    expect(out.kind).toBe('suppressed-by-user')
    expect(lastPendingCardTool([ask, userMsg])).toBeNull()
  })

  it('returns none when the last tool is not a pending-card tool', () => {
    expect(pendingCardOutcome([ask, otherTool]).kind).toBe('none')
    expect(lastPendingCardTool([ask, otherTool])).toBeNull()
  })

  it('returns none for an empty / undefined history', () => {
    expect(pendingCardOutcome([]).kind).toBe('none')
    expect(pendingCardOutcome(undefined).kind).toBe('none')
    expect(lastPendingCardTool(null)).toBeNull()
  })

  it('returns none when there is no tool message at all', () => {
    expect(pendingCardOutcome([assistantText, assistantText]).kind).toBe('none')
  })

  it('clear divider after a user message after the tool still suppresses (clear wins, seen first)', () => {
    // history: ask → user → clear ; scanning from end hits clear first.
    expect(pendingCardOutcome([ask, userMsg, clearDivider]).kind).toBe('suppressed-by-clear')
  })

  it('ignores a clear divider that appears BEFORE the pending tool', () => {
    // A prior clear, then a fresh question after it → the question is live.
    expect(lastPendingCardTool([clearDivider, ask])?.toolName).toBe('AskUserQuestion')
  })
})
