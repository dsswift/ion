/**
 * StudioHost — the renderer's transport-agnostic seam onto the shell (spec
 * 12 §Technical Approach, Phase 3). The renderer never touches `ipcRenderer`
 * or a raw WebSocket directly; every environment connection and every shell
 * capability (open a URL, pick a file, read device settings) goes through
 * this interface. `ElectronStudioHost` is the only implementation today, but
 * the seam exists so a non-Electron host (a future web client embedding the
 * same renderer bundle) is a second implementation, not a rewrite.
 */
import type { StudioFrame } from '@ion/shared/studio-wire/types'
import type { NearbyStudioServer } from '@ion/shared/types-nearby'
import type { ConnectionPhaseSnapshot } from '../../shared/types-connections'
import type { SshAddEnvironmentProgress, SshAddEnvironmentResult } from '@ion/shared/types-ssh-environment'
import type { EnvironmentTarget } from '@ion/shared/types-environments'
import type { ExportFileOptions, ExportFileResult, ImportFileResult, TransferLanding, TransferProgress } from '@ion/shared/types-transfer'
import type { PortForward, PortForwardStartResult } from '@ion/shared/port-forward'
import type { ShellApi } from './shell-api'

/**
 * A shell-side ability the renderer may use without going through `action()`.
 * Kept in main so credentials, native dialogs, and OS integration never
 * reach the renderer. The first four are Electron-shell verbs
 * (`ElectronStudioHost` only); the rest are host-environment feature domains
 * a renderer surface gates on (spec 18): a browser host has no native window
 * chrome, no OS tray, no deep-link scheme, and no local/relay transport of
 * its own, so `BrowserStudioHost.capabilities()` omits `browser`,
 * `deeplink`, `tray`, `notifications`, `local`, and `relay` while still
 * reporting `terminal`, `git`, `files`, `questions`, and `graph` (all of
 * which route through `action()`/`send()`/`onFrame()`, not `shell`).
 * `updates` is an Electron-shell verb too, distinct from the wire-routed
 * group above: the self-update lifecycle has no browser or wire form, so it
 * gates a direct `shell` call the same way the first four do.
 *
 * There is no capability for the core engine-event stream (normalized
 * events, tab status, errors, engine reconnect): every host receives it the
 * same way, as `studio_event` wire frames on the four channels the server
 * fans out (`ion:normalized-event`, `ion:tab-status-change`,
 * `ion:enriched-error`, `ion:engine-reconnected` -- see
 * `@ion/shared/studio-wire/channels.ts`), and `useEngineEvents` is the one
 * consumer. A `directEvents` capability used to let the Electron window
 * prefer raw main-process IPC for the LOCAL Environment; that IPC lost its
 * producer when the store moved into the Studio server (ADR-033), so the
 * window skipped the local frames and applied nothing -- every local
 * conversation rendered empty. `shell.onEvent` (the visualizer's agent
 * cache) is bridged to the same frame channel in browser-shell-bridge.ts.
 *
 * There is no capability for cross-window mirror sync any more. Every
 * client, the Electron window included, hydrates tabs, worktrees and
 * conversation terminals from the studio-wire (`studio_welcome` plus the
 * per-principal `studio:*-sync` channels); the Electron-only IPC pull that
 * a `windowMirrorSync` capability once gated duplicated that data for the
 * LOCAL Environment and was deleted with the capability.
 *
 * Guided Questions hydration (`questions-store.ts`'s `questionsGetState()`/
 * `onQuestionsState()`) is wire-served on every host: both verbs have a
 * `SHELL_INVOKE`/`SHELL_SUBSCRIBE` row and a server action, so the calls are
 * unconditional; nothing gates them.
 *
 * `webApplicationOpen` gates `StudioShell.tsx`'s
 * `onStudioOpenWebApplication` subscription -- a paired device's request to
 * open a terminal's web application as a Studio Browser Surface tab. The
 * request arrives on the wire for every host; only a host that can embed
 * the Studio Browser acts on it.
 *
 * `graph`, like `terminal`, `git`, `files` and `questions`, names a wire-
 * routed domain every host reports. Graph tool commands reach the renderer
 * as `studio_command` frames on every host (`studio/graph/studio-graph-
 * commands.ts`), and the Graph View's corpus and config reads
 * (`graphViewGetConfig`, `graphCorpusSubscribe` and their listeners in
 * `graph-store-corpus.ts`) are the `graphView.*` actions, so nothing gates
 * them.
 *
 * `startupReport` gates `startup-report.ts`'s one call onto the shell's
 * splash-progress method -- Electron's splash window progress reporting. No
 * splash window and no wire equivalent exists for a browser tab.
 *
 * Slash-command discovery (`InputBar.tsx`'s `discoverCommands()` call) is
 * wire-served on every host -- the verb has a `SHELL_INVOKE` row and a
 * server action -- so the call is unconditional; nothing gates it.
 *
 * `windowShown` gates InputBar.tsx's onWindowShown listener (refocus the
 * textarea when an Electron window is un-minimized/toggled back). No
 * concept of "window shown" exists for a browser tab.
 *
 * `nativeWindowChrome` gates useStudioWindowChrome.ts's onStudioWindowChrome
 * subscription and studioSetTitleBarOverlay call -- native title-bar
 * fullscreen state and overlay color. A browser tab has no native window
 * chrome to control (its `platform` already reads 'linux' via
 * unsupportedShell's override, which is not enough by itself: the
 * non-darwin branch still tried to call studioSetTitleBarOverlay).
 *
 * Chart-jump navigation (`onChartJump` in ConversationView.tsx and
 * `requestChartJump` from the charts section and `ChartMovedMarker`) is
 * wire-served on every host via `SHELL_SUBSCRIBE`/`SHELL_INVOKE` rows and
 * server actions, so those calls are unconditional; nothing gates them.
 *
 * `git`, `terminal`, and `files` (and the `gitDirect`/`terminalDirect`/
 * `filesDirect` names that briefly gated their call sites) route through the
 * wire on every host today: each `host.shell.git*`/`terminal*`/`fs*` verb a
 * renderer surface calls has a `SHELL_INVOKE` row and a server action, so
 * those calls are unconditional. `nativeShell` (below) is what separates the
 * OS-dialog verbs that were once mixed in with them.
 *
 * The Visualizer surface tab renders on every host. Its tab-catalog/status
 * queries (`studioListTabs`, `studioGetAllStatus`) and its own theme-pack
 * loader (`studioListThemes`, `studioReadThemeBundle`, `studioReadThemeAsset`
 * — a Visualizer-scoped theme system, unrelated to Studio's own
 * `desktop_theme_manifest` picker) are `studio.*` actions the server answers;
 * cross-conversation focus is the forwarded `selectTab` store action. Only
 * video/image export (`studioExportVideo`, `studioExportImage`) is native --
 * it ends in a save dialog -- and `useExports` gates it on `nativeShell`.
 *
 * The "AI & Models", "Desktop Automation", "MCP Servers" and "Enterprise
 * Auth" settings categories are wire-served on every host (their
 * `aiModelsDirect`/`automationDirect`/`mcpDirect`/`entraDirect` gates were
 * deleted once every verb they call was bridged). `SettingsDialog`'s
 * `CATEGORIES` filter still drops "Environments" for a host without `local`.
 *
 * Session-data reads (`loadConversationTranscript`, `getConversation`,
 * `tabHealth`, `loadSession`, `engineGetContextBreakdown`) and
 * `engineCommand` are wire-served on every host: each verb has a
 * `SHELL_INVOKE` row and a server action, so the calls are unconditional;
 * nothing gates them. So is `InputBarVoiceButton.tsx`'s `transcribeAudio`
 * (`transcribe.audio`, run on the server host).
 */
