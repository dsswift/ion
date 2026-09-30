# Server (`@ion/server`, TypeScript, headless)

The Ion Studio Server: the session store, Studio wire, auth, and per-Environment orchestration (worktrees, benches, transfer), with no Electron dependency. One server plus one engine is an Environment ([ADR-033](../docs/architecture/adr/033-ion-studio-server-and-environments.md)). It runs the same as the desktop's child process (spawned by `desktop/src/main/local-server.ts`), in Docker Compose, or as a Kubernetes pod ([Ion Studio Server](../docs/deployment/studio-server.md)).

## Commands

```bash
npm -w server run build              # esbuild bundle to dist/
npm -w server run test               # vitest run
npm -w server run test:integration   # builds the Go engine and boots it (PR-time gate)
npm -w server run typecheck          # tsc --noEmit
npm -w server run lint               # ESLint
```

## Where things live

| Path | Holds |
|---|---|
| `store/` | `useSessionStore` and its slices; `host-api-*.ts` is the store's seam to the outside |
| `protocol/` | Studio wire: `connection.ts` (hello, credential check, welcome/refused), `commands.ts`, `actions.ts`, `events.ts` |
| `remote/`, `thin-view/` | The iOS projection: `protocol.ts` (`desktop_*` names), snapshot polling, `thin-sync.ts` |
| `transcript/` | The one transcript: row projection and revisioned patches for thin clients and dispatched agents ([ADR-036](../docs/architecture/adr/036-thin-clients-render-the-server-transcript.md)) |
| `auth/` | The three credential doors plus pairing links and channels |
| `engine/` | The engine bridge. It connects to the engine's address (`engine-address.ts`); it never spawns the engine |
| `terminal/` | `terminal-manager.ts` and the attach protocol |
| `deeplink/` | `ion://` dispatcher, parser, actions |
| `worktree/`, `git/`, `transfer/`, `conversation-backup/` | Worktree and bench orchestration, git, the Transfer verb and its archive |
| `persistence/`, `utils/` | Settings store, setting keys, `atomicWrite.ts`, `secretStore.ts` |
| `http/` | `/healthz`, `/readyz`, `/auth/config`, `/auth/pair`, `POST /log`, and the browser Studio bundle (`static.ts`, behind `server.json.web.enabled`) |

## `HostApi`: the store's one seam onto the outside world

A store action that reaches outside the store (engine RPC, git, filesystem, terminal) calls a function in `store/host-api-*.ts`. Nothing under `store/` imports `ipcMain`, `BrowserWindow`, or `contextBridge`.

**Studio's renderer bundles `store/sessionStore.ts` and everything it imports.** Only files listed in `desktop/src/buildtools/renderer-server-stubs.ts` are swapped for browser stubs. Any other Node import reached from there (`os`, `fs`, `child_process`) fails `electron-vite build` while typecheck, lint, and unit tests all pass. A Node-only store watcher is wired from `store/activate-server-store.ts`, which only `main.ts` imports. The `desktop-build` Quality job builds both renderer bundles on any server change to catch this.

## Studio wire rules

- Store action classification and `broadcast()`: root `AGENTS.md` § "Server owns the store, Studio renders".
- `remote/protocol.ts` members carry the `desktop_` prefix from their first commit. A rename is lockstep, not a contract break: update `packages/shared/src/studio-wire/`, iOS `RemoteCommand.swift` / `NormalizedEvent.swift` TypeKeys, `StudioTransportCommandMapping.swift`, and every handler on the string in one change ([ADR-008](../docs/architecture/adr/008-wire-event-naming-and-ownership.md)).
- **User turns are echoed through one funnel.** A user turn does not ride engine events, so the Studio mirror must be told separately. Call `echoUserTurn` (`user-turn-echo.ts`); never send it directly. iOS needs no echo; it gets the owner store's row on its transcript stream. The funnel and the owner store apply the same injection classification (`@ion/shared/injection-policy`), so a hidden turn is hidden on every surface. To add a hidden class, classify the kind in `engine/internal/types/injection_kind.go`; add it to `OUTBOUND_MACHINE_KINDS` only if a client authors it. Never add a check at a call site. Hide only turns no human saw (agent callbacks, background results). A turn the operator produced, such as a Guided Questions submission, stays visible and is labelled via `Message.injectionKind`.
- **Terminals** are server-owned. Renderers attach and detach (the `terminal.attach` action, `protocol/terminal-actions.ts`); only an explicit close destroys one. Every PTY carries `ION_DESKTOP_TAB_ID`, `ION_DESKTOP_TERMINAL_INSTANCE_ID`, and `ION_DESKTOP_DEEPLINK_TOKEN` so tools in a pane can target their own conversation ([ADR-031](../docs/architecture/adr/031-deep-link-surface.md)). Never resolve a deep link's target from the active tab.
- **Inbox** classification is computed once (`@ion/shared/inbox-classify`); clients render it.
- **New setting** → `SETTINGS_DEFAULTS` (`persistence/settings-store.ts`), the key allowlist in `persistence/studio-settings-keys.ts`, and `StudioSettings` (`packages/shared/src/types-studio.ts`). Scope: `packages/shared/src/settings-registry.ts`.

