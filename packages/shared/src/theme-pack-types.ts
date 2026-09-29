/**
 * Theme-pack types + pure manifest validator.
 *
 * A theme pack is a directory `<root>/<pack-id>/` containing a `theme.json`
 * manifest and optional image assets. Packs carry up to two components:
 *
 *   - `desktop` — a partial ColorPalette overlay on a built-in base theme,
 *     rendered by the desktop overlay/Studio windows.
 *   - `ios`     — the iOS AppTheme token set. A component supplying the
 *     complete required set loads with no `base`; one omitting any required
 *     token names a built-in `base` from which the rest inherit on iOS. Only
 *     this component (plus its assets) ships to iOS over the desktop↔iOS wire.
 *
 * Shared module (no fs, no DOM): imported by the main-process loader
 * (`main/theme-packs.ts`), the renderer registry (`renderer/theme-tokens.ts`
 * consumers), and tests. Validation is pure so every surface exercises the
 * same rules.
 */

/** Built-in theme ids. Reserved: a pack claiming one of these is refused so
 * an installed pack can never silently redefine a stock theme and break the
 * identical-across-platforms guarantee. */
export const BUILTIN_THEME_IDS = ['ion-dark', 'ion-light', 'ion-classic', 'jarvis-hud', 'ion-contrast-dark', 'ion-contrast-light'] as const

/** Pack ids match the Studio window pack-id convention: lowercase alphanumeric + dashes,
 * 1–64 chars, and must equal the directory name. */
export const THEME_PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The shared code-syntax tokens (Ion Dark/Light/Classic values are pinned
 * identical to the desktop palettes by the parity fixture). These are
 * spread into `IOS_THEME_TOKEN_KEYS` below, and separately used to build
 * `OPTIONAL_IOS_THEME_TOKEN_KEYS` — one literal array, two derived views, so
 * the two can never drift apart.
 */
const CODE_SYNTAX_TOKEN_KEYS = [
  'codeKeyword', 'codeString', 'codeNumber', 'codeComment',
  'codeFunction', 'codeType', 'codeVariable', 'codeOperator',
] as const

/**
 * The iOS AppTheme color-token contract. Mirrors the `AppTheme` protocol in
 * `ios/IonRemote/Utilities/AppTheme.swift` — a pack's iOS component must
 * supply every required key or its iOS part is rejected (the desktop part
 * still loads). Keep in lockstep with the Swift protocol.
 */
export const IOS_THEME_TOKEN_KEYS = [
  'accent',
  'accentSubtle',
  'accentGlow',
  'background',
  'textPrimary',
  'textSecondary',
  'statusRunning',
  'statusDone',
  'statusError',
  'statusPending',
  'statusWaitingChildren',
  'statusBash',
  'statusWarning',
  'statusIdle',
  'worktreeDirty',
  'surfaceElevated',
  'surfaceSecondary',
  'surfaceSunken',
  'borderSubtle',
  'textTertiary',
  'codeBg',
  'userBubbleTint',
  ...CODE_SYNTAX_TOKEN_KEYS,
] as const

export type IosThemeTokenKey = (typeof IOS_THEME_TOKEN_KEYS)[number]

/**
 * Unlike the core `IOS_THEME_TOKEN_KEYS` set, the code-syntax tokens are
 * **optional** on a pack's iOS component: `AppTheme.swift`'s
 * protocol-extension defaults and `SyncedTheme`'s per-token fallback already
 * render a readable derived color when one is absent, so a pack authored
 * before these tokens existed keeps working instead of having its whole iOS
 * component rejected.
 */
export const OPTIONAL_IOS_THEME_TOKEN_KEYS: ReadonlySet<IosThemeTokenKey> = new Set(CODE_SYNTAX_TOKEN_KEYS)

/**
 * The frozen REQUIRED iOS token set: every `IOS_THEME_TOKEN_KEYS` entry that
 * is not in `OPTIONAL_IOS_THEME_TOKEN_KEYS`. A pack's iOS component must
 * supply every one of these OR name a built-in `base` from which the omitted
 * ones inherit (`required-when-partial`). Derived from the two literal
 * arrays so it can never drift from either — this is the single source of
 * truth for "what a complete-but-baseless iOS component must contain".
 */
