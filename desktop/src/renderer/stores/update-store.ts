import { create } from 'zustand'

interface UpdateState {
  /** Version string of the downloaded update, or null if none available. */
  version: string | null
  /** Whether the install dialog is currently visible. */
  dialogOpen: boolean
  /** Called when electron-updater reports a downloaded update. Opens dialog automatically. */
  setAvailable: (version: string) => void
  /** Show the install dialog (e.g. from the InputBar icon click). */
  showDialog: () => void
  /** Dismiss the dialog without installing. The version stays set so the icon remains. */
  hideDialog: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  version: null,
  dialogOpen: false,
  setAvailable: (version) => set({ version, dialogOpen: true }),
  showDialog: () => set({ dialogOpen: true }),
  hideDialog: () => set({ dialogOpen: false }),
}))
