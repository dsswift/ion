# Plan — `coding/` headless host + multi-peer desktop + session transfer

> Status: Proposed. This document is the planning artifact for adding a new `coding/` top-level component. It is not yet implemented; review and revise before execution.

## Context

Today, Ion's "coding tool" runs as the desktop Electron app on the user's laptop. The iOS app is a thin client that reaches the desktop through the relay. The relay (already deployed in a Kubernetes cluster) bridges mobile↔desktop when off-network, but the desktop laptop must be open and running for any remote coding to happen.

The user wants a new top-level component, `coding/`, that runs the same coding-tool surface in a headless container — deployable in their on-prem k8s cluster (and equally to AKS / EKS / GKE / docker-compose / single-host docker, with no provider lock-in). The iOS app will see a paired headless pod as just another peer. The desktop also grows multi-peer awareness so it can drive a paired pod and render its tabs alongside its own, with a "transfer session" feature that hands off a conversation between hosts and decommissions the source so no duplicate work happens in two places.

The engine stays zero-opinion (per `engine/AGENTS.md`) — the new component is a peer to engine/desktop/relay/ios, not built on the harness extension layer.

## Architectural decisions

1. **`coding/` is a top-level peer** to engine/desktop/relay/ios. Both the Electron desktop and the new headless host import the same TypeScript code from this package — single implementation of the coding-tool semantics, two deployment shapes.
2. **Pod contract is provider-neutral** — only env vars + filesystem mount paths. Operator decides how to satisfy them (K8s Secret, AKV CSI driver, AWS SM CSI, sealed-secrets, plain `docker -v`). Bootstrap CLI generates a token and prints recipes; it does not link any cloud SDK.
3. **Pairing reuses existing X25519/HKDF crypto.** A high-entropy bootstrap token replaces the 6-digit code. iOS proves knowledge via HMAC during the handshake (`HMAC(token, nonce ‖ iosPubKey)`). Desktop dials a pod's relay channel as `role=mobile` — symmetric to how iOS dials the desktop today, **so the relay needs no changes**.
4. **State ownership inversion is required first.** `desktop/src/main/remote/handlers/*.ts` and `snapshot.ts` make 25+ `webContents.executeJavaScript` calls reading renderer-resident tab/buffer/instance state. The headless host has no renderer; this state must be relocated to a main-process registry before any extraction.
5. **Path translation = system note + engine `PathRewrites` map.** Engine `SessionConfig` grows an additive optional `PathRewrites map[string]string` field (contract-stable per `AGENTS.md`). Tools (Read/Edit/Glob/Grep/Bash) consult it at execution time to rewrite absolute paths from the source root onto the destination root. A system note is also injected into the loaded conversation explaining the relocation. Mechanical rewriting in the tool layer; not a policy change — engine stays zero-opinion.
6. **Transfer = two-phase commit with destination-wins reconciliation.** Source closes its tab AND stops the engine session only after destination acks. Idempotent via persistent `transferId`. If source crashes mid-flight, on restart it sees the destination already owns the conversation.
7. **Full multi-peer desktop in this milestone.** Tab strip groups by peer with host badges; outbound `RemoteCommand`s route by `peerId`. Wire format gains an additive `peerId` envelope field (non-breaking).
8. **Agent tabs only for v1 transfer.** Terminal tabs and engine-CLI tabs excluded — live PTY processes can't be transferred meaningfully.
9. **File-cap pre-decomposition.** Several files in `desktop/src/main/remote/` are within 100–200 lines of the 600 cap and will exceed it during extraction (peer-id plumbing, dual-role pairing). Pre-split them before extraction.

## Phases

### Phase 0 — Repo scaffolding (no code moves)
- Create `coding/` directory: `package.json`, `AGENTS.md`, `README.md`, `VERSION`, `tsconfig.json`, `Dockerfile` skeleton.
- Add `coding` to commit scopes: `.commit.json` (currently lists engine/desktop/relay/ios/docs/repo).
- Update root `AGENTS.md`:
  - Layout table: add `coding` row (path `coding/`, language TypeScript).
  - File-size caps table: include coding (TS 600 cap).
  - Quality gates table: add `coding` lint/typecheck/test.
  - Layered architecture: clarify `coding/` is a peer to desktop, not a harness extension; both desktop and `coding-host` consume the same package.