## Deep links (`ion://`)

`deeplink/`: one dispatcher, two transports (inline query params, a handoff file under `~/.ion/deeplink-requests/`), two actions (`terminal`, `prompt`). Reference: [`docs/configuration/deep-links.md`](../docs/configuration/deep-links.md).

- `dispatch.ts` resolves the trust tier once, before routing. An action never re-checks it.
- A new action goes in the parser allowlist with per-field length caps. Unknown actions and over-long fields are refused, not truncated.
- An untrusted request is shown in full in `DeepLinkConfirmDialog` (desktop renderer): the real command or prompt text.
- Every path that cannot get an answer resolves to declined. An untrusted terminal request without `tabId` must make the operator pick a live conversation; a trusted one without `tabId` is refused.

## Subprocess environment

- `cli-env.ts` strips `CLAUDECODE` and similar leakage vars before spawn. Don't bypass it.
- `launch-env.ts` repairs an Installer-inherited environment (`APPLE_PKGKIT_ESCALATING_ROOT` makes `/bin/zsh` and `/bin/bash` skip every user startup file). The desktop runs it first; see desktop `AGENTS.md` § "Launch environment".

## Secrets and persistence

- Paired-device secrets and the relay API key go through `utils/secretStore.ts` (OS keychain via `safeStorage` when in Electron, an AES-GCM keyfile otherwise).
- User state (tabs, labels, settings) is written through `utils/atomicWrite.ts` (temp + fsync + rename). Never `writeFileSync` directly.

## Auth doors

One refusal vocabulary (`studio_refused.reason`). A refusal is logged with its reason and never differentiated on the wire beyond that field.

| Door | File | Verifies |
|---|---|---|
| `local` | `auth/auth-policy.ts` | The connection arrived on the local socket or named pipe. |
| `paired` | `auth/paired.ts` | HMAC-SHA256 over the `/auth/config` nonce, keyed by a secret in `credentials.json` (`auth/credentials-store.ts`), minted by `auth/pairing-links.ts` / `pairing-channels.ts`. |
| `bearer` | `auth/bearer.ts` | A JWT verified with `jose` against `server.json.oidc`; roles map to scopes via `oidc.rolesToScopes`. |

`server.json.policy.{authPolicy,actionInterceptor,snapshotProjector}` name pluggable seams. `"default"` is the only shipped implementation. A consumer implements the matching interface (`auth/auth-policy.ts`) and names it in `server.json`.

## Logging

`component=server` to `<ION_DATA_DIR>/server.jsonl`. A browser Studio client's lines (`POST /log`) land in the same file as `component=web`. Connection transitions, hide decisions, refusals, and migration steps log at INFO with `environment_id`, `client_id`, `principal_subject`, `reason`.

- Use `logger.ts`. ESLint `no-console` is an error here, off only in `src/cli/**` and tests.
- The few server modules the desktop's main loads directly log through `desktop/src/main/server-logger-adapter.ts` into `desktop.jsonl`. The server child itself writes `server.jsonl`.
- `ION_LOG_OUTPUT` = `file` (default) | `stdout` | `both`. The Docker image sets `both`.
- Every exit path (`process-logging.ts`, `shutdown.ts`) drains the logger's 500ms buffer and the egress sink.
- `server.json` `logging` turns on egress (`config/logging-config.ts`); absent ships nothing. `logging.egressShipSources` picks what this process ships.

## Tests

Co-located `__tests__/` per domain. A new test of a server module goes there.

Many tests of server modules still live under `desktop/src/main/__tests__/`, importing `@ion/server/...`. After a server change, run `cd desktop && npm test -- <pattern>` as well as `npm -w server run test -- <pattern>`.

`server/tests/integration/` (`vitest.integration.config.ts`) builds the real engine and boots it beside the server. Integration and the Docker Compose smoke test run in CI's test lane on every push that touches the server.
