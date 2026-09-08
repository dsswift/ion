/**
 * surface-launch — pure resolution of the ACTIVE conversation UI.
 *
 * Single-UI exclusivity (D1): exactly one conversation UI exists at a
 * time — the overlay glass or the Ion Studio window. There is no 'both'.
 * The overlay window's RENDERER always exists regardless (it is the
 * session-store owner); "overlay inactive" means its glass never shows,
 * not that the renderer is gone.
 *
 * Resolution order:
 *   1. Enterprise activeUiPolicy with locked:true — clamps everything.
 *   2. User preference: `activeUi` (post-migration key), falling back to
 *      the legacy `launchSurface` for a managed settings.json pushed
 *      mid-cycle ('atv'→studio, 'both'→overlay) and the legacy
 *      `surfacePolicy` single-surface values.
 *   3. Enterprise activeUiPolicy unlocked — managed DEFAULT when the user
 *      has no explicit preference.
 *   4. Default: overlay.
 *
 * The inactive UI's affordances (global shortcut, tray items, launcher
 * button, studio:open) are REMOVED, not disabled — consumers read
 * `studioEnabled` / `overlayEnabled` as existence flags.
 */
import { deriveEnterpriseActiveUiPolicy, type ActiveUi } from '../shared/enterprise-active-ui-policy'
import type { EnterprisePolicy } from '../shared/types-engine'

export interface SurfacePlan {
  /** The single active conversation UI. */
  activeUi: ActiveUi
  /** Show the overlay glass at startup. */
  showOverlayOnLaunch: boolean
  /** Open the Studio window at startup. */
  openStudioOnLaunch: boolean
  /** Studio affordances exist (tray item, launcher button, studio:open, shortcut). */
  studioEnabled: boolean
  /** Overlay glass affordances exist (Alt+Space shows it; tray item present). */
  overlayEnabled: boolean
  /** Global shortcut for the Studio toggle ('' = none registered). */
  studioShortcut: string
  /** What clamped the plan, when clamped: an enterprise policy lock, or the
   *  platform itself (win32, where the Overlay glass is a non-goal and
   *  Studio is the only conversation interface). Platform outranks policy —
   *  a locked policy naming 'overlay' still yields Studio on win32. */
  lockedBy: 'policy' | 'platform' | null
}

/** Electron accelerator shape, loosely: token(+token)* — never arbitrary text. */
const ACCELERATOR_RE = /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/

export const DEFAULT_STUDIO_SHORTCUT = 'Alt+Shift+Space'

/** The user's requested UI from settings (post- and pre-migration keys). */
function requestedUi(settings: Record<string, unknown>): ActiveUi | null {
  if (settings.activeUi === 'studio' || settings.activeUi === 'overlay') return settings.activeUi
  // Legacy keys: a managed settings.json can arrive mid-cycle carrying them.
  if (settings.launchSurface === 'atv' || settings.launchSurface === 'studio') return 'studio'
  if (settings.launchSurface === 'overlay' || settings.launchSurface === 'both') return 'overlay'
  if (settings.surfacePolicy === 'atv-only') return 'studio'
  if (settings.surfacePolicy === 'overlay-only') return 'overlay'
  return null
}

export function resolveSurfacePlan(
  settings: Record<string, unknown>,
  enterprisePolicy?: EnterprisePolicy | null,
  platform: NodeJS.Platform = process.platform,
): SurfacePlan {
  // Windows: the Overlay glass is a non-goal (a macOS-shaped transparent
  // window with no Windows equivalent). Studio is the only conversation
  // interface there, and the clamp outranks even a locked enterprise
  // policy naming 'overlay' — there is nowhere else for it to go.
  if (platform === 'win32') {
    const rawShortcut = typeof settings.studioShortcut === 'string' ? settings.studioShortcut : DEFAULT_STUDIO_SHORTCUT
    const studioShortcut = ACCELERATOR_RE.test(rawShortcut) ? rawShortcut : ''
    return {
      activeUi: 'studio',
      showOverlayOnLaunch: false,
      openStudioOnLaunch: true,
      studioEnabled: true,
      overlayEnabled: false,
      studioShortcut,
      lockedBy: 'platform',
    }
  }

  const policy = deriveEnterpriseActiveUiPolicy(enterprisePolicy)

  let activeUi: ActiveUi
  let lockedBy: SurfacePlan['lockedBy'] = null
  if (policy?.locked) {
    activeUi = policy.ui
    lockedBy = 'policy'
  } else {
    activeUi = requestedUi(settings) ?? policy?.ui ?? 'overlay'
  }
  const studioEnabled = activeUi === 'studio'
  const overlayEnabled = activeUi === 'overlay'

  const rawShortcut = typeof settings.studioShortcut === 'string' ? settings.studioShortcut : DEFAULT_STUDIO_SHORTCUT
  const studioShortcut = studioEnabled && ACCELERATOR_RE.test(rawShortcut) ? rawShortcut : ''

  return {
    activeUi,
    showOverlayOnLaunch: overlayEnabled,
    openStudioOnLaunch: studioEnabled,
    studioEnabled,
    overlayEnabled,
    studioShortcut,
    lockedBy,
  }
}
