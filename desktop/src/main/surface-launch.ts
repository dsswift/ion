/**
 * surface-launch — pure resolution of which client surfaces (overlay glass,
 * ATV shell) launch, which are enabled at all, and which shortcuts drive
 * them. The overlay window's RENDERER always exists (it is the session-store
 * owner); "overlay disabled" means its glass surface is never shown, not
 * that the renderer is gone.
 *
 * `surfacePolicy` is the enterprise/operator gate (deployable via a managed
 * settings.json); `launchSurface` is the user preference within that gate.
 */

export type LaunchSurface = 'overlay' | 'atv' | 'both'
export type SurfacePolicy = 'both' | 'overlay-only' | 'atv-only'

export interface SurfacePlan {
  /** Show the overlay glass at startup. */
  showOverlayOnLaunch: boolean
  /** Open the ATV shell window at startup. */
  openAtvOnLaunch: boolean
  /** ATV surface permitted (tray item, launcher button, atv:open, shortcut). */
  atvEnabled: boolean
  /** Overlay glass permitted (Alt+Space shows it; tray item present). */
  overlayEnabled: boolean
  /** Global shortcut for the ATV toggle ('' = none registered). */
  atvShortcut: string
}

const SURFACES: ReadonlySet<string> = new Set(['overlay', 'atv', 'both'])
const POLICIES: ReadonlySet<string> = new Set(['both', 'overlay-only', 'atv-only'])
/** Electron accelerator shape, loosely: token(+token)* — never arbitrary text. */
const ACCELERATOR_RE = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/

export const DEFAULT_ATV_SHORTCUT = 'Alt+Shift+Space'

export function resolveSurfacePlan(settings: Record<string, unknown>): SurfacePlan {
  const policy: SurfacePolicy = POLICIES.has(String(settings.surfacePolicy))
    ? (settings.surfacePolicy as SurfacePolicy)
    : 'both'
  const requested: LaunchSurface = SURFACES.has(String(settings.launchSurface))
    ? (settings.launchSurface as LaunchSurface)
    : 'overlay'

  // atvBeta gates the ATV surface independent of surfacePolicy. The feature
  // ships but is not advertised; users opt in via settings.json. The policy
  // check still applies on top: overlay-only always wins.
  const atvEnabled = policy !== 'overlay-only' && settings.atvBeta === true
  const overlayEnabled = policy !== 'atv-only'

  // Clamp the user preference into the policy: a disabled surface can never
  // be the launch surface.
  let surface = requested
  if (!atvEnabled && (surface === 'atv' || surface === 'both')) surface = 'overlay'
  if (!overlayEnabled && (surface === 'overlay' || surface === 'both')) surface = 'atv'

  const rawShortcut = typeof settings.atvShortcut === 'string' ? settings.atvShortcut : DEFAULT_ATV_SHORTCUT
  const atvShortcut = atvEnabled && ACCELERATOR_RE.test(rawShortcut) ? rawShortcut : ''

  // Open-state restore: an ATV left open at last quit reopens on launch
  // (atvWindowOpen is main-managed by atv-window-manager). The policy gate
  // still wins — an ATV disabled between restarts never reopens.
  const atvWasOpen = settings.atvWindowOpen === true

  return {
    showOverlayOnLaunch: overlayEnabled && (surface === 'overlay' || surface === 'both'),
    openAtvOnLaunch: atvEnabled && (surface === 'atv' || surface === 'both' || atvWasOpen),
    atvEnabled,
    overlayEnabled,
    atvShortcut,
  }
}
