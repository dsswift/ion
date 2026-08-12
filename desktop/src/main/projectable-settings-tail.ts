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

  // ═══════════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ═══════════════════════════════════════════════════════════════════
  // User/enterprise keyboard-shortcut overrides. Only non-default
  // bindings are stored. Grouped under 'advanced' because iOS has no
  // desktop-chord editing surface — the key is validated and recognized
  // and is desktop-only, so it is not projected to iOS. The allowlist entry
  // ensures `isProjectableKey` returns true
  // and `validateSettingValue` can accept/reject values, enabling
  // enterprise deployment via settings.json without crashing the
  // validator. `projectableKeysWithoutDefault()` stays green because
  // `keyboardShortcuts: {}` is in RENDERER_SETTINGS_DEFAULTS.
  // ═══════════════════════════════════════════════════════════════════
  {
    key: 'keyboardShortcuts',
    iosSurface: 'desktop-only',
    type: 'list',
    itemType: 'string',
    group: 'advanced',
    label: 'Keyboard shortcut overrides',
    description:
      'Custom keyboard bindings (command id → chord). Only non-default entries are stored. Edit via Settings → Keyboard or directly in ~/.ion/settings.json.',
    defaultValue: [],
  },
]
