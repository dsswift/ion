// ─── Resource subsystem and notification types ───

/**
 * Types for the engine's generic resource subsystem (durable structured
 * content published by extensions) and its notification companion.
 *
 * Split out of types-engine.ts at the subsystem boundary to keep that file
 * under the 600-line cap. These types are cohesive and independent: nothing
 * here references the session/conversation runtime types in the parent module,
 * which is what makes this the natural seam.
 *
 * Re-exported from types-engine.ts (and therefore from the shared/types
 * barrel), so every existing import path keeps working unchanged.
 *
 * Subsystem reference: root AGENTS.md § "Resource subsystem".
 */

export interface ResourceItem {
  id: string
  kind: string
  title?: string
  content: string
  createdAt: string
  conversationId?: string
  metadata?: Record<string, unknown>
  updatedAt?: string
  read?: boolean
}

export interface ResourceDelta {
  op: 'create' | 'update' | 'delete' | 'mark_read'
  item: ResourceItem
}

export interface ResourceFilter {
  kind: string
  conversationId?: string
  since?: string
  limit?: number
}

export interface NotifyOpts {
  kind: string
  resourceId?: string
  title: string
  body: string
  sound?: string
  scope?: 'user' | 'device' | 'all'
  conversationId?: string
  targetSessionKey?: string
}