/**
 * `nativeShell` is the "this client has an operating-system shell" capability:
 * a native save dialog, Finder/Explorer reveal, opening a path in the OS
 * default application, an OS screen capture, a native file picker, and
 * opening an auxiliary desktop window.
 *
 * It exists because the former `filesDirect` capability was doing two
 * unrelated jobs. It gated reading and writing files, which a browser client
 * does perfectly well over the wire -- and it ALSO gated `fsSaveDialog`,
 * `fsRevealInFinder` and `fsOpenNative`, which are OS dialogs with no wire
 * form at all. A browser held it, so those gates opened and the calls behind
 * them threw: the gate was not wrong, it was overloaded.
 *
 * Splitting them is what lets a browser keep every file operation while the
 * OS-shell verbs stay hidden. File I/O is about the filesystem, which the
 * server has; `nativeShell` is about the machine in front of the user, which
 * a browser tab cannot reach.
 */
/** One entry of a native file dialog's type filter: a label and bare extensions (`['zip']`). */
export interface FileDialogFilter {
  name: string
  extensions: string[]
}

/**
 * Port Forward (`@ion/shared/port-forward`): this client listens on a loopback
 * port of its own machine and carries each connection to a port on an
 * Environment's host.
 */
export interface PortForwardHost {
  /** Every active forward on this client. */
  list(): Promise<PortForward[]>
  /** The full list, pushed on every change. Returns an unsubscribe function. */
  onChange(cb: (forwards: PortForward[]) => void): () => void
  /** Forwards `remotePort` on `environmentId`'s host; resolves to the existing forward when there is one. */
  start(environmentId: string, remotePort: number): Promise<PortForwardStartResult>
  /** Stops one forward. Resolves to whether there was one. */
  stop(environmentId: string, remotePort: number): Promise<boolean>
}