export const REQUIRED_IOS_THEME_TOKEN_KEYS: readonly IosThemeTokenKey[] =
  IOS_THEME_TOKEN_KEYS.filter((k) => !OPTIONAL_IOS_THEME_TOKEN_KEYS.has(k))

/** The two asset slots a component may declare. `background` renders as a
 * full-surface backdrop; `logo` is a brand mark shown in the Settings
 * appearance surface on both platforms. */
export type ThemeAssetSlot = 'background' | 'logo'

/** Relative asset paths (inside the pack directory) per slot. */
export interface ThemePackAssetRefs {
  background?: string
  logo?: string
}

export interface ThemePackDesktopComponent {
  /** Built-in theme id whose palette fills every token the pack omits. */
  base: (typeof BUILTIN_THEME_IDS)[number]
  forcedColorScheme?: 'light' | 'dark'
  /** Partial ColorPalette overlay. Unknown keys are dropped (warned), not fatal. */
  tokens: Record<string, string>
  assets?: ThemePackAssetRefs
}

export interface ThemePackIosComponent {
  /**
   * Built-in theme id whose iOS token values fill every REQUIRED token this
   * component omits (`required-when-partial`). REQUIRED-when-partial, not
   * always: a component supplying the complete `REQUIRED_IOS_THEME_TOKEN_KEYS`
   * set needs no base and this field stays undefined. A component omitting any
   * required token MUST name a base — nothing is ever inferred. Inheritance is
   * resolved on iOS (`SyncedTheme`), where the authoritative built-in token
   * values are compiled in; the desktop only validates and carries the name.
   */
  base?: (typeof BUILTIN_THEME_IDS)[number]
  /** Omitted = follow the system light/dark setting. */
  preferredColorScheme?: 'light' | 'dark'
  /** Full iOS token set — every IOS_THEME_TOKEN_KEYS entry, #RGB/#RRGGBB/#RRGGBBAA. */
  tokens: Record<string, string>
  assets?: ThemePackAssetRefs
}

export interface ThemePackManifest {
  id: string
  name: string
  version: string
  desktop?: ThemePackDesktopComponent
  ios?: ThemePackIosComponent
}

/** One validated asset belonging to a loaded pack (main-process shape). */
export interface LoadedThemeAsset {
  slot: ThemeAssetSlot
  relPath: string
  sha256: string
  size: number
  mime: string
}

/** A pack after discovery + validation, as held by the main-process loader. */
export interface LoadedThemePack {
  manifest: ThemePackManifest
  /** 'system' packs (machine-scope MDM drops) shadow 'user' packs on id collision. */
  source: 'user' | 'system'
  desktopAssets: LoadedThemeAsset[]
  iosAssets: LoadedThemeAsset[]
  /** Validation diagnostics retained for author-facing Settings feedback. */
  diagnostics: ThemePackDiagnostic[]
}

/**
 * IPC payload shape for one custom theme as the renderer consumes it: the
 * desktop component with its base reference plus inline asset data URLs
 * (assets are capped at 3 MB, so inlining over IPC is safe).
 */
export interface CustomThemeForRenderer {
  id: string
  name: string
  version: string
  /** Omitted when validation rejected the desktop component. */
  base?: (typeof BUILTIN_THEME_IDS)[number]
  /** False for diagnostic-only entries with no usable desktop component. */
  desktopAvailable?: boolean
  forcedColorScheme?: 'light' | 'dark'
  tokens: Record<string, string>
  backgroundDataUrl?: string
  logoDataUrl?: string
  /** iOS validation diagnostics surfaced at this pack's Settings row. */
  iosDiagnostics?: ThemePackDiagnostic[]
  /** Desktop validation diagnostics surfaced at this pack's Settings row. */
  desktopDiagnostics?: ThemePackDiagnostic[]
}

// ─── Validation ───

const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

/** Desktop token values are CSS values (hex, rgba(), shadow lists,
 * 'transparent'). We accept any short string that cannot break out of a
 * CSS-variable declaration or smuggle a fetch. */
