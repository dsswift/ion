import { create } from 'zustand'

interface UpdateState {
  /** Version string of the downloaded update, or null if none available. */
  version: string | null
  /** Whether the install dialog is currently visible. */
  dialogOpen: boolean
  /** The current download percentage, when a download is active. */
  progress: number | null
  /** A detached worker has prepared the bundle swap. */
  staged: boolean
  /** User-visible failure from the update mechanism. */
  error: string | null
  setAvailable: (version: string) => void
  setProgress: (percent: number, status: string) => void
  setStaged: () => void
  setError: (message: string) => void
  showDialog: () => void
  hideDialog: () => void
}

export const useUpdateStore = create<UpdateState>((set) => ({
  version: null,
  dialogOpen: false,
  progress: null,
  staged: false,
  error: null,
  setAvailable: (version) => set({ version, dialogOpen: true, progress: null, staged: false, error: null }),
  setProgress: (percent, status) => set({
    progress: status === 'downloading' ? percent : null,
    ...(status === 'not_available' ? { version: null, dialogOpen: false, staged: false, error: null } : {}),
  }),
  setStaged: () => set({ staged: true, dialogOpen: true, error: null }),
  setError: (message) => set({ error: message, dialogOpen: true, staged: false }),
  showDialog: () => set({ dialogOpen: true }),
  hideDialog: () => set({ dialogOpen: false }),
}))