export type Capability =
  | 'openExternal' | 'pickFile' | 'pickDirectory' | 'clipboardWriteImage'
  | 'browser' | 'deeplink' | 'tray' | 'notifications' | 'local' | 'relay'
  | 'terminal' | 'git' | 'files' | 'questions' | 'graph'
  | 'updates'
  | 'webApplicationOpen'
  | 'startupReport' | 'windowShown' | 'nativeWindowChrome'
  | 'nativeShell'

export interface StudioHost {
  /**
   * The desktop-local IPC bridge, for calls with no environment-relative
   * `studio_action` equivalent yet (git, worktree filesystem operations,
   * terminal PTY, settings, providers, OAuth, deep links, themes, MCP,
   * automation runtime, transcription, remote control, file explorer). These
   * run against THIS desktop's own machine regardless of which environment is
   * active, so they are not routed through `action()`'s environment-relative
   * `studio_action` wire — see spec 12's deviation note (`ElectronStudioHost`
   * resolves this live off `window.ion` on every access, never a cached
   * snapshot, so it always reflects the current preload bridge).
   */
  shell: ShellApi
  /** Sends a Studio wire frame to one environment, unchanged. */
  send(environmentId: string, frame: StudioFrame): void
  /** Subscribes to every frame the shell relays from any environment. Returns an unsubscribe function. */
  onFrame(cb: (environmentId: string, frame: StudioFrame) => void): () => void
  /** The current phase of every known environment connection. */
  connections(): Promise<ConnectionPhaseSnapshot[]>
  /** Subscribes to connection phase snapshots (pushed on every transition). Returns an unsubscribe function. */
  onConnections(cb: (snapshot: ConnectionPhaseSnapshot[]) => void): () => void
  /** Reads the device-local settings store (`desktop.json`) — never over the Studio wire. */
  deviceSettings(): Promise<Record<string, unknown>>
  /** Writes one device-local setting. */
  setDeviceSetting(key: string, value: unknown): Promise<void>
  /** Which shell capabilities this host implements. */
  capabilities(): Capability[]
  /** Opens a URL in the OS default browser. */
  openExternal(url: string): Promise<boolean>
  /** Opens a native "choose a file" dialog; null when cancelled. `filters` narrows the listing by extension where the host has a dialog to narrow. */
  pickFile(options?: { multiple?: boolean; filters?: FileDialogFilter[] }): Promise<string[] | null>
  /** Opens a native "choose a directory" dialog; null when cancelled. */
  pickDirectory(): Promise<string | null>
  /** Asks the shell to connect one non-local environment (spec 13). Main resolves the transport and stored credential; the renderer only names the target. */
  /**
   * Ask the user where to save, and resolve an absolute path or `null` for
   * cancelled — the same shape `fsSaveDialog` resolves.
   *
   * A host seam rather than a direct `shell.fsSaveDialog` call because the two
   * clients answer the question differently and neither answer is wrong:
   * Electron opens an OS dialog over the user's own filesystem, a browser
   * prompts for a path on the server whose files it is editing. Save-As is a
   * file operation, and file operations work on both clients; only the widget
   * that asks the question is native.
   */
  pickSavePath(defaultPath?: string, defaultFileName?: string, filters?: FileDialogFilter[]): Promise<{ filePath: string | null; error?: string }>

