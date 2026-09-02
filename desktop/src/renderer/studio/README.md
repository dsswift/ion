# Ion Studio shell

One of the Desktop client's **two presentations**. The Overlay (`index.html`) is
the glass window and the session-store owner; the Studio (`studio.html`) is a
standalone workspace window that runs the same store in mirror mode. Exactly one
presentation is active at a time. They are presentations of one client, never two
clients.

The Studio wraps the Overlay's own chrome around a conversation-centric
workspace, with the pixel-art office canvas as one surface inside it. Read
[ADR-021](../../../../docs/architecture/adr/021-studio-shell-mirror-store.md)
before changing anything here. Canonical names for the regions below live in the
[Ion Vocabulary](../../../../docs/vocabulary/index.md).

| Piece | Where |
|---|---|
| Layout root (mirror boot, panes, keymap, palette) | `StudioShell.tsx` |
| Studio Left Dock (inbox / explorer / git views) | `StudioLeftSidebar.tsx`, `inbox/` |
| Studio Center (conversation, composer, dispatch split, bottom terminal) | `StudioCenter.tsx`, `DispatchSplitPane.tsx` |
| Studio Surface (conversation-specific tabs plus global pinned diff/plan/visualizer and Notification tabs) | `StudioSurface.tsx`, `surface/` |
| Pane geometry plus conversation-keyed surface persistence | `layout/useStudioLayout.ts`, `surface/surface-store.ts` |
| Keymap (fixed defaults, focus contexts, capture phase) | `keymap/` |
| Studio Title Bar (breadcrumb, compose, pane controls) | `StudioTitleBar.tsx`, `chrome/` |
| Visualizer Canvas (engine host, tooltips, toolbar) | `visualizer/VisualizerRoot.tsx` |
| Mirror store boot + owner sync | `state/secondary-store.ts`, `state/hydrate-tabs.ts` |
| Action classification (parity mechanism 2) | `../../shared/studio-mirror-actions.ts` + `state/__tests__/mirror-parity.test.ts` |
| Telemetry (odometers/dashboards/export) | `visualizer/state/stats.ts` |
| Replay ring | `visualizer/state/recorder.ts` |
| Sim / render / overlays | `visualizer/engine/` (`scene-fx.ts`, `render-overlays.ts` for new passes) |
| Procedural office generation | `visualizer/generation/` (seeded PRNG only — no Date.now/Math.random) |
| Theme packs | `visualizer/theme/` + `desktop/resources/studio/themes/` |

