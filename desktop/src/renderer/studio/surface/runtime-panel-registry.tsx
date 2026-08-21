import { useCallback, useSyncExternalStore } from 'react'
import type React from 'react'

export interface RuntimePanelEntry {
  title: string
  body: React.ReactNode
  /** User-driven tab close callback, owned by the legacy panel parent. */
  close(): void
}

const entries = new Map<string, RuntimePanelEntry>()
const listeners = new Map<string, Set<() => void>>()
let sequence = 0

function notify(id: string): void {
  for (const listener of listeners.get(id) ?? []) listener()
}

export function registerRuntimePanel(entry: RuntimePanelEntry): string {
  const id = `panel:${++sequence}`
  entries.set(id, entry)
  notify(id)
  return id
}

/** Publish a fresh React tree from a routed legacy panel. */
export function updateRuntimePanel(id: string, patch: Pick<RuntimePanelEntry, 'title' | 'body'>): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  entries.set(id, { ...entry, ...patch })
  notify(id)
  return true
}

export function runtimePanel(id: string): RuntimePanelEntry | null {
  return entries.get(id) ?? null
}

export function subscribeRuntimePanel(id: string, listener: () => void): () => void {
  const subscribers = listeners.get(id) ?? new Set<() => void>()
  subscribers.add(listener)
  listeners.set(id, subscribers)
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0) listeners.delete(id)
  }
}

/** Remove an entry after its owner unmounts. Does not call `entry.close()`. */
export function unregisterRuntimePanel(id: string): void {
  if (!entries.delete(id)) return
  notify(id)
}

/** Live surface body. Registry updates re-render this component in place. */
export function RuntimePanelBody({ id }: { id: string }): React.JSX.Element {
  const subscribe = useCallback(
    (listener: () => void) => subscribeRuntimePanel(id, listener),
    [id],
  )
  const getSnapshot = useCallback(() => runtimePanel(id), [id])
  const entry = useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => null,
  )
  if (!entry) {
    return <div data-testid="runtime-panel-missing" style={{ flex: 1 }}>Panel closed</div>
  }
  return <>{entry.body}</>
}