  /**
   * A renderable image source for a hostname's favicon, or `null`.
   *
   * Electron's renderer cannot fetch a third-party icon itself, so the main
   * process does it and returns a data URL. A browser page has no such
   * restriction: it can point an `<img>` straight at the origin's own
   * `/favicon.ico` and let the network layer do the work. Same question, two
   * legitimate answers -- which is exactly what a host seam is for.
   */
  faviconFor(hostname: string): Promise<string | null>

  connectEnvironment(environmentId: string, label: string, target: EnvironmentTarget): Promise<{ ok: boolean; error?: string }>
  /** Completes a pasted pairing link (spec 13): the host runs the key exchange and keeps the secret; the caller receives the `paired` catalog target to persist. */
  pairEnvironment(link: string, label?: string): Promise<{ ok: true; target: EnvironmentTarget } | { ok: false; error: string }>
  /** The SSH door: the host installs the Studio server on `destination` over ssh, tunnels to it, and pairs; the caller receives the `via: 'ssh'` target to persist. */
  sshAddEnvironment(destination: string, label?: string): Promise<SshAddEnvironmentResult>
  /** One bounded look at the LAN for Studio Servers that made themselves discoverable (Add Environment -> Nearby). */
  browseNearby(): Promise<NearbyStudioServer[]>
  /** Stage transitions and installer output while `sshAddEnvironment` runs. */
  onSshProgress(cb: (progress: SshAddEnvironmentProgress) => void): () => void
  /** Asks the shell to disconnect one environment's connection (no auto-retry until reconnected). */
  disconnectEnvironment(environmentId: string): void
  /** Asks the shell to re-arm the backoff ladder and reconnect immediately (manual Refresh/Restart). */
  restartEnvironment(environmentId: string): void
  /** Reads back one environment's cached last-welcome frame, or null when absent. */
  getEnvCache(environmentId: string): Promise<{ welcome: StudioFrame; cachedAt: number } | null>
  /** Requests `transfer.export` on `environmentId` for `tabId` and receives the archive into a local temp file (spec 15). */
  exportToFile(environmentId: string, tabId: string, targetEnvironmentId: string, options?: ExportFileOptions): Promise<ExportFileResult>
  /** Streams a local file to `environmentId`'s `transfer.import` and deletes it afterward, success or failure (spec 15). */
  importFromFile(environmentId: string, tabId: string, filePath: string, landing?: TransferLanding | null): Promise<ImportFileResult>
  /** Byte-level progress for every in-flight export/import, keyed by the source tab id (spec 15). */
  onTransferProgress(cb: (progress: TransferProgress) => void): () => void
  /** Abandons the in-flight export/import for `tabId`. Resolves to whether there was one to cancel. */
  cancelTransfer(tabId: string): Promise<boolean>
  /** Null on a host that cannot listen on its own machine (a browser tab). */
  portForward: PortForwardHost | null
}
