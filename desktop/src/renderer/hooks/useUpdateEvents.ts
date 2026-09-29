import { useEffect } from 'react'
import { useUpdateStore } from '@ion/server/store/update-store'
import { host } from '../host/host-instance'

/**
 * Subscribe one renderer presentation to main-owned update lifecycle events.
 * A no-op on a host without the 'updates' capability (a browser Studio
 * client, spec 18) -- there is no self-updater to subscribe to, and calling
 * these methods on BrowserStudioHost's refusal proxy throws.
 */
export function useUpdateEvents(): void {
  useEffect(() => {
    if (!host.capabilities().includes('updates')) return
    const unsubs = [
      host.shell.onUpdateDownloaded((info) => useUpdateStore.getState().setAvailable(info.version)),
      host.shell.onUpdateProgress((info) => useUpdateStore.getState().setProgress(info.percent, info.status)),
      host.shell.onUpdateStaged(() => useUpdateStore.getState().setStaged()),
      host.shell.onUpdateError((info) => useUpdateStore.getState().setError(info.message)),
    ]
    return () => unsubs.forEach((unsubscribe) => unsubscribe())
  }, [])
}
