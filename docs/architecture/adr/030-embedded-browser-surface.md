---
title: Embedded Browser Surface
sidebar_position: 30
---

# ADR-030: Embedded Browser Surface

## Status

Accepted.

## Context

Ion Studio needs a browser document that an operator can inspect while an agent uses browser tools. The document must stay in the Studio window. It must keep its history and session data when the operator changes tabs or conversations.

A browser preview can load local HTML. Local HTML must not load network resources by default.

## Decision

The **Studio Browser Surface** is a Studio Surface tab. Its descriptor is stored with its conversation in `studioSurface`.

A browser descriptor contains its URL, content mode, and session mode:

- `preview` renders local preview content. The network shield blocks network requests by default.
- `browse` renders normal browser content.
- `isolated` uses one private session for the browser descriptor.
- `shared` uses one persistent session for the browser descriptor. This is the default for a new browse tab and for a legacy descriptor that has no session mode.

The renderer mounts browser documents for all conversations. It hides inactive documents with `display: none`. This keeps webview history and browser session data alive while the operator changes conversations.

The main process owns session partitions, network policy, and browser automation registration. The renderer can request a session-mode or shield change only through the typed preload bridge. The main process validates and applies the request before the renderer changes the descriptor.

The Desktop preference `browserPreviewNetworkShield` defaults to `true`. It applies the shield default to new and restored preview documents. A user can still allow network access for one preview from that preview's shield control.

## The browser body is a WebContentsView

The browser body is a main-process `WebContentsView`. It is not a `<webview>`
element, and this is not an implementation detail.

Chromium reports a `<webview>` to CDP as a target of type `webview`.
Playwright turns only `page`, `iframe`, and `frame` targets into objects, so a
webview guest never appears in `context.pages()`. A tool could find the target
id and still never attach. The first build shipped this way: every browser tool
failed at the attach step, while every unit test passed, because the tests
mocked the attach seam.

A `WebContentsView` is a real `page` target, so Playwright attaches to it
normally.

The cost is that the body is no longer part of the page. A view is painted by
the window, above all page content. So:

- The renderer draws an empty placeholder and reports its rectangle. Main puts
  the view over that rectangle. The renderer measures; main positions.
- Geometry is pushed whenever the layout changes. A view does not reflow with
  the page, so a resize, a splitter drag, or a dock opening must be forwarded
  or the body separates from its hole.
- Hiding is explicit. An inactive tab's view is hidden and moved off-screen,
  because a visible view would paint over the tab the user is looking at.
- Popovers hide the view. A menu, a context menu, or a tooltip is DOM, and a
  view is composited above the renderer — which is the window's own web
  contents — so DOM can never be layered over one.

  The view is hidden for exactly as long as a popover covers it, and its bounds
  never change, so the page does not reflow and it reappears showing what it
  showed. Hiding is scoped to real overlap: a tooltip elsewhere in the window
  leaves the browser alone.

  Three alternatives were measured against the running app and rejected.
  Shrinking the view reflows the page, because a view's size is its viewport.
  Pinning the viewport first still moves the content, because a smaller view
  renders from its own origin. The `viewport` clip on
  `setDeviceMetricsOverride` changes nothing the page can observe — layout,
  scroll, and element rects were identical with it — as it affects capture, not
  compositing.
- Chrome state comes from main. The URL bar and the back and forward buttons
  read the guest through events, because there is no element to ask.

Partitions, session modes, and the preview network block are unchanged. The
guest hardening is shared with the `<webview>` path, so the two cannot drift.

`desktop/scripts/verify-browser-cdp.mjs` checks a running app and fails if any
browser guest is a `webview` target. Unit tests cannot catch this class of
defect, because the seam that breaks is the one they mock.

## Browser automation

The Studio Browser Surface is also the surface an agent drives. Ion attaches
Playwright to Electron's own Chromium with `connectOverCDP` over a loopback
debugging endpoint. Playwright cannot launch this browser, because the browser
is the application.

The connection is shared by every conversation and starts when the first browser
guest registers. It starts at registration, not at the first tool call, so
Playwright's retained console and request history already covers the operator's
own browsing when an agent asks its first question.

Ion never closes this connection. `Browser.close()` over CDP asks the real
browser to exit. For Electron that ends the application.

### One Agent-linked tab for each conversation

Each conversation stores one `agentBrowserInstanceId` pointer. The pointer names
the single browser tab that browser tools may drive, or nothing.

A pointer is used instead of a flag on each descriptor. With one pointer, two
tabs cannot both claim the link.

The operator may keep any number of browser tabs. The first browser tab in a
conversation becomes the linked tab. Later tabs stay the operator's own. The
operator may move the link to any browser tab. The linked tab sorts ahead of the
other browser tabs.

When the linked tab closes, the pointer becomes empty. Ion does not move the
link to another open tab. A page that the operator prepared for their own use
must not become an agent target because a different tab closed. The next agent
browser call creates a new tab.

Persisted Surface state is version 3. Version 3 keeps an empty pointer. Version
2 has no pointer, so a version 2 record links its first browser tab once. This
difference is why the version number changed. Without it, every restart would
link a tab again after the operator unlinked it.

