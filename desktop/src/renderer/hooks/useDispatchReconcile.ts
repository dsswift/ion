/**
 * useDispatchReconcile — the CORRECTNESS-BACKSTOP for a displayed dispatch's
 * file-backed snapshot: a periodic refetch while the dispatch runs, plus one
 * final refetch at the running→terminal transition. The live stream is the
 * dispatch_activity push path; this only heals dropped deltas and reconnects.
 *
 * An empty `convId` disables it.
 */
import { useEffect, useRef } from 'react'
import { rDebug } from '../rendererLogger'

export const RECONCILE_INTERVAL_MS = 12000

export function useDispatchReconcile(
  convId: string,
  running: boolean,
  refetch: (convId: string) => Promise<void>,
): void {
  useEffect(() => {
    if (!convId || !running) return
    const timer = setInterval(() => {
      refetch(convId).catch((err) => rDebug('dispatch-transcript', 'reconcile refetch failed', { conversation_id: convId, error: String(err) }))
    }, RECONCILE_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [convId, running, refetch])

  // Keyed by conversation so switching from a running dispatch to a finished
  // one does not read as that finished dispatch's own transition.
  const prev = useRef({ convId: '', running: false })
  useEffect(() => {
    if (convId && prev.current.convId === convId && prev.current.running && !running) {
      refetch(convId).catch((err) => rDebug('dispatch-transcript', 'final reconcile refetch failed', { conversation_id: convId, error: String(err) }))
    }
    prev.current = { convId, running }
  }, [convId, running, refetch])
}
