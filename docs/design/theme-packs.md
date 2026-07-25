---
title: Theme Packs
description: Authoring, installing, and syncing custom color themes across desktop and iOS.
---

# Theme Packs

Ion themes are distributed as **theme packs** — directories containing a `theme.json` manifest and optional image assets. A pack carries up to two components:

| Component | Consumed by | Contents |
|-----------|-------------|----------|
| `desktop` | Desktop overlay + ATV windows | A partial ColorPalette token overlay on a built-in base theme, optional forced color scheme, optional assets |
| `ios` | iOS companion app | The full iOS AppTheme token set, optional preferred color scheme, optional assets |

A pack may include either component or both. Only the `ios` component (plus its assets) ever ships to iOS over the desktop↔iOS wire — the desktop component never leaves the desktop.

## Built-in themes

Four themes are compiled into both clients and never ride the wire: `ion-dark`, `ion-light`, `ion-classic`, and `jarvis-hud`. Ion Dark, Ion Light, and Ion Classic are pixel-identical across desktop and iOS, pinned by the parity fixture (`assets/theme-parity.json`) that both test suites assert against. Jarvis HUD is one theme with two deliberately different platform parts: the desktop renders the HUD palette (`palette-hud.ts`) while iOS renders the Arc Reactor treatment (animated ring background, scan-line activity indicator). These four ids are **reserved** — a pack claiming one is refused at load.

Theme selection is **per device**: the desktop's theme is the `selectedTheme` setting, the iOS theme is the phone's local Appearance preference. Selections are never force-synced (see [Enterprise enforcement](#enterprise-enforcement) for the exception).

## Install locations

| Root | Scope | Precedence |
|------|-------|------------|
| `~/.ion/themes/<pack-id>/` | Per-user | Shadowed by system on id collision |
| `/Library/Application Support/Ion/themes/<pack-id>/` (macOS) | Machine (MDM drop target) | Wins on id collision |

On Windows the system root is `%PROGRAMDATA%\Ion\themes`; on Linux, `/etc/ion/themes`. The directory name must equal the manifest `id` and match `^[a-z0-9][a-z0-9-]{0,63}$`. Packs are discovered at app start, re-scanned on every iOS sync, and watched live (a pack dropped while the app runs applies without a restart).

## Manifest format

`<root>/<pack-id>/theme.json`:

```jsonc
{
  "id": "acme-corp",              // must equal the directory name
  "name": "Acme Corp",
  "version": "1.0.0",
  "desktop": {
    "base": "ion-dark",           // built-in id; unspecified tokens inherit from it
    "forcedColorScheme": "dark",  // optional; defaults to the base theme's scheme
    "tokens": {                    // Partial ColorPalette overlay (any subset)
      "accent": "#FF6600",
      "containerBg": "#101013"
    },
    "assets": {                    // optional image assets
      "background": "assets/bg.png",
      "logo": "assets/logo.png"
    }
  },
  "ios": {
    "preferredColorScheme": "dark",  // optional; omitted = follow the system
    "tokens": {                       // ALL 15 AppTheme tokens required, #RRGGBB or #RRGGBBAA
      "accent": "#FF6600FF",
      "accentSubtle": "#FF66001F",
      "accentGlow": "#FF66002E",
      "background": "#0A0A0CFF",
      "textPrimary": "#F5F5F5FF",
      "textSecondary": "#B9B9C0FF",
      "statusRunning": "#FF6600FF",
      "statusDone": "#34D399FF",
      "statusError": "#F87171FF",
      "statusPending": "#818188FF",
      "statusWaitingChildren": "#FBBF24FF",
      "statusWarning": "#F59E0BFF",
      "surfaceElevated": "#1E1E23FF",
      "codeBg": "#0E0E11FF",
      "userBubbleTint": "#1E1E23FF"
    },
    "assets": {
      "background": "assets/bg-ios.png",
      "logo": "assets/logo.png"
    }
  }
}
```

Validation rules (shared module `desktop/src/shared/theme-pack-types.ts`):

- The desktop token overlay is **partial** — unknown keys are dropped with a logged warning, everything unspecified inherits from `base`.
- The iOS token set is **all-or-nothing** — a partial or invalid-hex set rejects the iOS component (the desktop component still loads). A partial iOS theme would render unreadable mixes of pack and fallback colors.
- Assets: PNG/JPEG/WebP, ≤ 3 MB each, and must resolve inside the pack directory (traversal and symlink escapes are refused). `background` renders as a full-surface backdrop; `logo` is a brand mark shown in the Settings appearance surface on both platforms.
- Native effect renderers (Arc Reactor rings etc.) are reserved for built-ins; custom packs style with tokens and images.

## iOS sync

The iOS components of installed packs sync automatically:

- On **first pairing** and **every reconnect**, the desktop ships `desktop_theme_manifest` — the full set of iOS components (tokens inline, assets as `{slot, sha256, size}` descriptors). Snapshot semantics, keyed per desktop: iOS replaces its cached set for that desktop wholesale and prunes uninstalled themes; themes synced from other paired desktops are untouched.
- Assets are fetched lazily (`desktop_request_theme_asset` → `desktop_theme_asset_content`) when a descriptor's sha256 misses the phone's cache, then cached on disk.
- When the pack set changes on disk while connected, the desktop re-broadcasts the manifest immediately.
- Synced themes persist on the phone (Documents), so a selected custom theme keeps working offline.

## Enterprise enforcement

Enterprise theme policy rides the engine's MDM-sealed enterprise config under the desktop-owned namespace:

```json
{
  "enterprise": {
    "customFields": {
      "ion-desktop": {
        "themePolicy": { "themeId": "acme-corp", "locked": true }
      }
    }
  }
}
```

- `themeId` alone (`locked` absent/false): **managed default** — applied when the user has never picked a theme; the user may change it afterwards.
- `locked: true`: **enforced** — the theme always renders and the picker is disabled, on the desktop **and** on every paired iOS device (projected via `desktop_settings_snapshot.themePolicy`). The user's own saved selection is preserved and resumes when the policy lifts. Enforcement persists on iOS across offline relaunches.

A typical enterprise deployment pairs the two mechanisms: the MDM installs the branded pack into the machine-scope themes root and sets `themePolicy` in the managed enterprise config. See [docs/enterprise/mdm.md](../enterprise/mdm.md) for the managed-config delivery paths. The engine passes `customFields['ion-desktop']` through opaquely — no engine configuration is involved beyond the sealed config file itself.

## Cross-platform parity testing

`assets/theme-parity.json` pins the shared built-ins: each iOS token's hex value plus the desktop palette token it derives from. `desktop/src/renderer/theme/theme-parity.test.ts` asserts the fixture against the TS palettes; `ios/IonRemoteTests/ThemeParityTests.swift` asserts it against the Swift theme structs. A palette edit on either side fails that side's build until the fixture (and the other side) move in the same change.
