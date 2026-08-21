/**
 * Live shortcut hints for on-chrome affordances.
 *
 * A button that owns a command asks this hook for the command's CURRENT chord
 * and whether the operator's held modifiers should reveal it. Nothing is
 * hardcoded at the call site: the chord is resolved from the same catalog +
 * persisted-override pipeline the dispatcher uses, so a rebind in Settings is
 * reflected the next time the hint is visible, and the modifier that reveals
 * the hint follows the new binding automatically.
 */

import { useEffect, useMemo, useState } from 'react'
import { usePreferencesStore } from '../preferences'
import { resolveViewBindings } from './shortcut-catalog'
import { formatChord, parseChord, IS_MAC } from './chord'
import { chordRevealed, readHeldModifiers, NO_MODIFIERS, type HeldModifiers } from './modifier-reveal'
import type { ShortcutView } from './shortcut-types'

/**
 * Track which modifiers are currently held, window-wide.
 *
 * Modifier state is read from every keydown/keyup rather than from a keypress
 * of the modifier itself, because a modifier released while the window is
 * blurred never produces a keyup here. `blur` and `visibilitychange` clear the
 * set for the same reason: a hint stuck visible after ⌘-Tab is worse than a
 * hint that needs one extra press.
 */
export function useHeldModifiers(enabled = true): HeldModifiers {
  const [held, setHeld] = useState<HeldModifiers>(NO_MODIFIERS)

  useEffect(() => {
    if (!enabled) return
    const sync = (event: KeyboardEvent): void => {
      const next = readHeldModifiers(event, IS_MAC)
      setHeld((previous) =>
        previous.mod === next.mod &&
        previous.ctrl === next.ctrl &&
        previous.shift === next.shift &&
        previous.alt === next.alt
          ? previous
          : next,
      )
    }
    const clear = (): void => setHeld((previous) => (previous === NO_MODIFIERS ? previous : NO_MODIFIERS))
    window.addEventListener('keydown', sync, true)
    window.addEventListener('keyup', sync, true)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', clear)
    return () => {
      window.removeEventListener('keydown', sync, true)
      window.removeEventListener('keyup', sync, true)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', clear)
    }
  }, [enabled])

  return enabled ? held : NO_MODIFIERS
}

/**
 * The persisted override map for one view.
 *
 * The optional chain is load-bearing, not defensive noise: a store shape
 * without `keyboardShortcuts` is a legitimate state (a partial store in a
 * component test, and the window between store creation and settings hydration
 * at boot). A hint is decoration, so it falls back to catalog defaults rather
 * than throwing inside a render.
 */
function useViewOverrides(view: ShortcutView): Record<string, string> {
  return usePreferencesStore((state) => state.keyboardShortcuts?.[view] ?? EMPTY_OVERRIDES)
}

const EMPTY_OVERRIDES: Record<string, string> = {}

/**
 * The display glyphs for one command's live binding, or null when the command
 * has no active binding in this view (unbound, or a conflict loser).
 */
export function useShortcutHint(view: ShortcutView, commandId: string): string | null {
  const overrides = useViewOverrides(view)
  return useMemo(() => {
    const binding = resolveViewBindings(view, overrides).activeBindings.get(commandId)
    return binding ? formatChord(binding.binding) : null
  }, [view, commandId, overrides])
}

/**
 * Resolve every requested command's binding once, then report which of them
 * the held modifiers currently reveal.
 *
 * One hook for a whole cluster of buttons keeps a single modifier listener and
 * a single catalog resolution per render, instead of one of each per button.
 */
export function useRevealedShortcuts(
  view: ShortcutView,
  commandIds: readonly string[],
  enabled = true,
): ReadonlyMap<string, string> {
  const overrides = useViewOverrides(view)
  const held = useHeldModifiers(enabled)
  const ids = commandIds.join('\u0000')

  return useMemo(() => {
    const revealed = new Map<string, string>()
    if (!enabled) return revealed
    const resolution = resolveViewBindings(view, overrides)
    for (const commandId of ids.split('\u0000')) {
      if (!commandId) continue
      const active = resolution.activeBindings.get(commandId)
      if (!active) continue
      if (!chordRevealed(parseChord(active.binding), held)) continue
      revealed.set(commandId, formatChord(active.binding))
    }
    return revealed
  }, [view, ids, overrides, held, enabled])
}
