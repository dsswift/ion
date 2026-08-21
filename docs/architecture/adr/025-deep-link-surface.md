# ADR-025: The `ion://` deep-link surface

**Status:** Accepted
**Date:** 2026-07-26

## Context

`dev run` (the `dev.yaml` orchestrator) launches host-tier services into terminals, choosing the terminal application from a user setting: Terminal.app, iTerm, or VS Code via `vscode://open.in-terminal`. Ion Desktop was not an option, so an operator whose daily driver is Ion had services landing in VS Code — an application they may not even have installed.

The requirement is not merely "add Ion to that list". Services are launched and then read *later*, so a pane must land in the conversation whose terminal issued the command **even after the operator has navigated to a different conversation**. A mechanism that resolves the target from what is currently focused fails exactly when it matters.

Two properties of the existing desktop made this tractable. Terminal PTYs are owned by the Electron **main** process (`main/terminal-manager.ts`, keyed `"<tabId>:<instanceId>"`) with the renderer's xterm acting as a viewer, so a pane can be created and stream output while its tab has never been mounted — the iOS `desktop_terminal_add_instance` path already did this. And `getCliEnv(extra)` already accepted an environment overlay, so per-PTY identity had somewhere to live.

Two pre-existing defects on that same path had to be fixed for it to be usable: main-process scrollback never reached the renderer on first mount (so arriving at a background pane showed an empty terminal for a service that had been logging for minutes), and the create path never marked the pane open (so the panel did not render an instance until the terminal was manually toggled).

## Decision

### 1. A general URL-scheme surface, not a single-purpose hook

Register `ion://` and route every request through one dispatcher with a small action registry. Terminal-pane creation is the first action; prompt launch is the second. Adding a third is a new action on an existing mechanism, not a new mechanism.

### 2. Two transports, normalized before any action runs

| Transport | Shape | For |
|---|---|---|
| Inline | `ion://terminal?tabId=…&title=api&cmd=…` | The common case. What `dev` emits. |
| Handoff file | `ion://terminal?req=<uuid>`, payload at `~/.ion/deeplink-requests/<uuid>.json` (0600) | Payloads too large for a URL (a multi-paragraph prompt), and anything that must stay out of the OS's opened-URL logging. |

Discrimination is whether `req` is present. Both resolve to the same in-memory request before dispatch, so **each action is implemented once** and gains both transports for free. Handoff files are one-shot (read, then deleted — including on every failure path, so a bad write cannot accumulate or be replayed) and are refused when stale, oversized, or not 0600.

### 3. Trust is a capability token, and the untrusted path asks a human

`~/.ion/deeplink.token`, 0600, minted on first run.

- **Valid token → execute.** A local process can read the file. It could already spawn any command as this user, so the token grants it nothing new; it is an identity check, not a privilege grant.
- **No or wrong token → describe the request and wait for the operator.** A web page cannot read a local 0600 file, so a published link can never carry a valid token.

Both directions are required. Refusing untrusted links outright would kill the shareable-prompt use case (an internal wiki publishing "open this repo and ask this"); executing them silently is the `vscode://` hole, where a page runs a command on one click. The confirmation dialog shows the **actual** command or prompt text, because a dialog that hides what it is authorising trains people to approve without reading, which is worse than no dialog.

Every failure to obtain an answer resolves to "declined": no window, a timeout, or a window that closes mid-decision.

### 4. Conversation identity travels in the PTY environment

Every terminal PTY spawns with `ION_DESKTOP_TAB_ID`, `ION_DESKTOP_TERMINAL_INSTANCE_ID`, and `ION_DESKTOP_DEEPLINK_TOKEN`. Descendants inherit them, so a tool at any depth names its own conversation, and a pane it spawns carries its own ids in turn.

### 5. Target resolution never falls back to the active tab

Three outcomes, no fourth:

- `tabId` names a live tab → the pane opens there.
- `tabId` names a dead tab → **refused**, with an operator-facing reason.
- `tabId` absent → **refused** on the trusted path; the untrusted path shows a live-conversation chooser before it may proceed.

Silently retargeting the active tab is the specific failure this surface exists to prevent. A pane opening in a background conversation does not steal focus: `activeTabId` is untouched.

## Rejected alternatives

**A shipped `ion-term` CLI.** `desktop/build/afterPack.js` hand-codesigns exactly one extra payload today and warns-and-returns when it is missing. A second binary would add an `extraResources` entry, a second `codesign` plus `xattr`, install-copy logic in `engine-bootstrap.ts` (which sha256-compares one binary), and carriage through `scripts/build-pkg.sh` — several new places for an artifact to go missing or ship unsigned, in exchange for opening a pane.

**A Unix socket that `dev` dials in Go.** `dev` is project-agnostic and runs across organisations. Its VS Code mode is a URI builder that knows nothing of VS Code's internals; making it carry a hand-written client for one developer's desktop protocol inverts that. A socket would also give no way to launch Ion when it is not running.

**An OSC escape sequence parsed out of the PTY stream.** Needs no new file or auth surface, but puts a stateful parser on the hottest byte path in the application and cannot return an error to the caller.

## Consequences

- `ion://` is a published surface. Third parties (including a SharePoint page) can author links; the token boundary is what makes that safe, and the confirmation dialog is what makes it legible.
- The single-instance lock became mandatory. `open ion://…` launches Ion, so without the lock a click while Ion was running would start a second full instance — two engine bootstraps, two tab stores, two windows over the same files. It was absent before this change.
- Cold-launch requests queue until the renderer store exists, because every action drives store actions.
- `dev` gains one mode and no dependency on Ion. Anything that can open a URI is now a client.

## Verification

Automated coverage spans parsing (unknown actions, over-long fields, newline injection, non-UUID handoff ids), the handoff-file lifecycle (delete-on-read, staleness, permissive-mode refusal), the confirmation lifecycle (both answers plus every fail-closed path), and the dispatcher and terminal action (both directions of the trust gate, dead-tab and no-tab refusal, labelling). The `dev` suite covers URI construction, environment forwarding, and shell-metacharacter round trips. The two regression suites for the pre-existing defects were each confirmed red before their fixes.

## References

- [ADR-008](008-wire-event-naming-and-ownership.md) — the `desktop_` prefix convention the confirmation IPC follows.
- [ADR-021](021-studio-shell-mirror-store.md) — why the confirmation request is broadcast rather than sent directly to one window.
- [`docs/configuration/deep-links.md`](../../configuration/deep-links.md) — the action reference for link authors.