### Ownership of a tool call

A browser tool call carries no conversation, tab, or browser argument. The
tool-gate responder supplies the engine session key, the working directory, and
the call origin. Ion resolves the conversation's linked tab from the session key.

A model cannot address another conversation's browser. A model cannot address
the operator's other browser tabs. A change of the visible conversation during a
call does not change the target.

The conversation is required at every layer that carries it, and it is never
optional. An optional conversation would fall back to whatever is on screen,
which is the same defect as letting an agent name a conversation: the target
would depend on where the operator is looking.

### A background conversation is served like any other

An agent works in its own conversation whether or not the operator is looking at
it. Browser tabs are therefore addressed by conversation, not by what the Studio
window shows.

A tool call in a background conversation creates its tab, navigates it, emulates
it, and reads it. The tab does not become visible, the panel does not open, and
the operator's selected tab does not change. Every conversation's browser stays
mounted, so a background guest keeps running and loading; its placeholder is
collapsed, which the renderer reports as hidden, so the view never paints over
the shell. When the operator switches to that conversation, the work already done
is there.

Only two verbs touch the operator's view: the explicit reveal command, and the
operator's own action of handing the agent link to a different tab.

### Device emulation

`browser_resize` and `browser_emulate` apply CDP emulation to the exact visible
guest. `page.setViewportSize()` is not used, because it changes only Playwright's
view of a CDP-attached page. The visible tab would keep its old size, and the
agent and the operator would see different layouts.

The renderer then draws the guest inside a device frame at the requested CSS
size and scales the frame to fit. The page keeps the emulated viewport. Only the
presentation is scaled.

Emulation state is stored on the browser descriptor. Guest registration carries
it, so a restored or recreated guest is emulated again before its first tool
call.

### Clicked links

A web link that the user ⌘-clicks opens in a new Studio browser tab. This works
in the conversation transcript, in a terminal pane, and inside a page that is
already in a browser tab.

A plain click still opens the default browser. The modifier is required, because
the embedded browser must not silently become the target for every link the user
clicks. Only `http` and `https` route inward. Other schemes belong to the
operating system.

⌥⌘-click is the escape. It sends the link to the user's own browser from every
surface, including a page that is already inside a browser tab. Some links need
a real browser, for a password manager, a signed-in profile, or an extension,
and the user must be able to reach one without hunting for a menu.

Inside a browser guest this needs more than the window-open request. Blink maps
⌘-click and ⌥⌘-click to the same navigation policy, so Electron reports the same
disposition for both and the Option key never arrives. Ion therefore records the
modifier from the guest's raw input events and reads it back when the open
request arrives, matched by time and consumed once. When no recent record
exists, the link opens in a Surface tab. That direction is recoverable: a missed
Option opens a tab the user can close, while a false Option would send a page to
their browser without being asked.

Each click opens a new tab. Ion does not reuse one tab, because that would
destroy the page the link came from.

The decision is one helper for every surface. It uses the same content-router
seam as file opening, so the Overlay sends every link to the operating system
without a test for which window is active.

A link ⌘-clicked inside a browser guest reaches the main process as a new-tab
request. The webview policy still refuses it as a popup, because a browser tab
holds one document. The policy then asks Studio to open a tab, so the click is
not lost.

### Diagnostics

Console history, page errors, and network history are live runtime data. Ion does
not write them to disk.

Console messages and page errors come from Playwright's retained buffers, which
support the whole session or the current navigation. Network history comes from
request events. `page.requests()` is not used, because it has no navigation
filter and its entries may be collected.

Request and response bodies are read only when an agent asks for one request.
Credential headers, cookies, and token query parameters are removed before
output. No header or body is written to the desktop log.

### Origin policy

The engine reports whether a client tool call came from the model or from
extension code. A model may increase isolation for a browser tab. A model may
not return an isolated tab to the shared session, and may not move the agent
link. Extension code may do both.

### Availability

The Desktop preference `studioPlaywrightEnabled` defaults to `true`. Browser
tools are advertised when Studio is the active interface and the preference is
on.

A change to the preference or the active interface re-asserts each live
session's `start_session`. This replaces the tool list for later runs. A run
that is already in flight keeps the list it captured. Ion never stops or
restarts a conversation to change a tool list.

Turning the preference off removes the tools only. Browser tabs, sessions,
logins, emulation state, and recorded diagnostics stay as they are.

## Consequences

Browser state is durable at the descriptor level and live at the webview level. A restored browser retains its URL and session mode. A mounted browser retains its current history until it is closed.

The browser is a Studio-only surface. It does not project to iOS.

An agent and an operator share one visible page. The operator sees every agent
action as it happens.

Ion depends on `playwright-core` and on stable CDP domains. Ion does not depend
on the Playwright MCP server, and does not install browser binaries.

## References

- [Desktop Architecture](../desktop.md)
- [Studio Browser Surface](../../vocabulary/index.md#term-studio-browser-surface)
- [Studio shell mirror store](021-studio-shell-mirror-store.md)
