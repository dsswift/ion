import { describe, it, expect } from 'vitest'
import { permissionClearingState } from '../permission-clear'

describe('permissionClearingState truth table', () => {
  it.each(['running', 'idle', 'completed', 'done', 'failed', 'dead', 'error'])('%s clears', (s) => {
    expect(permissionClearingState(s)).toBe(true)
  })
  it.each(['connecting', 'waiting', 'compacting', '', 'anything-else'])('%s keeps the queue', (s) => {
    expect(permissionClearingState(s)).toBe(false)
  })
})
