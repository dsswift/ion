/**
 * Modifier-reveal logic for on-chrome shortcut hints.
 *
 * A hint appears when the modifiers the operator is holding are a non-empty
 * SUBSET of the chord's modifiers. Holding ⌘ reveals `Mod+B` and `Mod+Alt+B`
 * alike; adding ⌥ narrows the set to `Mod+Alt+B`. Holding ⌃ reveals only the
 * Ctrl-family chords.
 *
 * Subset (not equality) is deliberate. A chord family that shares a prefix
 * — Ion's `Mod` regions and `Mod+Alt` canvas tabs — must all light up on the
 * first modifier press, or the operator has to guess which second modifier
 * to add before seeing anything. Equality would hide `Mod+Alt+B` until ⌥ was
 * already down, which teaches nothing.
 *
 * Nothing here is chord-specific: the reveal trigger is derived from whatever
 * binding is live, so a rebind changes which modifiers reveal a hint without
 * any change at the call site.
 */

import { IS_MAC, type Chord } from './chord'

/** The modifier keys a reveal decision reads. Key identity is irrelevant. */
export interface HeldModifiers {
  mod: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
}

export const NO_MODIFIERS: HeldModifiers = { mod: false, ctrl: false, shift: false, alt: false }

/** True when at least one tracked modifier is held. */
export function anyModifierHeld(held: HeldModifiers): boolean {
  return held.mod || held.ctrl || held.shift || held.alt
}

/**
 * Read the platform-correct modifier set from a keyboard or mouse event.
 *
 * `Mod` is the platform command modifier: Meta on macOS, Ctrl elsewhere. On a
 * non-macOS platform a real Ctrl press therefore sets BOTH `mod` and `ctrl`,
 * which is correct — there, `Mod+X` and `Ctrl+X` are the same chord, and both
 * families should reveal together.
 */
export function readHeldModifiers(
  event: Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
): HeldModifiers {
  return {
    mod: isMac ? event.metaKey : event.ctrlKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  }
}

/**
 * True when the held modifiers should reveal this chord's hint.
 *
 * Returns false for a chord with no modifiers at all: a bare-key binding has
 * no modifier that could reveal it, so it never participates in reveal (it
 * belongs on an always-visible affordance instead).
 */
export function chordRevealed(chord: Chord | null, held: HeldModifiers, isMac = IS_MAC): boolean {
  if (!chord) return false
  if (!anyModifierHeld(held)) return false
  const chordHasModifier = chord.mod || chord.ctrl || chord.shift || chord.alt
  if (!chordHasModifier) return false

  // Off macOS, `Mod` IS Ctrl: one physical Ctrl press satisfies either token,
  // so the two collapse into a single requirement. On macOS they are distinct
  // keys and must be compared separately, or holding ⌃ would reveal every ⌘
  // chord in the window.
  if (isMac) {
    if (held.mod && !chord.mod) return false
    if (held.ctrl && !chord.ctrl) return false
  } else {
    const chordWantsPlatformCtrl = chord.mod || chord.ctrl
    if ((held.mod || held.ctrl) && !chordWantsPlatformCtrl) return false
  }

  // Every held modifier must be part of the chord. Extra chord modifiers the
  // operator has not pressed yet are fine — that is what makes a family
  // reveal together on its shared prefix.
  if (held.shift && !chord.shift) return false
  if (held.alt && !chord.alt) return false
  return true
}