Rules that bite:
- New store action? Classify it in `studio-mirror-actions.ts` or the parity test fails.
- New main-process event push? Route through `broadcast()` or `make check-studio-parity` fails.
- Workspace controls read `worktreeOperations` and `worktreePipeline` from the mirrored store. Do not create local busy flags or local refresh loops. The operation ledger is the source of truth for pending work and locks in both presentations.
- A recovered bench conflict keeps its returned bench directory and opens the shared `ConflictsDialog`. Successful Abort and Continue report completion through `completeConflictOperation(directory, verb)` so all controls release together.
- New shared surface? Mount the Overlay's component on the mirror store — never build a bespoke Studio widget for something the Overlay already has.
- New shared concept? Add it to `docs/vocabulary/terms.json`, then run `make generate-vocabulary` and `make check-vocabulary`. A Studio-only region carries a Studio-qualified name.
- Surface state belongs to its conversation, except for unsaved Scratch Documents. Browser guests stay mounted for every conversation, so navigation state survives a conversation change. Normal file tabs remain conversation-scoped. A Scratch Document is keyed by the source project and appears in every matching conversation, including the source checkout and its worktrees, until the operator saves or discards it. Save removes the project-scoped Scratch Document and opens the saved path as a normal file tab in the active conversation. Browse tabs use the shared Studio session by default. A private tab uses `studio-isolated-<instanceId>`. Only Diff, Plan, and Visualizer can be global user pins. A workspace Notification is a separate global slot that follows every conversation until close. Panel geometry stays global, while visibility can follow the current surface or restore per conversation.
- Browser tabs are addressed BY conversation, never by what the window shows: an agent in a background conversation opens and drives its own tab with no context switch, and without stealing the operator's selection or opening the panel. `updateConversationById` is the addressed write; the store's `ensureAgentBrowser`/`agentBrowser`/`setBrowserEmulation` all take the conversation as a REQUIRED first argument so no path can omit it and land on the visible conversation by accident. The conversation itself is never a tool argument — it comes from the engine session key.
- Each conversation stores one `agentBrowserInstanceId`. It names the single browser tab that agent browser tools may drive, or nothing. The first browser tab in a conversation takes the link; later tabs stay the operator's own; the operator can move it from the tab strip, and the linked tab sorts ahead of the other browser tabs. Closing the linked tab leaves the pointer empty rather than moving the link to another open page.
- The Playwright runtime lives in the main process, but Surface descriptors live here. So main asks this window to create, close, reveal, or re-emulate the agent's tab through a correlated command channel, and the handler answers each command exactly once (`surface/studio-browser-commands.ts`).
- A ⌘-clicked (or Ctrl-clicked) web link opens in a NEW Surface browser tab, from the conversation transcript, a terminal pane, or a page already inside a browser tab. One helper decides this for every surface (`lib/open-link.ts`) and it routes through the same content-router seam as file opens, so the Overlay — which registers no router — keeps sending every link to the operating system browser with no window-role branch anywhere. A plain click always goes to the default browser; only http(s) routes inward. ⌥⌘-click is the escape hatch and sends the link to the operator's own browser from every surface, including inside a guest — there it needs the modifier captured from the guest's raw input events, because Blink gives ⌘-click and ⌥⌘-click the same disposition and the Option key never reaches the window-open handler. A link cmd-clicked inside a guest arrives in main as a new-tab disposition, which the webview policy still denies as a popup and forwards to Studio as a tab request instead of dropping.
- `browser_handle_dialog` arms the answer for the NEXT dialog rather than acting on one already open: a JavaScript dialog blocks the page, so the click that triggers it cannot return first, and Playwright auto-dismisses any dialog with no handler attached. Arm, then click.
- A `WebContentsView` paints above ALL page content, so no DOM popover can be stacked over a browser tab however high its z-index. `PopoverLayerProvider` reports each portaled popover's RECTANGLE and main hides any view they overlap (`setPopoverRects`) without changing its bounds, so the page never reflows and reappears unchanged. Trimming the view instead resizes its viewport and visibly moves the page; the CDP `viewport` clip does not help, since it affects capture rather than compositing. Rectangles, not a count: hiding the view fixes the layering but blanks the whole page behind a small menu. Nothing per-popover is needed; dozens of components portal into that layer and none should have to know a browser exists.
- A browser tab's BODY is a main-process `WebContentsView`, not a `<webview>` element: Chromium reports a webview as a CDP target of type `webview`, which Playwright never converts into a page, so no browser tool could attach to one. `BrowserSurface` therefore renders a measured placeholder and reports its rect; main positions the view over it, and pushes navigation state back for the URL bar. Closing a browser tab must destroy the view (`studioBrowserViewClose`) or the guest keeps running.
- An emulated browser tab renders inside a device frame at its exact CSS size, scaled to fit the panel. The page keeps the emulated viewport; only the presentation scales. Emulation state rides the descriptor and is re-sent on guest registration, so a restored or recreated guest comes back on the same viewport.
- The Conversation Terminal Panel is owner-controlled and mirrored between Overlay and Studio. Both presentations show the same terminal IDs and attach to the same main-owned PTYs. Studio Surface terminals remain separate `<conversationId>:surface:<instanceId>` sessions and are never deep-link targets.
