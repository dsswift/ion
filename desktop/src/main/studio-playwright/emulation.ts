/**
 * Device and viewport emulation for the visible Studio browser guest.
 *
 * `page.setViewportSize()` is the obvious tool and the wrong one here: on a
 * CDP-attached page it resizes Playwright's own view of the page, which does
 * not move the Electron `<webview>` the operator is looking at. The result
 * would be an agent that "resized" to a phone while the visible tab stayed
 * desktop-width — the two would disagree, and the screenshots would be a lie.
 *
 * So emulation is applied through the guest's own CDP session
 * (`Emulation.setDeviceMetricsOverride` and friends), which is exactly what
 * Chrome DevTools' device toolbar does. The renderer is then asked to size its
 * visible frame to match, so the page, the agent, and the operator all see one
 * viewport.
 *
 * `reset` clears every override rather than restoring remembered values: a
 * partial reset is how stale UA strings and touch flags survive into a
 * "responsive" session and quietly change behavior later.
 */
import type { Page } from 'playwright-core'
import { devices } from 'playwright-core'
import { log as _log } from '../logger'
import type { BrowserEmulationState, BrowserOrientation } from '../../shared/studio-browser-types'
import { MAX_EMULATION_DIMENSION, MAX_EMULATION_SCALE_FACTOR, MIN_EMULATION_DIMENSION } from '../../shared/studio-browser-types'

const TAG = 'studio-playwright'

export interface EmulationRequest {
  device?: unknown
  width?: unknown
  height?: unknown
  screenWidth?: unknown
  screenHeight?: unknown
  deviceScaleFactor?: unknown
  isMobile?: unknown
  hasTouch?: unknown
  userAgent?: unknown
  locale?: unknown
  timezoneId?: unknown
  orientation?: unknown
  colorScheme?: unknown
  reducedMotion?: unknown
  forcedColors?: unknown
  geolocation?: unknown
  offline?: unknown
  javaScriptEnabled?: unknown
  reset?: unknown
}

export interface EmulationResolution {
  state: BrowserEmulationState | null
  /** Present when the request cannot be honored; model-visible. */
  error?: string
  /**
   * Set when a preset targets a non-Chromium engine. Device emulation gives
   * that device's layout, DPR, touch, and UA — never its rendering engine, and
   * saying so prevents "it passed on iPhone" from meaning WebKit parity.
   */
  engineNotice?: string
}

/** Device names, for error messages and discovery. */
export function knownDevices(): string[] {
  return Object.keys(devices)
}

/**
 * Resolve a request against the current state.
 *
 * Precedence is preset first, explicit fields second, so `device: 'iPhone 15',
 * width: 500` means "that phone, but this wide" instead of failing. Omitted
 * fields inherit the CURRENT state, which is what makes `browser_resize`
 * behave as a viewport change rather than a silent reset of everything else.
 */
