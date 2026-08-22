/**
 * controls-bus — mirror-local UI state connecting the TabStrip's Studio button
 * (which, in the Studio window, opens the window-controls popover instead of
 * launching the window) to the canvas host (VisualizerRoot), which owns the actual
 * sound/seed/theme state and actions.
 *
 * VisualizerRoot PUBLISHES its current values + action callbacks; the popover reads
 * and invokes them. Window-local by construction — never part of the
 * session-store mirror contract.
 */
import { create } from 'zustand'
import type { StudioThemeListEntry } from '../../../shared/types-studio'

export interface StudioControlsActions {
  toggleSound(): void
  applySeed(seed: string): void
  resetSeed(): void
  selectTheme(id: string): void
}

interface StudioControlsBus {
  /** Popover visibility + anchor (viewport coords of the launcher button). */
  open: boolean
  anchor: { x: number; y: number } | null
  /** Published by VisualizerRoot. */
  seed: string
  tabLabel: string
  soundOn: boolean
  themes: StudioThemeListEntry[]
  activeThemeId: string
  actions: StudioControlsActions | null
  toggle(anchor: { x: number; y: number }): void
  close(): void
  publish(patch: Partial<Pick<StudioControlsBus, 'seed' | 'tabLabel' | 'soundOn' | 'themes' | 'activeThemeId' | 'actions'>>): void
}

export const useStudioControlsBus = create<StudioControlsBus>((set, get) => ({
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
