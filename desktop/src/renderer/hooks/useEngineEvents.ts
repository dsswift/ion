import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * Listens for engine events from the main process and routes them to the store.
 * Should be mounted once at the app root level.
 */
export function useEngineEvents(): void {
  const handleEngineEvent = useSessionStore((s) => s.handleEngineEvent)

  useEffect(() => {
    const cleanup = window.ion.onEngineEvent((key, event) => {
      handleEngineEvent(key, event)
    })
    return cleanup
  }, [handleEngineEvent])
}
