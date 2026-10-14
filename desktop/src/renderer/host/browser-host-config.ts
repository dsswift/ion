/**
 * browser-host-config -- what `BrowserStudioHost` is built from: its
 * capability list, its reconnect ladder, and the `host.shell` verbs a browser
 * tab answers locally.
 */
import type { IonAPI } from '../../preload/ionapi'
import type { Capability } from './StudioHost'
import { BRIDGED_CAPABILITIES } from './browser-shell-bridge'
import { BrowserLogForwarder } from './browser-log-forward'

export const CAPABILITIES: Capability[] = [
  'terminal', 'git', 'files', 'questions', 'graph',
  // Earned by browser-shell-bridge.ts's table: every `host.shell` verb the
  // AI & Models settings category and the model picker call is bridged, so
  // the category is no longer filtered out of SettingsDialog's sidebar.
  ...(BRIDGED_CAPABILITIES as Capability[]),
]

/** Attempt ladder for a failed connection — identical to `main/connections/broker.ts`'s, so a browser tab and the desktop app behave the same way under a flaky link. */
export const BACKOFF_LADDER_MS = [1000, 2000, 4000, 8000]
/** Frames held while there is no open connection. Past this the oldest are dropped. */
export const MAX_PENDING_FRAMES = 100

export const BACKOFF_WINDOW_MS = 5 * 60_000
export const MAX_ATTEMPTS = 5
/**
 * Once the ladder above is exhausted, retry forever at this slower, gentle
 * cadence instead of stopping. `phase: 'offline'` still fires at that point
 * (the UI reads it as "disconnected" exactly as before), but it is no
 * longer a dead end -- a tab left open across a server restart or a long
 * network outage recovers on its own instead of requiring a manual reload
 * or an explicit Reconnect action forever. Matches
 * `main/connections/broker.ts`'s identical constant for the same reason the
 * ladder above does.
 */
export const OFFLINE_RETRY_MS = 30_000

/** Matches `host-actions.ts`'s ACTION_TIMEOUT_MS so both round trips fail the same way. */
export const BRIDGED_CALL_TIMEOUT_MS = 30_000

/**
 * Holds lines the server will not take yet -- before sign-in, or over budget
 * -- and replays them once it will. Without it the lines describing a failing
 * sign-in were the exact ones thrown away.
 */
export const logForwarder = new BrowserLogForwarder()

/**
 * The browser's local answers, read before the bridge table.
 *
 * `platform` is not a function (`IonAPI` callers read it directly), and
 * `logWrite` is the one verb with a real browser transport of its own:
 * `POST /log`, which carries the `ion_session` cookie automatically.
 */
export const BROWSER_OVERRIDES: Partial<IonAPI> = {
  // No native window chrome exists in a browser tab. This value only matters
  // through `useStudioWindowChrome`'s non-darwin branch, which reserves inset
  // space for native min/max/close buttons a browser tab doesn't have.
  platform: 'linux',
  getPathForFile: () => '',
  logWrite: (level, tag, msg, fields) => {
    logForwarder.send({ level, tag, msg, fields })
  },
}