export function resolveEmulation(current: BrowserEmulationState | null, request: EmulationRequest): EmulationResolution {
  if (request.reset === true) return { state: null }

  let base: BrowserEmulationState | null = current
  let engineNotice: string | undefined
  if (request.device !== undefined) {
    if (typeof request.device !== 'string' || !(request.device in devices)) {
      return { state: current, error: `unknown device "${String(request.device)}". Use one of the Playwright device names, for example "iPhone 15" or "Pixel 7".` }
    }
    const preset = devices[request.device]!
    base = {
      device: request.device,
      width: preset.viewport.width,
      height: preset.viewport.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      userAgent: preset.userAgent,
    }
    if (preset.defaultBrowserType !== 'chromium') {
      engineNotice = `"${request.device}" is emulated on Chromium: viewport, scale factor, touch, and user agent match the device, but the rendering engine is not ${preset.defaultBrowserType}.`
    }
  }

  const width = pickDimension(request.width, base?.width)
  const height = pickDimension(request.height, base?.height)
  if (width === null || height === null) {
    return { state: current, error: `width and height must be integers between ${MIN_EMULATION_DIMENSION} and ${MAX_EMULATION_DIMENSION}` }
  }

  const state: BrowserEmulationState = { width, height }
  if (base?.device && request.device === undefined) state.device = base.device
  else if (typeof request.device === 'string') state.device = request.device
  // A viewport that no longer matches its preset is no longer that device, so
  // the label is dropped rather than left to misreport what is being tested.
  if (state.device && base && (width !== base.width || height !== base.height)) delete state.device

  const scale = pickNumber(request.deviceScaleFactor, base?.deviceScaleFactor, 0, MAX_EMULATION_SCALE_FACTOR)
  if (scale !== undefined) state.deviceScaleFactor = scale
  const screenWidth = pickDimension(request.screenWidth, base?.screenWidth ?? undefined)
  if (screenWidth) state.screenWidth = screenWidth
  const screenHeight = pickDimension(request.screenHeight, base?.screenHeight ?? undefined)
  if (screenHeight) state.screenHeight = screenHeight
  const isMobile = pickBoolean(request.isMobile, base?.isMobile)
  if (isMobile !== undefined) state.isMobile = isMobile
  const hasTouch = pickBoolean(request.hasTouch, base?.hasTouch)
  if (hasTouch !== undefined) state.hasTouch = hasTouch
  const offline = pickBoolean(request.offline, base?.offline)
  if (offline !== undefined) state.offline = offline
  const javaScriptEnabled = pickBoolean(request.javaScriptEnabled, base?.javaScriptEnabled)
  if (javaScriptEnabled !== undefined) state.javaScriptEnabled = javaScriptEnabled
  const userAgent = pickString(request.userAgent, base?.userAgent, 512)
  if (userAgent) state.userAgent = userAgent
  const locale = pickString(request.locale, base?.locale, 35)
  if (locale) state.locale = locale
  const timezoneId = pickString(request.timezoneId, base?.timezoneId, 64)
  if (timezoneId) state.timezoneId = timezoneId
  const orientation = pickEnum<BrowserOrientation>(request.orientation, base?.orientation, ['portrait', 'landscape'])
  if (orientation) state.orientation = orientation
  const colorScheme = pickEnum(request.colorScheme, base?.colorScheme, ['light', 'dark', 'no-preference'] as const)
  if (colorScheme) state.colorScheme = colorScheme
  const reducedMotion = pickEnum(request.reducedMotion, base?.reducedMotion, ['reduce', 'no-preference'] as const)
  if (reducedMotion) state.reducedMotion = reducedMotion
  const forcedColors = pickEnum(request.forcedColors, base?.forcedColors, ['active', 'none'] as const)
  if (forcedColors) state.forcedColors = forcedColors

  if (request.geolocation !== undefined) {
    const geo = request.geolocation
    if (!geo || typeof geo !== 'object') return { state: current, error: 'geolocation must be an object with latitude and longitude' }
    const g = geo as Record<string, unknown>
    if (typeof g.latitude !== 'number' || typeof g.longitude !== 'number' || Math.abs(g.latitude) > 90 || Math.abs(g.longitude) > 180) {
      return { state: current, error: 'geolocation latitude must be within ±90 and longitude within ±180' }
    }
    state.geolocation = { latitude: g.latitude, longitude: g.longitude, ...(typeof g.accuracy === 'number' && g.accuracy >= 0 ? { accuracy: g.accuracy } : {}) }
  } else if (base?.geolocation) {
    state.geolocation = base.geolocation
  }

  return { state, ...(engineNotice ? { engineNotice } : {}) }
}

/**
 * One CDP session per page, held for the page's lifetime.
 *
 * CDP emulation overrides belong to the SESSION that set them: detaching
 * reverts device metrics, touch, and the user-agent override immediately.
 * Creating a session per call and closing it in a `finally` therefore undid
 * every override the moment it was applied — the page reported the new
 * viewport (that one survives via the renderer resize) while DPR, touch, and
 * UA silently snapped back to the desktop values.
 *
 * The session is cached per page and released only when the page closes.
 */
const emulationSessions = new WeakMap<Page, Promise<import('playwright-core').CDPSession>>()

export function emulationSession(page: Page): Promise<import('playwright-core').CDPSession> {
  let session = emulationSessions.get(page)
  if (!session) {
    session = page.context().newCDPSession(page)
    emulationSessions.set(page, session)
    // Drop the cache entry when the page goes away so a rebound guest gets a
    // fresh session rather than a dead one.
    page.once('close', () => emulationSessions.delete(page))
  }
  return session
}

