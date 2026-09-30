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
  // content, so a DOM popover cannot be layered over one; main hides the view
  // while a popover overlaps it and keeps its bounds, so the page never reflows.
  STUDIO_BROWSER_POPOVER_RECTS: "studio:browser-popover-rects",
  STUDIO_BROWSER_COMMAND_RESULT: "studio:browser-command-result",
  // Browser partitions are main-owned. These routes set a tab's browser
  // session policy and preview-network shield before the renderer remounts it.
  STUDIO_BROWSER_SET_SESSION_MODE: "studio:browser-set-session-mode",
  STUDIO_BROWSER_SET_NETWORK_SHIELD: "studio:browser-set-network-shield",
  // Find in page. The guest holds the search; main answers each request over
  // RESULT with the match ordinal and count as Chromium reports them.
  STUDIO_BROWSER_FIND: "studio:browser-find",
  STUDIO_BROWSER_FIND_RESULT: "studio:browser-find-result",
  // Page zoom for one document. Answered with the level that was applied.
  STUDIO_BROWSER_SET_ZOOM: "studio:browser-set-zoom",
  // Main -> renderer: a keyboard shortcut pressed INSIDE the guest that the
  // chrome must act on (focus the URL bar, open or close find). The guest
  // holds focus, so the renderer never sees the key itself.
  STUDIO_BROWSER_SHORTCUT: "studio:browser-shortcut",
  // A page asked for something only the operator can grant: a permission, an
  // HTTP login, or trust in a bad certificate. Main holds the request open and
  // the chrome answers it by promptId.
  STUDIO_BROWSER_PROMPT: "studio:browser-prompt",
  STUDIO_BROWSER_PROMPT_ANSWER: "studio:browser-prompt-answer",
} as const
