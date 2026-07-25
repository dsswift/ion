/**
 * Theme-pack types + pure manifest validator.
 *
 * A theme pack is a directory `<root>/<pack-id>/` containing a `theme.json`
 * manifest and optional image assets. Packs carry up to two components:
 *
 *   - `desktop` — a partial ColorPalette overlay on a built-in base theme,
 *     rendered by the desktop overlay/ATV windows.
 *   - `ios`     — the full iOS AppTheme token set. Only this component (plus
 *     its assets) ships to iOS over the desktop↔iOS wire.
 *
 * Shared module (no fs, no DOM): imported by the main-process loader
 * (`main/theme-packs.ts`), the renderer registry (`renderer/theme-tokens.ts`
 * consumers), and tests. Validation is pure so every surface exercises the
 * same rules.
 */

/** Built-in theme ids. Reserved: a pack claiming one of these is refused so
 * an installed pack can never silently redefine a stock theme and break the
 * identical-across-platforms guarantee. */
export const BUILTIN_THEME_IDS = ['ion-dark', 'ion-light', 'ion-classic', 'jarvis-hud'] as const

/** Pack ids match the ATV pack-id convention: lowercase alphanumeric + dashes,
 * 1–64 chars, and must equal the directory name. */
export const THEME_PACK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/**
 * The iOS AppTheme color-token contract. Mirrors the `AppTheme` protocol in
 * `ios/IonRemote/Utilities/AppTheme.swift` — a pack's iOS component must
 * supply every one of these keys or its iOS part is rejected (the desktop
 * part still loads). Keep in lockstep with the Swift protocol.
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
  'statusWarning',
  'surfaceElevated',
  'codeBg',
  'userBubbleTint',
] as const

export type IosThemeTokenKey = (typeof IOS_THEME_TOKEN_KEYS)[number]

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
  base: (typeof BUILTIN_THEME_IDS)[number]
  forcedColorScheme?: 'light' | 'dark'
  tokens: Record<string, string>
  backgroundDataUrl?: string
  logoDataUrl?: string
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

function validateAssetRefs(raw: unknown, warnings: string[], label: string): ThemePackAssetRefs | undefined {
  if (raw === undefined) return undefined
  if (!isRecord(raw)) {
    warnings.push(`${label}.assets is not an object; ignored`)
    return undefined
  }
  const out: ThemePackAssetRefs = {}
  for (const slot of ['background', 'logo'] as const) {
    const rel = raw[slot]
    if (rel === undefined) continue
    if (typeof rel !== 'string' || rel.length === 0 || rel.length > 512 || rel.includes('\0')) {
      warnings.push(`${label}.assets.${slot} is not a usable path; dropped`)
      continue
    }
    out[slot] = rel
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export interface ThemePackValidationResult {
  ok: boolean
  pack?: ThemePackManifest
  /** Non-fatal issues: dropped tokens, rejected components, dropped assets. */
  warnings: string[]
  error?: string
}

/**
 * Validate a raw parsed `theme.json` against the pack contract.
 *
 * Fatal (ok: false): not an object, bad/missing id, id ≠ directory name,
 * id collides with a built-in, neither component present.
 *
 * Non-fatal (warnings): unknown desktop token keys (dropped), unsafe token
 * values (dropped), an iOS component missing required tokens (iOS part
 * rejected; desktop part survives), malformed asset refs (dropped).
 *
 * `knownDesktopTokenKeys` is the live ColorPalette key set — passed in so
 * this module stays palette-agnostic and the caller controls the contract.
 */
export function validateThemePackManifest(
  raw: unknown,
  dirName: string,
  knownDesktopTokenKeys: ReadonlySet<string>,
): ThemePackValidationResult {
  const warnings: string[] = []
  if (!isRecord(raw)) return { ok: false, warnings, error: 'theme.json is not a JSON object' }

  const id = raw.id
  if (typeof id !== 'string' || !THEME_PACK_ID_RE.test(id)) {
    return { ok: false, warnings, error: `invalid pack id: ${JSON.stringify(raw.id)}` }
  }
  if (id !== dirName) {
    return { ok: false, warnings, error: `pack id ${id} does not match directory name ${dirName}` }
  }
  if ((BUILTIN_THEME_IDS as readonly string[]).includes(id)) {
    return { ok: false, warnings, error: `pack id ${id} collides with a built-in theme id` }
  }

  const name = typeof raw.name === 'string' && raw.name.trim().length > 0 ? raw.name.trim() : id
  const version = typeof raw.version === 'string' && raw.version.length > 0 ? raw.version : '0.0.0'

  // ─── Desktop component ───
  let desktop: ThemePackDesktopComponent | undefined
  if (raw.desktop !== undefined) {
    if (!isRecord(raw.desktop)) {
      warnings.push('desktop component is not an object; rejected')
    } else {
      const base = raw.desktop.base
      if (typeof base !== 'string' || !(BUILTIN_THEME_IDS as readonly string[]).includes(base)) {
        warnings.push(`desktop.base ${JSON.stringify(raw.desktop.base)} is not a built-in theme id; desktop component rejected`)
      } else {
        const tokens: Record<string, string> = {}
        const rawTokens = isRecord(raw.desktop.tokens) ? raw.desktop.tokens : {}
        for (const [key, value] of Object.entries(rawTokens)) {
          if (!knownDesktopTokenKeys.has(key)) {
            warnings.push(`desktop token ${key} is not a ColorPalette key; dropped`)
            continue
          }
          if (!isSafeCssValue(value)) {
            warnings.push(`desktop token ${key} has an unsafe or non-string value; dropped`)
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
        const assets = validateAssetRefs(raw.desktop.assets, warnings, 'desktop')
        if (assets) desktop.assets = assets
      }
    }
  }

  // ─── iOS component ───
  let ios: ThemePackIosComponent | undefined
  if (raw.ios !== undefined) {
    if (!isRecord(raw.ios)) {
      warnings.push('ios component is not an object; rejected')
    } else {
      const rawTokens = isRecord(raw.ios.tokens) ? raw.ios.tokens : {}
      const tokens: Record<string, string> = {}
      const missing: string[] = []
      const invalid: string[] = []
      for (const key of IOS_THEME_TOKEN_KEYS) {
        const value = rawTokens[key]
        if (typeof value !== 'string') {
          missing.push(key)
        } else if (!HEX_COLOR_RE.test(value)) {
          invalid.push(key)
        } else {
          tokens[key] = value
        }
      }
      if (missing.length > 0 || invalid.length > 0) {
        // The iOS token set is all-or-nothing: a partial theme would render
        // unreadable mixes of pack + fallback colors on the phone.
        warnings.push(
          `ios component rejected — missing tokens: [${missing.join(', ')}], invalid hex: [${invalid.join(', ')}]`,
        )
      } else {
        const scheme = raw.ios.preferredColorScheme
        ios = {
          tokens,
          ...(scheme === 'light' || scheme === 'dark' ? { preferredColorScheme: scheme } : {}),
        }
        const assets = validateAssetRefs(raw.ios.assets, warnings, 'ios')
        if (assets) ios.assets = assets
      }
    }
  }

  if (!desktop && !ios) {
    return { ok: false, warnings, error: 'pack has no usable desktop or ios component' }
  }

  const pack: ThemePackManifest = { id, name, version }
  if (desktop) pack.desktop = desktop
  if (ios) pack.ios = ios
  return { ok: true, pack, warnings }
}
