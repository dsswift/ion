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
// Same reason: the viewport clamp reads the operator's UI zoom from the
// preferences store, which applies the theme to `document` at module load.
vi.mock('../../hooks/useViewportClamp', () => ({
  useViewportClamp: () => {},
}))

vi.mock('../../viewport-zoom', () => ({
  zoomRect: (rect: DOMRect) => ({
    ...rect,
    x: rect.x / 1.5,
    y: rect.y / 1.5,
    top: rect.top / 1.5,
    left: rect.left / 1.5,
    right: rect.right / 1.5,
    bottom: rect.bottom / 1.5,
    width: rect.width / 1.5,
    height: rect.height / 1.5,
  }),
  zoomViewport: () => ({ width: 800, height: 600 }),
}))

import { SLASH_COMMANDS, slashMenuEnterAction, slashMenuPlacement } from '../SlashCommandMenu'

describe('slashMenuPlacement', () => {
  it('anchors in zoom-adjusted fixed coordinates', () => {
    const anchor = { x: 300, y: 450, top: 450, left: 300, right: 900, bottom: 510, width: 600, height: 60, toJSON: () => ({}) } as DOMRect
    expect(slashMenuPlacement(anchor)).toMatchObject({
      bottom: 304,
      left: 212,
      right: 212,
    })
  })
})


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
