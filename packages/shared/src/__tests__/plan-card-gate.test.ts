import { describe, it, expect } from 'vitest'
import { isPlanExitDenial, shouldSuppressPlanCardForDispatch } from '../plan-card-gate'

describe('plan-card-gate — isPlanExitDenial', () => {
  it('is true for an ExitPlanMode denial', () => {
    expect(isPlanExitDenial(['ExitPlanMode'])).toBe(true)
  })

  it('is false for an AskUserQuestion denial', () => {
    expect(isPlanExitDenial(['AskUserQuestion'])).toBe(false)
  })

  it('treats a denial containing AskUserQuestion as a question card, not plan-exit', () => {
    // AskUserQuestion takes precedence (mirrors PermissionDeniedCard's
    // isPlanExit / isAskQuestion precedence): never suppress a question.
    expect(isPlanExitDenial(['ExitPlanMode', 'AskUserQuestion'])).toBe(false)
  })

  it('is false for a generic tool denial', () => {
    expect(isPlanExitDenial(['Bash'])).toBe(false)
  })
})

describe('plan-card-gate — shouldSuppressPlanCardForDispatch', () => {
  it('suppresses the Plan Ready card when a background dispatch is running', () => {
    // The reported bug: orchestrator exits plan mode while dev-lead is still
    // dispatching. The card must defer.
    expect(
      shouldSuppressPlanCardForDispatch({ toolNames: ['ExitPlanMode'], hasRunningChildren: true }),
    ).toBe(true)
  })

  it('does NOT suppress the Plan Ready card when no dispatch is running', () => {
    // Normal Plan Ready case — the card renders.
    expect(
      shouldSuppressPlanCardForDispatch({ toolNames: ['ExitPlanMode'], hasRunningChildren: false }),
    ).toBe(false)
  })

  it('does NOT suppress an AskUserQuestion card even when a dispatch is running', () => {
    // A direct question to the user is not invalidated by a background dispatch.
    expect(
      shouldSuppressPlanCardForDispatch({ toolNames: ['AskUserQuestion'], hasRunningChildren: true }),
    ).toBe(false)
  })

  it('does NOT suppress a generic permission card even when a dispatch is running', () => {
    // A live blocking tool request must still render.
    expect(
      shouldSuppressPlanCardForDispatch({ toolNames: ['Bash'], hasRunningChildren: true }),
    ).toBe(false)
  })

  it('does NOT suppress when the denial mixes ExitPlanMode with AskUserQuestion (question wins)', () => {
    expect(
      shouldSuppressPlanCardForDispatch({ toolNames: ['ExitPlanMode', 'AskUserQuestion'], hasRunningChildren: true }),
    ).toBe(false)
  })
})
