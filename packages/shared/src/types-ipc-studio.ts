// IPC channel names for the Ion Studio secondary floating window and the
// startup splash. Split out of types-ipc.ts to stay under the file-size cap,
// following the same pattern as types-ipc-browser.ts / types-ipc-system.ts.

export const STUDIO_WINDOW_IPC = {
  // Ion Studio (Studio) — secondary floating window
  STUDIO_ACTIVE_TAB: "studio:active-tab",
  // Main → Studio: open a terminal-owned Web Application in the owning
  // Conversation's Studio Surface after main validated its live ownership.
  STUDIO_OPEN_WEB_APPLICATION: "studio:open-web-application",
  // Main → Studio push: title-bar geometry changes with native fullscreen.
  STUDIO_WINDOW_CHROME: "studio:window-chrome",
  // Studio → main: update non-macOS native window-control overlay colors.
  STUDIO_SET_TITLE_BAR_OVERLAY: "studio:set-title-bar-overlay",
  // Main → overlay renderer push: the Studio window opened/closed (drives the
  // launcher button's active indicator).
  // Per-principal tab-metadata snapshot, a studio_event channel every client
  // hydrates from (`studio:tabs-sync` in studio-wire/channels.ts).
  STUDIO_TABS_SYNC: "studio:tabs-sync",
  // Worktree inventory + bench snapshot, the same way.
  STUDIO_WORKTREE_SYNC: "studio:worktree-sync",
  // Main → Studio push: a permission was answered on SOME surface (overlay,
  // iOS, or Studio) — clear it from the mirror queue and the canvas bubble.
  STUDIO_PERMISSION_RESOLVED: "studio:permission-resolved",
  // Studio → main: save a composed office snapshot PNG via the save dialog.
  STUDIO_EXPORT_IMAGE: "studio:export-image",
  // Studio → main: live per-tab summaries for the campus view.
  // Studio → main: save a recorded office clip (webm) via the save dialog.
  STUDIO_EXPORT_VIDEO: "studio:export-video",
  // Main → Studio push: a user prompt was submitted (any surface) — the mirror
  // inserts it so its transcript matches the owner's optimistic insert.
  STUDIO_USER_MESSAGE_ECHO: "studio:user-message-echo",
  // Main → Studio push: a successful engine rewind committed a NEW message
  // list for one instance. The mirror replaces the pane instance's messages
  // wholesale — never merges — mirroring desktop_conversation_history's
  // replace semantics on the iOS wire. Fired only after the engine confirmed
  // the branch succeeded (transactional rewind); the mirror's stale tail is
  // never preserved past a successful owner branch.
  STUDIO_HISTORY_REPLACE: "studio:history-replace",
  // Startup splash: renderer reports go through main, which owns monotonic
  // startup state and reveals exactly one product window after full hydration.
  STARTUP_REPORT: "startup:report",
  STARTUP_GET_STATE: "startup:get-state",
  STARTUP_STATE: "startup:state",
  STARTUP_AUTHENTICATE: "startup:authenticate",
  STARTUP_CANCEL_AUTHENTICATION: "startup:cancel-authentication",
  STARTUP_RELAUNCH: "startup:relaunch",
  STARTUP_QUIT: "startup:quit",
  // Studio wire transport bridge (spec 12): main owns one connection per
  // environment (local/tcp/relay) and relays every studio-wire frame to the
  // renderer UNCHANGED. Main never interprets an action payload.
  //   STUDIO_FRAME: main -> renderer, { environmentId, frame }, a frame the
  //     broker received from a server.
  //   STUDIO_SEND: renderer -> main, { environmentId, frame }, a frame to
  //     relay to a server unchanged.
  //   STUDIO_CONNECTIONS: main -> renderer, ConnectionPhaseSnapshot[], pushed
  //     on every phase transition and once on subscribe.
  STUDIO_FRAME: "studio:frame",
  STUDIO_SEND: "studio:send",
  STUDIO_CONNECTIONS: "studio:connections",
  // StudioHost shell capabilities that stay on the shell side (spec 12): a
  // generic file picker (no existing IPC channel covers it — SELECT_DIRECTORY
  // and SELECT_EXTENSION_FILES are each scoped to one caller) and the
  // desktop.json device-settings store, read/written through the host rather
  // than the Studio wire.
  STUDIO_PICK_FILE: "studio:pick-file",
  STUDIO_DEVICE_SETTINGS_GET: "studio:device-settings-get",
  STUDIO_DEVICE_SETTINGS_SET: "studio:device-settings-set",
  // Environment registry driver (spec 13): the renderer's registry decides
  // WHEN to attempt a connection (boot, retry schedule, manual refresh);
  // main's broker owns the actual transport. `HOST_CONNECT_ENVIRONMENT`
  // carries everything the broker's per-attempt `ConnectionTarget.open()`
  // needs to pick local/tcp/relay and to build the `studio_hello` credential
  // — main resolves the stored secret/token from `connections/credentials.ts`
  // by `environmentId`, never over this channel.
  HOST_CONNECT_ENVIRONMENT: "studio:host-connect-environment",
  // Pairing-link completion (spec 13 add-environment flow, manifest C6/C9):
  // the renderer hands main the pasted `ion-studio://pair?...` link; main
  // runs the X25519 exchange against the server's `POST /auth/pair`, stores
  // the shared secret + clientId under the server's environment id, and
  // returns the `paired` catalog target. The secret never reaches the renderer.
  HOST_PAIR_ENVIRONMENT: "studio:host-pair-environment",
  // SSH door (Add Environment -> SSH): main installs the Studio server on
  // the host over ssh, opens a loopback port forward to it, pairs itself
  // through that forward, and returns the `paired` target with
  // `via: 'ssh'`. HOST_SSH_PROGRESS streams the stages and installer lines
  // to the dialog while HOST_SSH_ADD_ENVIRONMENT is in flight.
  HOST_SSH_ADD_ENVIRONMENT: "studio:host-ssh-add-environment",
  // Add Environment -> Nearby: one bounded mDNS browse for Studio Servers.
  HOST_BROWSE_NEARBY: "studio:host-browse-nearby",
  HOST_SSH_PROGRESS: "studio:host-ssh-progress",
  HOST_DISCONNECT_ENVIRONMENT: "studio:host-disconnect-environment",
  HOST_FORGET_ENVIRONMENT: "studio:host-forget-environment",
  // The Fleet page: run the bundled `ion fleet` on this device (a deploy
  // from source, the one-time move of an old fleet file's hosts), with each
  // line it prints pushed on HOST_FLEET_PROGRESS.
  HOST_FLEET_RUN: "studio:host-fleet-run",
  HOST_FLEET_CANCEL: "studio:host-fleet-cancel",
  HOST_FLEET_PROGRESS: "studio:host-fleet-progress",
  // The deploys this desktop started and still remembers, with their logs.
  HOST_FLEET_RUNS: "studio:host-fleet-runs",
  // The Environment catalog changed on disk by another process (`ion fleet`).
  HOST_CATALOG_CHANGED: "studio:host-catalog-changed",
  HOST_RESTART_ENVIRONMENT: "studio:host-restart-environment",
  // Main-owned env-cache read (spec 13): the last welcome frame verbatim,
  // used to hydrate the mirror read-only when an environment is offline.
  HOST_GET_ENV_CACHE: "studio:host-get-env-cache",
  // Desktop Transfer verb (spec 15): main owns the export/import orchestration
  // over the broker's binary channel (spec 07/12); these three channels are
  // the renderer's whole surface onto it. HOST_TRANSFER_EXPORT_TO_FILE and
  // HOST_TRANSFER_IMPORT_FROM_FILE each resolve once their whole operation
  // completes; HOST_TRANSFER_PROGRESS streams byte-level progress in between,
  // keyed by the source tab id; HOST_TRANSFER_CANCEL abandons whichever of
  // the two is in flight for a tab (see `main/connections/transfer.ts`).
  HOST_TRANSFER_EXPORT_TO_FILE: "studio:host-transfer-export-to-file",
  HOST_TRANSFER_IMPORT_FROM_FILE: "studio:host-transfer-import-from-file",
  HOST_TRANSFER_PROGRESS: "studio:host-transfer-progress",
  HOST_TRANSFER_CANCEL: "studio:host-transfer-cancel",
  // Port Forward (`main/connections/port-forward.ts`): main listens on a
  // loopback port of this machine and carries each connection to a port on an
  // Environment's host over that Environment's Studio connection.
  // HOST_PORT_FORWARD_START and _STOP name one remote port; HOST_PORT_FORWARDS
  // is the full list, both as an invoke and as a push on every change.
  HOST_PORT_FORWARD_START: "studio:host-port-forward-start",
  HOST_PORT_FORWARD_STOP: "studio:host-port-forward-stop",
  HOST_PORT_FORWARDS: "studio:host-port-forwards",
} as const;
