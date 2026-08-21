import type { ProjectableSetting } from './projectable-settings-types'

export const PROJECTABLE_SETTINGS_TAIL: readonly ProjectableSetting[] = [
  // ═══════════════════════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════
  // Per-kind blocklist for the global notification tray. The desktop
  // always subscribes to every resource kind via the engine wildcard;
  // this list only hides kinds from the global tray at render time.
  // Conversation-scoped resources always appear in their conversation's
  // attachments panel and are never filtered. Empty default = show all.
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'excludedResourceKinds',
    iosSurface: 'phone',
    type: 'list',
    itemType: 'string',
    group: 'notifications',
    label: 'Hidden notification kinds',
    description:
      'Resource kinds to hide from the global notification tray (e.g. "desktop.focus"). The desktop still receives every kind; this only filters what the tray shows. Conversation-scoped resources are never affected. Empty shows all kinds.',
    defaultValue: [],
  },
]