function isSafeCssValue(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > 256) return false
  if (/[;{}]/.test(v)) return false
  if (/url\s*\(/i.test(v)) return false
  return true
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function validateAssetRefs(
  raw: unknown,
  diagnostics: ThemePackDiagnostic[],
  surface: ThemePackDiagnostic['surface'],
  label: string,
): ThemePackAssetRefs | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    diagnostics.push({ surface, message: `${label}.assets is not an object; ignored`, fatal: false })
    return undefined
  }
  const out: ThemePackAssetRefs = {}
  for (const slot of ['background', 'logo'] as const) {
    const rel = raw[slot]
    if (rel === undefined) continue
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512 || rel.includes('\0')) {
      diagnostics.push({ surface, message: `${label}.assets.${slot} is not a usable path; dropped`, fatal: false })
      continue
    }
    out[slot] = rel
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface ThemePackDiagnostic {
  surface: 'ios' | 'desktop' | 'pack'
  message: string
  fatal: boolean
}

export interface ThemePackValidationResult {
  ok: boolean
  pack?: ThemePackManifest
  /** Validation diagnostics for dropped values and rejected components. */
  diagnostics: ThemePackDiagnostic[]
  error?: string
}

/**
 * Validate a raw parsed `theme.json` against the pack contract.
 *
 * Fatal (ok: false): not an object, bad/missing id, id ≠ directory name,
 * id collides with a built-in, neither component present.
 *
 * Non-fatal (warnings): unknown desktop token keys (dropped), unsafe token
 * values (dropped), an iOS component that omits required tokens without a
 * `base` to inherit from, or names a bogus base, or carries invalid hex (iOS
 * part rejected; desktop part survives), malformed asset refs (dropped).
 *
 * `knownDesktopTokenKeys` is the live ColorPalette key set — passed in so
 * this module stays palette-agnostic and the caller controls the contract.
 */
