/**
 * Tests for the SLASH_COMMANDS hardcoded set.
 *
 * The desktop hardcodes its built-in slash command names because the
 * engine's engine_command_registry snapshot does not yet publish
 * built-ins (only extension-registered commands). When that changes
 * (a future engine commit), this hardcode can be removed in favour of
 * consuming the registry snapshot — and these tests come along to pin
 * the migration.
 */

import { vi, describe, it, expect } from 'vitest'

// SlashCommandMenu transitively imports renderer/theme which reads
// localStorage at module load. The node test environment doesn't
// provide localStorage; stub the leaf modules so the import chain
// short-circuits at the renderer-only modules and never touches DOM
// globals.
vi.mock('../../theme', () => ({
  useColors: () => ({}),
}))
vi.mock('../PopoverLayer', () => ({
  usePopoverLayer: () => null,
}))
vi.mock('../../../shared/fuzzy-match', () => ({
  fuzzyFilterAndSort: (_: string, items: unknown[]) => items,
}))

import { SLASH_COMMANDS, slashMenuEnterAction } from '../SlashCommandMenu'

describe('SLASH_COMMANDS', () => {
  it('includes the three engine built-ins', () => {
    const names = SLASH_COMMANDS.map((c) => c.command).sort()
    expect(names).toEqual(['/clear', '/compact', '/export'])
  })

  it('marks every built-in with group="builtin"', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.group).toBe('builtin')
    }
  })

  it('every built-in has a non-empty description', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.description.length).toBeGreaterThan(0)
    }
  })
})

describe('slashMenuEnterAction', () => {
  it('completes from the menu when there is at least one match', () => {
    expect(slashMenuEnterAction(1)).toBe('complete')
    expect(slashMenuEnterAction(5)).toBe('complete')
  })

  it('sends (does not swallow Enter) when the typed command matches nothing', () => {
    // Regression: an unknown/typed slash command (no fuzzy matches) must remain
    // sendable. The menu must NOT swallow Enter — it closes and submits so the
    // pipeline forwards to the engine (resolveSlash) → resolves or "Unknown
    // command". Returning 'send' for a zero-match filter is what fixes the
    // "refuses to send" regression.
    expect(slashMenuEnterAction(0)).toBe('send')
  })
})
