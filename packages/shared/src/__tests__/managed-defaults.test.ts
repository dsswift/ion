/**
 * Managed-default parity: the shared half.
 *
 * The fixture (repo-root `assets/managed-default-parity.json`) pins the rule
 * every client follows. The iOS half is
 * `ios/IonRemoteTests/ManagedDefaultParityTests.swift`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decideManagedDefault, sanitizeManagedDefaultWatermarks, type ManagedDefaultDecision } from '../managed-defaults'

interface DecisionCase {
  name: string
  policyValue: string | null
  locked: boolean
  applied: string | null
  decision: ManagedDefaultDecision
}
interface SequenceStep {
  policy?: { value: string; locked: boolean } | null
  userSets?: string
  preference: string
}
interface Sequence {
  name: string
  initialPreference: string
  steps: SequenceStep[]
}

const fixture = JSON.parse(
  readFileSync(join(__dirname, '../../../../assets/managed-default-parity.json'), 'utf-8'),
) as { decisions: DecisionCase[]; sequences: Sequence[] }

describe('managed default decision', () => {
  it.each(fixture.decisions)('$name', (c) => {
    expect(decideManagedDefault({ policyValue: c.policyValue, locked: c.locked, applied: c.applied })).toBe(c.decision)
  })
})

describe('managed default over time', () => {
  it.each(fixture.sequences)('$name', (sequence) => {
    let preference = sequence.initialPreference
    let applied: string | null = null
    for (const step of sequence.steps) {
      if (step.userSets !== undefined) {
        preference = step.userSets
      } else {
        const value = step.policy?.value ?? null
        if (decideManagedDefault({ policyValue: value, locked: step.policy?.locked ?? false, applied }) === 'apply' && value) {
          preference = value
          applied = value
        }
      }
      expect(preference).toBe(step.preference)
    }
  })
})

describe('sanitizeManagedDefaultWatermarks', () => {
  it('keeps string watermarks and drops everything else', () => {
    expect(sanitizeManagedDefaultWatermarks({ selectedTheme: 'acme', bad: 3, empty: '', nested: { a: 1 } })).toEqual({ selectedTheme: 'acme' })
  })

  // A watermark that cannot be read fails toward applying the administrator's value once.
  it.each([[null], [undefined], ['text'], [['selectedTheme']], [7]])('treats %j as no watermarks', (raw) => {
    expect(sanitizeManagedDefaultWatermarks(raw)).toEqual({})
  })
})