export function validateThemePackManifest(
  raw: unknown,
  dirName: string,
  knownDesktopTokenKeys: ReadonlySet<string>,
): ThemePackValidationResult {
  const diagnostics: ThemePackDiagnostic[] = []
  const rejectPack = (message: string): ThemePackValidationResult => ({
    ok: false,
    diagnostics: [{ surface: 'pack', message, fatal: true }],
    error: message,
  })
  if (!isRecord(raw)) return rejectPack('theme.json is not a JSON object')

  const id = raw.id
  if (typeof id !== 'string' || !THEME_PACK_ID_RE.test(id)) {
    return rejectPack(`invalid pack id: ${JSON.stringify(raw.id)}`)
  }
  if (id !== dirName) {
    return rejectPack(`pack id ${id} does not match directory name ${dirName}`)
  }
  if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) {
    return rejectPack(`pack id ${id} collides with a built-in theme id`)
  }

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id
  const version = typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : '0.0.0'

  // ─── Desktop component ───
  let desktop: ThemePackDesktopComponent | undefined
  if (raw.desktop !== undefined) {
    if (!isRecord(raw.desktop)) {
      diagnostics.push({ surface: 'desktop', message: 'desktop component is not an object; rejected', fatal: true })
    } else {
      const base = raw.desktop.base
      if (typeof base !== 'string' || !(BUILTIN_THEME_IDS as readonly string[]).includes(base)) {
        diagnostics.push({ surface: 'desktop', message: `desktop.base ${JSON.stringify(raw.desktop.base)} is not a built-in theme id; desktop component rejected`, fatal: true })
      } else {
        const tokens: Record<string, string> = {}
        const rawTokens = isRecord(raw.desktop.tokens) ? raw.desktop.tokens : {}
        for (const [key, value] of Object.entries(rawTokens)) {
          if (!knownDesktopTokenKeys.has(key)) {
            diagnostics.push({ surface: 'desktop', message: `desktop token ${key} is not a ColorPalette key; dropped`, fatal: false })
            continue
          }
          if (!isSafeCssValue(value)) {
            diagnostics.push({ surface: 'desktop', message: `desktop token ${key} has an unsafe or non-string value; dropped`, fatal: false })
            continue
          }
          tokens[key] = value
        }
        const scheme = raw.desktop.forcedColorScheme
        desktop = {
          base: base as ThemePackDesktopComponent['base'],
          tokens,
          ...(scheme === 'light' || scheme === 'dark' ? { forcedColorScheme: scheme } : {}),
        }
        const assets = validateAssetRefs(raw.desktop.assets, diagnostics, 'desktop', 'desktop')
        if (assets) desktop.assets = assets
      }
    }
  }

  // ─── iOS component ───
  let ios: ThemePackIosComponent | undefined
  if (raw.ios !== undefined) {
    if (!isRecord(raw.ios)) {
      diagnostics.push({ surface: 'ios', message: 'ios component is not an object; rejected', fatal: true })
    } else {
      // base is required-when-partial: valid values are a built-in id or
      // omission. A present-but-bogus base is fatal to the iOS component (it
      // names an inheritance source that does not exist).
      const rawBase = raw.ios.base
      let base: (typeof BUILTIN_THEME_IDS)[number] | undefined
      let baseInvalid = false
      if (rawBase !== undefined) {
        if (typeof rawBase === 'string' && (BUILTIN_THEME_IDS as readonly string[]).includes(rawBase)) {
          base = rawBase as (typeof BUILTIN_THEME_IDS)[number]
        } else {
          baseInvalid = true
        }
      }

      const rawTokens = isRecord(raw.ios.tokens) ? raw.ios.tokens : {}
      const tokens: Record<string, string> = {}
      const missing: string[] = []
      const invalid: string[] = []
      for (const key of IOS_THEME_TOKEN_KEYS) {
        const value = rawTokens[key]
        const optional = OPTIONAL_IOS_THEME_TOKEN_KEYS.has(key)
        if (typeof value !== 'string') {
          if (optional) {
            diagnostics.push({ surface: 'ios', message: `ios code token ${key} missing; iOS falls back to theme defaults`, fatal: false })
          } else {
            missing.push(key)
          }
        } else if (!HEX_COLOR_RE.test(value)) {
          if (optional) {
            diagnostics.push({ surface: 'ios', message: `ios code token ${key} has invalid hex; iOS falls back to theme defaults`, fatal: false })
          } else {
            invalid.push(key)
          }
        } else {
          tokens[key] = value
        }
      }

      if (baseInvalid) {
        diagnostics.push({
          surface: 'ios',
          message: `ios.base ${JSON.stringify(raw.ios.base)} is not a built-in theme id; iOS component rejected`,
          fatal: true,
        })
      } else if (invalid.length > 0) {
        // Invalid hex is always fatal — a token present with a bad value is an
        // authoring error, never something a base should silently paper over.
        diagnostics.push({ surface: 'ios', message: `ios component rejected — invalid hex on required tokens: [${invalid.join(', ')}]`, fatal: true })
      } else if (missing.length > 0 && base === undefined) {
        // required-when-partial: a component omitting any REQUIRED token MUST
        // name a base to inherit the rest. Without one, iOS would render an
        // unreadable mix of pack + Ion Dark fallback colors, so the whole iOS
        // component is rejected. Naming a base makes the omission intentional
        // and the missing tokens resolve from that built-in on iOS.
        diagnostics.push({
          surface: 'ios',
          message: `ios component rejected — missing required tokens with no base to inherit from: [${missing.join(', ')}]`,
          fatal: true,
        })
      } else {
        const scheme = raw.ios.preferredColorScheme
        ios = {
          tokens,
          ...(base !== undefined ? { base } : {}),
          ...(scheme === 'light' || scheme === 'dark' ? { preferredColorScheme: scheme } : {}),
        }
        const assets = validateAssetRefs(raw.ios.assets, diagnostics, 'ios', 'ios')
        if (assets) ios.assets = assets
      }
    }
  }

  if (!desktop && !ios) {
    return { ok: false, diagnostics, error: 'pack has no usable desktop or ios component' }
  }

  const pack: ThemePackManifest = { id, name, version }
  if (desktop) pack.desktop = desktop
  if (ios) pack.ios = ios
  return { ok: true, pack, diagnostics }
}
