import { useEffect } from 'react'
import { useUpdateStore } from '../stores/update-store'

/** Subscribe one renderer presentation to main-owned update lifecycle events. */
export function useUpdateEvents(): void {
  useEffect(() => {
    const unsubs = [
      window.ion.onUpdateDownloaded((info) => useUpdateStore.getState().setAvailable(info.version)),
      window.ion.onUpdateProgress((info) => useUpdateStore.getState().setProgress(info.percent, info.status)),
      window.ion.onUpdateStaged(() => useUpdateStore.getState().setStaged()),
      window.ion.onUpdateError((info) => useUpdateStore.getState().setError(info.message)),
    ]
    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [])
}
