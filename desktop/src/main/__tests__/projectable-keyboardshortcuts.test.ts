import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { get isPackaged() { return false } } }))

import { isProjectableKey, projectableKeysWithoutDefault } from '../projectable-settings'

describe('projectable-settings keyboard shortcuts', () => {
  it('does not expose desktop-only per-view shortcut maps to iOS settings wire', () => {
    expect(isProjectableKey('keyboardShortcuts')).toBe(false)
    expect(projectableKeysWithoutDefault()).not.toContain('keyboardShortcuts')
  })
})
