/**
 * Studio browser IPC channel names.
 *
 * Split out of `types-ipc.ts` to keep that registry under the size cap. These
 * are one cohesive group: everything the Studio browser surface needs to exist
 * (guest registration, view geometry, navigation, session policy) plus the two
 * correlated command channels the automation runtime drives.
 *
 * The geometry channels exist because a browser tab body is a main-process
 * `WebContentsView`, not a DOM element — Playwright cannot attach to a
 * `<webview>` target, so the body had to leave the DOM. The renderer measures
 * where the body belongs and main positions the view there.
 */
export const STUDIO_BROWSER_IPC = {
  // Studio browser preview: lift the offline block for one preview
  // partition (explicit per-tab confirm — D6).
  STUDIO_PREVIEW_ALLOW_NETWORK: "studio:preview-allow-network",
  // A Studio renderer registers each ready guest with its durable owner. Main
  // validates the guest and host before browser automation can resolve it.
  STUDIO_REGISTER_BROWSER: "studio:register-browser",
  // The browser body is a main-process WebContentsView, not a DOM element, so
  // the renderer measures where it belongs and main positions it there.
  STUDIO_BROWSER_VIEW_ENSURE: "studio:browser-view-ensure",
  STUDIO_BROWSER_VIEW_BOUNDS: "studio:browser-view-bounds",
  STUDIO_BROWSER_VIEW_NAVIGATE: "studio:browser-view-navigate",
  STUDIO_BROWSER_VIEW_ACTION: "studio:browser-view-action",
  STUDIO_BROWSER_VIEW_CLOSE: "studio:browser-view-close",
  // Main -> renderer: the guest navigated or retitled itself.
  STUDIO_BROWSER_VIEW_STATE: "studio:browser-view-state",
  // Correlated main -> Studio browser commands; answered on RESULT by callId.
  STUDIO_BROWSER_COMMAND: "studio:browser-command",
  // One-way: a link cmd-clicked inside a browser guest, reopened as a tab.
  STUDIO_BROWSER_OPEN_URL: "studio:browser-open-url",
  // Where the on-screen popovers are. A WebContentsView paints above all page
  // content, so a DOM popover cannot be layered over one; the view is shrunk
  // out from under the popover instead of being hidden entirely.
  STUDIO_BROWSER_POPOVER_RECTS: "studio:browser-popover-rects",
  STUDIO_BROWSER_COMMAND_RESULT: "studio:browser-command-result",
  // Browser partitions are main-owned. These routes set a tab's browser
  // session policy and preview-network shield before the renderer remounts it.
  STUDIO_BROWSER_SET_SESSION_MODE: "studio:browser-set-session-mode",
  STUDIO_BROWSER_SET_NETWORK_SHIELD: "studio:browser-set-network-shield",
} as const