/** Apply (or with null, clear) emulation on the exact visible guest. */
export async function applyEmulation(
  page: Page,
  state: BrowserEmulationState | null,
  /**
   * Whether the guest is on screen.
   *
   * `mobile: true` only governs meta-viewport layout, and on a parked view it
   * makes Chromium ignore the requested width in favour of a 980-wide default
   * scaled by the DPR. Suppressing it while hidden yields the exact requested
   * viewport, and the page's mobile CSS still engages because that follows the
   * width, not this flag.
   */
  displayed = true,
): Promise<void> {
  const session = await emulationSession(page)
  {
    if (!state) {
      await session.send('Emulation.clearDeviceMetricsOverride')
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await session.send('Emulation.setUserAgentOverride', { userAgent: '' })
      await session.send('Emulation.setEmulatedMedia', { features: [] })
      await session.send('Emulation.setGeolocationOverride', {})
      await session.send('Emulation.setScriptExecutionDisabled', { value: false })
      await session.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => { /* silent-ok: Network domain optional on some targets */ })
      _log(TAG, 'browser emulation cleared', {})
      return
    }

    await session.send('Emulation.setDeviceMetricsOverride', {
      width: state.width,
      height: state.height,
      deviceScaleFactor: state.deviceScaleFactor ?? 0,
      mobile: displayed ? (state.isMobile ?? false) : false,
      screenWidth: state.screenWidth ?? state.width,
      screenHeight: state.screenHeight ?? state.height,
      screenOrientation: (state.orientation ?? (state.height >= state.width ? 'portrait' : 'landscape')) === 'portrait'
        ? { type: 'portraitPrimary', angle: 0 }
        : { type: 'landscapePrimary', angle: 90 },
    })
    // Touch is set explicitly rather than inferred from `mobile`: a desktop
    // viewport with touch is a real configuration worth testing.
    //
    // maxTouchPoints is always >= 1. Chromium rejects 0 outright ("Touch
    // points must be between 1 and 16"), which failed EVERY resize and
    // emulate call, touch or not — `enabled: false` is what turns touch off,
    // and the point count is simply ignored in that case.
    await session.send('Emulation.setTouchEmulationEnabled', {
      enabled: state.hasTouch ?? state.isMobile ?? false,
      maxTouchPoints: (state.hasTouch ?? state.isMobile) ? 5 : 1,
    })
    if (state.userAgent || state.locale) {
      await session.send('Emulation.setUserAgentOverride', {
        userAgent: state.userAgent ?? await page.evaluate(() => navigator.userAgent),
        ...(state.locale ? { acceptLanguage: state.locale } : {}),
      })
    }
    if (state.timezoneId) await session.send('Emulation.setTimezoneOverride', { timezoneId: state.timezoneId })
    if (state.locale) await session.send('Emulation.setLocaleOverride', { locale: state.locale }).catch(() => { /* silent-ok: locale override unsupported on this target */ })
    const features: { name: string; value: string }[] = []
    if (state.colorScheme) features.push({ name: 'prefers-color-scheme', value: state.colorScheme })
    if (state.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: state.reducedMotion })
    if (state.forcedColors) features.push({ name: 'forced-colors', value: state.forcedColors })
    if (features.length > 0) await session.send('Emulation.setEmulatedMedia', { features })
    if (state.geolocation) {
      await session.send('Emulation.setGeolocationOverride', {
        latitude: state.geolocation.latitude,
        longitude: state.geolocation.longitude,
        accuracy: state.geolocation.accuracy ?? 10,
      })
    }
    if (state.javaScriptEnabled === false) await session.send('Emulation.setScriptExecutionDisabled', { value: true })
    if (state.offline !== undefined) {
      await session.send('Network.emulateNetworkConditions', {
        offline: state.offline,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      }).catch(() => { /* silent-ok: Network domain optional on some targets */ })
    }
    _log(TAG, 'browser emulation applied', {
      device: state.device ?? '',
      width: state.width,
      height: state.height,
      mobile: displayed ? (state.isMobile ?? false) : false,
      touch: state.hasTouch ?? false,
    })
  }
}

function pickDimension(raw: unknown, fallback: number | undefined): number | null {
  if (raw === undefined) return fallback ?? null
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < MIN_EMULATION_DIMENSION || raw > MAX_EMULATION_DIMENSION) return null
  return raw
}
function pickNumber(raw: unknown, fallback: number | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return fallback
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= min || raw > max) return fallback
  return raw
}
function pickBoolean(raw: unknown, fallback: boolean | undefined): boolean | undefined {
  return typeof raw === 'boolean' ? raw : fallback
}
function pickString(raw: unknown, fallback: string | undefined, maxLength: number): string | undefined {
  if (typeof raw === 'string' && raw.length > 0 && raw.length <= maxLength) return raw
  return raw === undefined ? fallback : undefined
}
function pickEnum<T extends string>(raw: unknown, fallback: T | undefined, allowed: readonly T[]): T | undefined {
  if (typeof raw === 'string' && (allowed as readonly string[]).includes(raw)) return raw as T
  return raw === undefined ? fallback : undefined
}
