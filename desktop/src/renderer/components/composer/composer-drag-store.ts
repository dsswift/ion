/**
 * Whether a file drag is currently over the window. Written by the composer's
 * intake hook, read by the shell that draws the composer's border, so the
 * border can show where a drop will land.
 */
import { create } from 'zustand'

export const useComposerDragStore = create<{ dragging: boolean; set: (dragging: boolean) => void }>((set) => ({
  dragging: false,
  set: (dragging) => set({ dragging }),
}))