- Update `desktop/AGENTS.md` to note that coding-tool semantics live in `coding/` and the desktop is the Electron shell over them.

### Phase 1 — Pre-decomp god-leaning files (desktop-only, no behavior change)
Pre-split the following so peer-id and dual-role plumbing in later phases doesn't push them over the cap:
- `desktop/src/main/remote/transport.ts` (565) → `transport.ts` (router) + `incoming-peer.ts` (today's behavior) + skeleton `outgoing-peer.ts` (placeholder).
- `desktop/src/main/remote/handlers/tabs.ts` (397) → `tabs.ts` (router) + `tabs-create.ts` + `tabs-lifecycle.ts` + `tabs-groups.ts`.
- `desktop/src/main/engine-bridge.ts` (469) → `engine-bridge.ts` (control) + `engine-bridge-events.ts` (event pump).
- `desktop/src/main/session-meta.ts` (434) → `session-meta.ts` (read) + `session-meta-format.ts` (formatting).
- `desktop/src/main/remote/lan-server.ts` (386) → review; only split if cap pressure exists post-extraction.

Verify `npm run typecheck`, `npm test`, `make check-file-sizes` after each split.

### Phase 2 — Invert tab/state ownership in desktop main
**The structural blocker.** Renderer must stop being source of truth for tab/session/buffer state.

- New `desktop/src/main/tab-registry.ts`: owns tabs, groups, buffers, engine instance IDs, message metadata. Authoritative. Persisted via existing `atomicWrite` patterns.
- Migrate every `state.mainWindow.webContents.executeJavaScript('return store.getState().X')` call site:
  - `remote/handlers/engine.ts` (12 sites)
  - `remote/handlers/tabs.ts` (6 sites)
  - `remote/handlers/terminal.ts` (4 sites)
  - `remote/handlers/history.ts` (2 sites)
  - `remote/snapshot.ts` (1 site)
  - All become `tabRegistry.getX(...)` synchronous reads.
- Renderer `sessionStore` becomes a subscriber: receives state diffs from main via existing IPC `broadcast` channel, no longer mutated directly by tab actions originating in main.
- Renderer-originated mutations (user clicks "new tab") flow through IPC `tab:create` to main, which mutates the registry and broadcasts the resulting state.
- Critical files: `desktop/src/main/state.ts`, `desktop/src/main/broadcast.ts`, `desktop/src/main/event-wiring.ts`, `desktop/src/renderer/stores/sessionStore.ts`, `desktop/src/renderer/App.tsx`.
- Verification: full smoke (open tabs, switch tabs, engine prompt, terminal, git panel, pair iOS, exercise every `RemoteCommand` from iOS) — no UX regressions. Tests + typecheck green.

### Phase 3 — Extract `coding/` package
Move files (now portable thanks to Phase 2). No behavior change for the desktop user.

**Move to `coding/src/`:**
| From `desktop/src/main/` | To `coding/src/` |
|---|---|
| `engine-bridge.ts`, `engine-bridge-events.ts` | `engine/` |
| `engine-control-plane.ts`, `engine-control-plane-events.ts` | `engine/` |
| `terminal-manager.ts`, `terminal-manager-instance.ts` | `terminal/` |
| `git-runner.ts` | `git/` |
| `session-meta.ts`, `session-meta-format.ts` | `session/` |
| `settings-store.ts` | `session/` |
| `feature-flags.ts`, `cli-env.ts`, `utils/atomicWrite.ts` | `util/` |
| `cli-compat/*` | `cli-compat/` |
| `tab-registry.ts` (from Phase 2) | `state/` |
| `remote/*` (everything except handlers that will gain new variants) | `remote/` |
| `remote/handlers/{engine,git,history,tabs,terminal}.ts` | `remote/handlers/` |

**Define interfaces in `coding/src/`:**
- `Notifier` — replaces `webContents.send`. Methods like `notify(channel, payload)`. Electron impl in `desktop/`; headless impl is a no-op (or structured-log emitter).
- `SecretStore` — replaces `safeStorage`. `encrypt/decrypt` for the relay API key + paired-device shared secrets. Electron impl wraps `safeStorage`; headless impl reads a key derived from the bootstrap token.
- `Paths` — abstracts `app.getPath('userData')` etc. Electron returns Electron values; headless returns `${CODING_HOME}` / `${CODING_STATE}` / `${CODING_WORKSPACE}`.
- `FilePicker` — abstracts `dialog.showOpenDialog`. Electron uses native dialog; headless throws "not supported here" (iOS drives file selection via `file_*` commands instead).
- `WindowFocus` — abstracts `BrowserWindow.focus`. Electron focuses the window; headless is a no-op.

**`coding/src/index.ts`:** `bootstrap(opts: { notifier, secretStore, paths, filePicker, windowFocus, dataDir })`. Single entry point both consumers wire up.

**Desktop becomes a workspace consumer:**
- `desktop/package.json`: `"@ion/coding": "workspace:*"`.
- `desktop/src/main/`: keeps `index.ts`, `app-lifecycle.ts`, `window-manager.ts`, `broadcast.ts` (Notifier impl), `utils/secretStore.ts` (SecretStore impl), `permissions-preflight.ts` (macOS-only), `ipc/*` (renderer↔main bridge), `tab-registry.ts` (Phase 2 lives here briefly, then wire to coding/'s shared registry).
- Rewire imports — `desktop/src/main/index.ts` calls `bootstrap()` with Electron impls.

**Verification:** every existing desktop feature works identically. iOS↔desktop pairing, prompts, tabs, git, terminal, sessions, file ops. No net behavior change. Typecheck, tests, file-size cap green.

### Phase 4 — Headless host runtime
- `coding/src/cli/index.ts` — top-level CLI. Subcommands: `host`, `bootstrap mint`, `bootstrap rotate`, `bootstrap status`.
- `coding/src/cli/host.ts` — `coding host` boots the package with no-op `Notifier`, env-backed `SecretStore`, `${CODING_*}`-backed `Paths`, throwing `FilePicker`, no-op `WindowFocus`.
- `coding/src/host/` — small bootstrap glue (read token file, register relay channel, attach signal handlers, structured logging).
- **Pod contract** (env vars, all defaulted):
  - `CODING_TOKEN_FILE` → `/run/secrets/coding-host/token`
  - `CODING_HOME` → `/home/coding`
  - `CODING_WORKSPACE` → `/workspace`
  - `CODING_STATE` → `/var/lib/coding`
  - `CODING_RELAY_URL`, `CODING_INSTANCE_ID` → required, no defaults
- `coding/Dockerfile` — Debian/Node base + toolchain layer (`git`, `git-lfs`, `ripgrep`, `gh`, `kubectl`, `az`, `aws-cli`, `jq`, `curl`, common language runtimes — Node, Python, Go). Documented as the baseline; users `apt-get` more onto the PVC at runtime.
- `coding/deploy/k8s/` — plain manifests: `deployment.yaml`, `service.yaml`, `pvc.yaml` (workspace + state + home), `bootstrap-secret.example.yaml`, `secret-mounts.example.yaml`. No provider assumptions.
- `coding/deploy/docker-compose.yml` — local single-host deployment for dev/personal.
- `coding/deploy/examples/` — recipes only (READMEs, not invoked code): `aks-akv-csi/`, `eks-asm-csi/`, `gke-gsm-csi/`, `on-prem-sealed-secrets/`, `local-docker-run/`.

### Phase 5 — Bootstrap CLI + dual-role pairing
- `coding/src/cli/bootstrap.ts`:
  - `coding bootstrap mint` — generates 32-byte token, generates `instance_id`, prints pairing string `ion-pair://relay=URL&instance=ID&token=B64` and recipe block (kubectl / docker / az / aws / vault snippets — all documentation strings, no SDK calls).
  - `coding bootstrap rotate` — generates new token, persists transition state in `${CODING_STATE}/bootstrap-rotation.json` so the pod accepts old AND new for a brief overlap; emits a relay-channel event so iOS clients prompt for re-auth gracefully.
  - `coding bootstrap status` — checks token presence at `${CODING_TOKEN_FILE}`, prints `instance_id` and current paired device count.
- `coding/src/remote/pairing.ts` (extending current `PairingManager`):
  - Existing 6-digit code mode preserved.
  - New `acceptHmacPairing(iosHmac, peerPubKey, deviceName) → device + ourPubKey` for headless host (server side of HMAC pairing).
  - New `initiatePairingFromString(pairingString) → device + sharedSecret` for desktop client side (when desktop pairs with a coding pod).
  - Both flows reuse existing X25519 / HKDF / channel-ID derivation from `crypto.ts`. No new crypto.
- iOS-side updates:
  - Extend `PairedDevice` model with `kind: 'desktop' | 'coding'` for UI labeling.
  - Add "Paste pairing string" / QR scan path beside current 6-digit flow in `IonRemote/Views/`.
  - `TransportManager` gains the ability to track multiple peers (it already stores a list — runtime dialing currently single-peer; lift that limit).

### Phase 6 — Multi-peer desktop
- **Wire format:** add optional `peerId` to `RemoteEvent` envelope (additive, non-breaking per `AGENTS.md` contract rules). When absent, treated as the receiving client's own peer (today's behavior). Update `desktop/src/shared/types.ts` and `ios/IonRemote/Models/NormalizedEvent.swift` mirror.
- `coding/src/remote/outgoing-peer.ts` (filling in the Phase 1 skeleton): dials the relay with `role=mobile` against a coding pod's channel, uses the pairing-derived shared secret for E2E. Matches today's iOS code path role-wise.
- `coding/src/state/peer-registry.ts`: tracks paired peers and their transports. Local peer is always present (`peerId='local'`). Each paired pod is a remote peer with its `OutgoingPeerSession`.
- `coding/src/state/tab-registry.ts` (from Phase 2): tabs keyed by `(peerId, tabId)`; iteration exposes `byPeer()`.
- `Notifier` interface gains an optional `peerId` arg so the desktop renderer can scope notifications to peer panes.
- Renderer changes (`desktop/src/renderer/`):
  - `sessionStore` slice gains `peerId` dimension; selectors namespaced.
  - Tab strip groups by peer with chip indicating host (`Local`, `home-cluster`, etc.). Color-tag the chip and tab borders to make host identity unambiguous (Concern #1).
  - Permission prompts annotated with originating peer (Concern #2).
  - Disconnected remote peer state — frozen tab style, "reconnecting…" indicator, local tabs unaffected (Concern #4).
  - Add-peer flow: "Pair Coding Host" menu item that prompts for pairing string or QR scan.
- Outbound `RemoteCommand` routing in main: route by tab's `peerId` to that peer's transport.

### Phase 7 — File transfer primitive
- `coding/src/remote/handlers/files.ts` — new handlers:
  - `file_list { path }` → directory listing using engine's existing Glob; allowlist check.
  - `file_get { path, offset?, length? }` → chunked download as binary frames, configurable chunk size (default 256 KB).
  - `file_put { path, mode?, chunk, offset, total, transferId }` → chunked upload, ack per chunk, atomic-rename via `atomicWrite` on completion.
- Path policy: default-allow `${CODING_WORKSPACE}` and `${CODING_HOME}`; default-deny `/run/secrets`, `${CODING_STATE}/secrets.enc`, `${CODING_STATE}/devices.json`, `/etc`, `/`. Configurable via `coding/src/remote/path-policy.ts`.
- Max single-file cap: 100 MB default, configurable. Beyond that, point users at `git lfs` / `azcopy` / etc. via terminal.
- Reusable chunked-stream primitive (`coding/src/remote/chunked-stream.ts`) — used by `file_*` and Phase 8 transfer.
- New `RemoteCommand` variants added to `coding/src/remote/protocol.ts`. iOS file browser/upload UI is **out of scope for this plan's TS work** — flagged for a follow-up Swift PR.

### Phase 8 — Session transfer + decommission
- New `RemoteCommand` variants in `coding/src/remote/protocol.ts`:
  - `transfer_request { sourceTabId, destinationPeerId, destinationWorkingDirectory, transferId }` — issued from source peer's main process when user picks "Transfer to <peer>".
  - `transfer_offer { transferId, sourcePeerId, sourceWorkingDirectory, destinationWorkingDirectory, conversationJsonl, modelConfig }` — source → destination (carries the JSONL bundle as a chunked-stream payload).
  - `transfer_ack { transferId, newTabId }` — destination → source after successful import + session start.
  - `transfer_complete { transferId }` — source → destination after source closes its tab + stops engine session.
  - `transfer_status { transferId }` — query for reconciliation.
  - `transfer_cancel { transferId, reason }` — abort path.
- **Engine change (additive, contract-stable):** `engine/internal/types/types.go` `SessionConfig` gains `PathRewrites map[string]string` (omitempty). Tools in `engine/internal/tools/` (Read/Edit/Glob/Grep/Bash CWD) consult the map at execution time and rewrite absolute paths matching any source-prefix to the destination-prefix. Mechanical, no policy change. Documented in engine `AGENTS.md` extension to contract-stability table.
- **Source flow:**
  1. User picks "Transfer → home-cluster (path `/workspace/foo`)" in tab context menu.
  2. Source generates `transferId`, persists `${CODING_STATE}/transfers/{transferId}.json` with `{state: 'pending', sourceTabId, destinationPeerId, destinationWorkingDirectory, sourceWorkingDirectory, startedAt}`.
  3. Source exports the conversation via `engine/internal/export/export.go` `exportJSONL` (already exists, full fidelity).
  4. Source UI: tab badge shows "transferring → home-cluster…", input disabled.
  5. Source streams `transfer_offer` to destination peer.
- **Destination flow:**
  1. Receives `transfer_offer`, persists `${CODING_STATE}/transfers/{transferId}.json` `{state: 'received'}`.
  2. Imports JSONL via `engine/internal/conversation/persistence.go` `loadFromJSONL` (already exists).
  3. Creates new tab with `workingDirectory = destinationWorkingDirectory`, `pathRewrites = { sourceWorkingDirectory: destinationWorkingDirectory }`.
  4. Injects a system note as the first system message in the loaded conversation: "This conversation was relocated from `<sourceWorkingDirectory>` on `<sourcePeer>` to `<destinationWorkingDirectory>` on `<destinationPeer>` at `<timestamp>`. Treat any references to the old path as referring to the new path."
  5. Starts the engine session.
  6. Marks transfer state `'destination-owned'` (idempotency anchor) and emits `transfer_ack`.
- **Source close:**
  1. On `transfer_ack` receipt, source closes UI tab AND calls engine `StopSession` for the underlying session.
  2. Source marks transfer state `'completed'`, emits `transfer_complete`.
  3. Original JSONL is preserved on disk (cheap), tab is gone from UI. User can manually re-open via load-conversation if needed.
- **Failure modes:**
  - Destination rejects offer (e.g., destination workingDirectory missing): source surfaces error, UI tab returns to active, `transferId` marked `'failed'`.
  - `transfer_ack` lost in transit: source re-emits `transfer_offer` with same `transferId`; destination is idempotent (sees state `'destination-owned'`, replies with cached `transfer_ack`).
  - Source crashes between `transfer_ack` and close: on restart, source's pending-transfers reconciler queries each peer with `transfer_status`. **Destination wins** — if destination reports `'destination-owned'`, source closes the orphan tab and stops the engine session.
  - Network partition during offer streaming: both sides time out; `transferId` aged out, user retries.
- Reverse direction (cloud → desktop) is symmetric; same code path with peers swapped.

### Phase 9 — Post-pair secrets + audit
- `coding/src/remote/handlers/secrets.ts` — `secret_put / list / delete` commands.
  - Local encrypted store at `${CODING_STATE}/secrets.enc`, key derived from bootstrap token via HKDF.
  - `scope=file`: writes to `path` with `mode`, persists across restarts on PVC.
  - `scope=env`: registers as env var injected into engine-spawned subprocess env (extends existing `cli-env.ts` scrub patterns).
  - `secret_list` returns names + scope, **never values**.
  - Path allowlist + deny list (shared with Phase 7 file policy).
- `coding/src/util/audit-log.ts` — append-only structured log at `${CODING_STATE}/audit.log`. Every `secret_*` and `file_put` writes an entry: timestamp, deviceId, command name, summary (no values, redacted paths).
- New `RemoteCommand audit_tail { limit }` for review from any paired device.
- Touch/Face ID gating on iOS for `secret_put` and `file_put` to allowlisted-but-sensitive paths — extend the existing iOS sensitive-action gate. The pod doesn't enforce this (the iOS app can lie), but it's a useful UX guard against an unlocked phone.

### Phase 10 — Documentation
- `coding/README.md` — quickstart (docker run + plain k8s), pointer to `docs/coding/`. Match existing component README brevity (60–100 lines).
- Top-level `README.md` — add `coding/` to the layout discussion / Reference Clients section. One-paragraph blurb on multi-peer + transfer.
- `docs/coding/` — new section:
  - `overview.md` — model, when to use vs desktop-only.
  - `deploy.md` — pod contract, plain k8s recipe, docker-compose recipe, example links to `coding/deploy/examples/` for AKS / EKS / GKE / on-prem.
  - `pairing.md` — bootstrap mint/rotate, pairing string format, security considerations (no proximity proof — token is the trust root).
  - `secrets.md` — pod contract paths, recipes by backend, post-pair `secret_put` semantics, audit log.
  - `files.md` — `file_*` semantics, size limits, path policy.
  - `transfer.md` — fork-to-peer flow, two-phase commit, decommission semantics, path translation strategy.
  - `multi-peer.md` — desktop as multi-peer client, host identity UX, disconnected-peer behavior.
- `docs/protocol/client-commands.md` — document new `RemoteCommand` variants (`transfer_*`, `secret_*`, `file_*`, `audit_tail`).
- `docs/architecture/file-organization.md` — add `coding` to component overview.
- Engine `AGENTS.md` — note `PathRewrites` `SessionConfig` extension under contract-stability "Allowed (non-breaking)" examples.
- `desktop/README.md` — note multi-peer support.
- `desktop/AGENTS.md` — note that coding-tool semantics now live in `coding/`.
- `ios/README.md` — note pairing-string flow alongside 6-digit pairing.

## Critical files to modify

**New:**
- `coding/` (entire tree — package.json, AGENTS.md, README.md, VERSION, Dockerfile, tsconfig.json, src/, deploy/, tests/)
- `docs/coding/` (overview/deploy/pairing/secrets/files/transfer/multi-peer)

**Existing (modify):**
- `.commit.json` — add `coding` scope.
- `AGENTS.md` (root) — layout / caps / gates / scopes / layered architecture.
- `README.md` (root) — components blurb.
- `desktop/AGENTS.md` — note coding/ ownership.
- `desktop/package.json` — add `@ion/coding` workspace dep.
- `desktop/src/main/state.ts`, `broadcast.ts`, `event-wiring.ts`, `index.ts` — Notifier wiring.
- `desktop/src/main/remote/transport.ts` (split in Phase 1).
- `desktop/src/main/remote/handlers/{tabs,engine,terminal,history,git}.ts` — Phase 2 migrate from `executeJavaScript` to TabRegistry.
- `desktop/src/main/remote/snapshot.ts` — Phase 2 migrate.
- `desktop/src/renderer/stores/sessionStore.ts` (allowlisted god file — extract slices, don't extend) — Phase 2 inversion + Phase 6 peer-id dimension.
- `desktop/src/renderer/App.tsx` (allowlisted god file — extract slices, don't extend) — Phase 6 peer-aware tab strip.
- `engine/internal/types/types.go` — `PathRewrites` field in `SessionConfig` (Phase 8).
- `engine/internal/tools/{read,edit,glob,grep,bash}.go` — consult `PathRewrites` (Phase 8).
- `engine/internal/session/start_session.go` — wire `PathRewrites` from `SessionConfig`.
- `engine/AGENTS.md` — contract-stability note.
- `desktop/src/shared/types.ts` — wire-format `peerId`, new `RemoteCommand` variants.
- `ios/IonRemote/Models/{PairedDevice,RemoteCommand,NormalizedEvent}.swift` — mirror types.
- `ios/IonRemote/Networking/TransportManager*.swift` — multi-peer runtime + pairing-string consumer.
- `ios/IonRemote/Views/` — pairing-string entry, multi-peer picker.
- `docs/protocol/client-commands.md`, `docs/architecture/file-organization.md`, `desktop/README.md`, `ios/README.md`.

## Existing primitives to reuse (don't reinvent)

- `engine/internal/export/export.go` `exportJSONL` — full-fidelity conversation export (Phase 8).
- `engine/internal/conversation/persistence.go` `loadFromJSONL` — re-import (Phase 8).
- `desktop/src/main/remote/crypto.ts` `generateKeyPair`, `deriveSharedSecret`, `deriveChannelId` — pairing crypto stays as-is.
- `desktop/src/main/remote/pairing.ts` `PairingManager` — extend with HMAC + client-role methods (Phase 5).
- `desktop/src/main/utils/atomicWrite.ts` — file-write safety for transfers, secrets, settings.
- `desktop/src/main/remote/transport.ts` (post-split) — `IncomingPeerSession` retained as-is; `OutgoingPeerSession` is the new shape.
- `desktop/src/main/cli-env.ts` env-scrub patterns — extend for `secret_put` env injection (Phase 9).
- `engine/internal/session/manager.go` `StopSession` — called from source's transfer-close path (Phase 8).
- `desktop/src/main/remote/revoke.ts` — already handles device removal; reused unchanged for revoke-from-pod.
- iOS `RelayClient.swift`, `LANClient.swift`, `TransportManager.swift` — already multi-peer-shaped in storage, just lift runtime restriction.

## Concerns addressed (mapping to phases)

| Concern | Where addressed |
|---|---|
| Renderer-state inversion (structural blocker) | Phase 2 |
| Visual host identity in tabs | Phase 6 (chip + color) |
| Permission prompts annotated by peer | Phase 6 |
| Path-bound conversation context after transfer | Phase 8 (system note + engine `PathRewrites`) |
| Offline / disconnected remote peer | Phase 6 (frozen tab UX) |
| Single source of truth for device list per install | Phase 5 (existing `~/.ion/settings.json` pattern) |
| Two-phase commit idempotency | Phase 8 (persistent `transferId` + destination-wins reconciliation) |
| Bootstrap rotation w/ paired iOS | Phase 5 (`bootstrap rotate` overlap window + relay event for re-auth) |
| Audit log integrity | Phase 9 (append-only, queryable via `audit_tail`) |
| File-cap pre-decomp | Phase 1 |
| Provider neutrality | Phase 4 (env+filesystem contract, no SDK) + Phase 5 (CLI prints recipes, not calls) |
| Decommission to prevent duplicate work | Phase 8 (source closes tab + stops engine session only after destination ack; symmetric reverse) |

## Verification

End-to-end checks at each milestone:

**Phase 1 (decomp):** `cd desktop && npm run typecheck && npm test`; `make check-file-sizes`.

**Phase 2 (state inversion):** Full desktop smoke: open tabs, switch tabs, prompt engine, run terminal, browse git panel, pair iOS, exercise every iOS `RemoteCommand` against the desktop, verify no UX changes. Renderer dev tools: confirm tab state mutations originate from main, not renderer. Tests + typecheck green.

**Phase 3 (extraction):** `cd coding && npm run typecheck && npm test`. Re-run Phase 2 smoke against the extracted desktop — should be identical behavior. `make check-file-sizes` clean.

**Phase 4 (headless host):** Build image (`cd coding && docker build .`). Run via `docker-compose up` locally with a test relay — pod registers channel and waits for pair. Image contains expected toolchain (`docker run … which git rg gh kubectl`).

**Phase 5 (bootstrap + dual-role pairing):**
- `coding bootstrap mint` outputs valid pairing string and recipe block.
- iOS app accepts the pairing string, completes HMAC handshake against a locally-running headless container, derives shared secret, persists device. Pod's `${CODING_STATE}/devices.json` shows the new device.
- `coding bootstrap rotate`: paired iOS prompts for re-auth; old token works during overlap; new pair succeeds with new token.

**Phase 6 (multi-peer desktop):**
- Desktop pairs with the local headless container (paste pairing string in new "Pair Coding Host" UI). Tab strip shows two groups: `Local` and the new peer. Tabs from each are color-distinct.
- Open a tab on each peer; prompts route to the correct engine. Disconnect the pod (kill the pod); pod's tabs go frozen-disconnected; local tabs still work. Reconnect — tabs reattach.
- Cap check: `make check-file-sizes`.

**Phase 7 (file transfer):**
- iOS (or test harness) sends `file_put` for a 5 MB file → file appears at allowed path on pod with correct mode.
- `file_put` to `/etc/passwd` rejected by allowlist. Audit log records the attempt.
- `file_get` for a 50 MB file streams back chunked; SHA matches.

**Phase 8 (session transfer):**
- On desktop, run a multi-turn session in `~/repos/foo` referencing `~/repos/foo/src/x.ts`. Transfer to pod with destination `/workspace/foo` (pre-cloned).
- Source tab disappears, source engine session stops (verify via `~/.ion/engine.log` "session stopped"). Destination tab appears with full history. System note visible. Subsequent `Read /Users/josh/repos/foo/src/x.ts` rewrites to `/workspace/foo/src/x.ts` and succeeds.
- Reverse direction: same outcome, pod tab decommissioned.
- Crash mid-transfer: kill source after `transfer_ack` but before `transfer_complete` — restart source, reconciler closes orphan tab. No duplicate work.
- Idempotency: re-emit `transfer_offer` with same `transferId` — destination replies with cached ack; no second tab.

**Phase 9 (secrets + audit):**
- `secret_put scope=file path=~/.npmrc value=…` from iOS — file appears with mode 0600. Survives pod restart.
- `secret_put scope=env name=GITHUB_TOKEN value=…` — next-spawned terminal sees `GITHUB_TOKEN` in env.
- `audit_tail` returns recent entries with names and scopes; values absent.
- `secret_put` to `/etc/foo` rejected.

**Phase 10 (docs):**
- `cd docs && <doc build cmd>` clean.
- All new docs cross-link.
- Conventional Commits with `coding` scope succeed via husky hook (no `--no-verify`).

**Repo gates (every phase):**
- `make check-file-sizes`
- `cd engine && go test -race ./...` (Phase 8 only — engine touched there)
- `cd engine && go test -race -tags integration ./tests/integration/...` (Phase 8 — `PathRewrites` integration test)
- `cd engine && golangci-lint run` (Phase 8)
- `cd desktop && npm run typecheck && npm test`
- `cd coding && npm run typecheck && npm test` (Phase 3 onward)
- `make ios-check` (Phase 5 / Phase 6 onward — iOS changes)

## Out of scope for this branch

- iOS file browser / upload UI (Swift work, separate PR after Phase 7).
- iOS multi-peer picker UI polish (basic picker in Phase 6; richer UX is follow-up).
- v2 path translation: per-call user-supplied path map override at transfer dialog time.
- Multi-tenant headless host (one pod per user assumed throughout).
- Remote engine-instance management (engine tabs) on coding pods — Phase 6 multi-peer handles agent tabs only; engine tabs require additional plumbing on the pod, deferred.
- Engine binary running inside the coding pod vs. external — for now the pod runs its own engine binary (image includes it), single-tenant.
- Live PTY transfer for terminal tabs.
