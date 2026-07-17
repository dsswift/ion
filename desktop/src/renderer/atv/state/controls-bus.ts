/**
 * controls-bus — mirror-local UI state connecting the TabStrip's ATV button
 * (which, in the ATV window, opens the window-controls popover instead of
 * launching the window) to the canvas host (AtvApp), which owns the actual
 * sound/seed/theme state and actions.
 *
 * AtvApp PUBLISHES its current values + action callbacks; the popover reads
 * and invokes them. Window-local by construction — never part of the
 * session-store mirror contract.
 */
import { create } from 'zustand'
import type { AtvThemeListEntry } from '../../../shared/types-atv'

export interface AtvControlsActions {
  toggleSound(): void
  applySeed(seed: string): void
  resetSeed(): void
  selectTheme(id: string): void
}

interface AtvControlsBus {
  /** Popover visibility + anchor (viewport coords of the launcher button). */
  open: boolean
  anchor: { x: number; y: number } | null
  /** Published by AtvApp. */
  seed: string
  tabLabel: string
  soundOn: boolean
  themes: AtvThemeListEntry[]
  activeThemeId: string
  actions: AtvControlsActions | null
  toggle(anchor: { x: number; y: number }): void
  close(): void
  publish(patch: Partial<Pick<AtvControlsBus, 'seed' | 'tabLabel' | 'soundOn' | 'themes' | 'activeThemeId' | 'actions'>>): void
}

export const useAtvControlsBus = create<AtvControlsBus>((set, get) => ({
  open: false,
  anchor: null,
  seed: '',
  tabLabel: '',
  soundOn: false,
  themes: [],
  activeThemeId: 'ion-works',
  actions: null,
  toggle: (anchor) => set({ open: !get().open, anchor }),
  close: () => set({ open: false }),
  publish: (patch) => set(patch),
}))
