# Ion

## Layout

| Component | Path | Language |
|-----------|------|----------|
| Engine | `engine/` | Go |
| Server | `server/` (`@ion/server`) | TypeScript, headless |
| Desktop | `desktop/` | TypeScript (Electron + React) |
| Relay | `relay/` | Go |
| iOS | `ios/IonRemote/` | Swift |
| Shared packages | `packages/shared/`, `packages/studio-sdk/` | TypeScript (+ Go Studio SDK) |
| Go SDK | `sdk/go/` | Go |

Engine, server, desktop, and iOS each have their own `AGENTS.md`. The relay, the shared packages, and the Go SDK are governed by this file. **Before touching `engine/`, read [`docs/engine-grounding.md`](docs/engine-grounding.md).**

SDK edits have a source-of-truth split: edit `engine/extensions/sdk/ion-sdk/`, never the installed copy at `~/.ion/extensions/sdk/` (overwritten at build). See [`engine/AGENTS.md`](engine/AGENTS.md) § "Extension SDK source location".

## File-size caps (CI hard-fails above)

| Language | Cap |
|----------|----:|
| TypeScript / TSX | 600 |
| Go (`*.go`) | 800 |
| Go (`*_test.go`) | 1500 |
| Swift | 600 |

Override: `// @file-size-exception: <reason>` (`#` for shell/yaml/python) on line 1. Files in `.file-size-allowlist.yml` must not grow; put new code in a new file. Over the cap, split at a natural seam. Never strip comments or compress code to fit. Reference: `docs/architecture/file-organization.md`.

## Context files

`AGENTS.md` is canonical and committed. `CLAUDE.md` is a gitignored local symlink to its sibling (`make claude-symlinks`). Do not add new per-folder `AGENTS.md` files.

## Codebase questions — query the graph first, always

For any question about how code is structured or connected, the first call is a graph query, not `Grep` or `Read`. Do not check whether the graph exists. If graphify is missing, the command fails instantly: fall back to `Grep`/`Glob`/`Read` without comment, and never suggest installing it.

| Command | Use |
|---|---|
| `graphify query "<identifier>"` | Opening move: where it lives, what is near it |
| `graphify explain "<symbol>"` | Every edge with `file:line`. Run before a rename, delete, or signature change |
| `graphify path "<A>" "<B>"` | How two symbols connect across layers |

- Seed on identifiers (`startBackgroundBashTask`), not prose. With only a symptom, grep one distinctive literal (log `msg`, error string, UI label) to get a symbol, then query that.
- Never pass `--budget` below 400. Omit it for the 2000 default. A truncation notice is normal.
- Logger, store, and type-barrel hubs crowd results. Filter with `--context call` (or `import`, `field`, `parameter_type`, `return_type`, `generic_arg`).
- Package-level vars and consts are not nodes. "No matching nodes" means grep for it.
- The graph locates; the source confirms. `INFERRED` call edges are places to check, not proof.
- In a worktree, `graphify-out/graph.json` is a link to the primary checkout's graph. It describes the source branch, not this worktree's commits. When a path the graph returns does not exist here, find that symbol with `Grep`.
- Never run `graphify install`; the skill is tracked at `.ion/skills/graphify/`. `graphify-out/` is gitignored. Git hooks keep the primary checkout's graph current; `make graph` is refused in a worktree.

Worked examples: [`docs/contributing/graph-queries.md`](docs/contributing/graph-queries.md).

## Local hooks

Husky installs hooks on `npm install` / `make bootstrap`. Pre-push gates live in `scripts/pre-push.sh`; `.husky/pre-push` is a dash-safe delegator. `make hooks` repairs a broken `core.hooksPath`. Never `--no-verify`.

## Windows VM testing — sync before every build

Only when a Windows CI failure needs Windows-real verification. Run `make sync-windows-vm` before every VM build. The VM tree at `C:\dev\ion` is a copy, not a checkout, so never copy individual files. Verify by grepping the built artifact for a string your change added; a source check proves nothing. An isolated pass does not prove a CI contention timeout is gone. Full loop: [`docs/contributing/windows-vm.md`](docs/contributing/windows-vm.md).

## Forbidden commands

**Never run `make desktop`.** It installs a new desktop that can restart the engine daemon hosting this conversation. If a packaged build is needed, tell the user to run it.

## Quality gates (run while developing)

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Contract sync | `make check-contracts` (when a shared type changes) |
| Status writers | `make check-status-writers` (when touching code that writes `tab.status` or `statusFields`) |
| Logging standards | `make check-logging` |
| Server parity | `make check-server-parity` (when touching `desktop/src/main`) |
| Studio wire | `make check-studio-wire` (when a fixture under `packages/shared/src/studio-wire/__fixtures__` changes) |
| Vocabulary | `make check-vocabulary` (when `docs/vocabulary/terms.json` changes) |
| Engine lint | `cd engine && golangci-lint run ./internal/<pkg>/...` |
| Engine tests | `cd engine && go test ./internal/<pkg>/...` (`-race` for concurrency). `internal/server` takes ~150s; scope with `-run <TestPrefix>` |
| Server typecheck, lint | `npm -w server run typecheck`, `npm -w server run lint` |
| Server tests | `npm -w server run test -- <pattern>`, then `cd desktop && npm test -- <pattern>`: many tests of server modules still live under `desktop/src/main/__tests__/` |
| Shared package | `npm -w @ion/shared run typecheck`, `npm -w @ion/shared test -- <pattern>` |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests | `cd desktop && npm test -- <pattern>` |
| Renderer bundle | `cd desktop && npm run build` (when `server/src/store/` or anything it imports gains an import; see `server/AGENTS.md` § "`HostApi`") |

### Validation cadence — never after every file edit

Batch related edits, then run the narrowest test that could disprove the change. Run the scoped gate set once when the implementation is stable. A passing gate stays valid until a later code change could affect it. Docs-only edits never do.

### Heavy gates — never run during development

`make test-linux` (and its `-engine`, `-desktop`, and `-server` parts), `go test -race ./...`, `go test -race -tags integration ./tests/integration/...`, `govulncheck ./...`, relay `go test -race ./...`, `npm audit`, full `npm test`, `npm -w server run test:integration`, `make ios-check`. Run one only when `/create-pr` says to or the user asks. CI's test lane (`.github/workflows/quality.yml`, on every push to `main`) is authoritative; a failure there is filed as an issue and keeps the releases it gates as drafts; it never blocks a push. A new engine, desktop, or server test job in `quality.yml` must be mirrored into `make test-linux`. Rationale: [`docs/contributing/quality-gates.md`](docs/contributing/quality-gates.md).

## Branch workflow

`main` is the integration branch; the operator lands work by direct push, and every push is versioned, built, and published by the delivery pipeline ([`docs/contributing/delivery-pipeline.md`](docs/contributing/delivery-pipeline.md)). Pull requests are optional. Read the active branch with `git branch --show-current`; never hardcode one. Never `git push`.

## Commits

- `type(scope): subject`. Types: `feat`, `fix`, `chore`, `docs`, `feat!`. Subject lowercase, imperative, no period, ≤ 65 chars.
- Scopes: `engine` (`engine/`, incl. the TS SDK), `sdk` (`sdk/`, Go SDK), `desktop`, `server`, `relay`, `ios`, `docs`, `repo` (root, cross-cutting, `packages/`, `scripts/`, `.github/`), `ci`, `deps`. Use the scope of the primary change.
- Path→scope mapping: `.commit.json`. Legal scopes: `commitlint.config.js`. `ci`/`deps` are legal but never auto-resolved.
- Work from a GitHub issue: subject ends ` (#N)` **and** a commit or PR body carries `Fixes #N` / `Closes #N`. `make check-issue-closure` fails the PR otherwise.
- Never commit `.env*`, `appsettings.json`, `local.settings.json`, `engine/tests/e2e/testconfig.json`.
- Commit finished work before reporting. Never `--no-verify`. Never push.

## Layered architecture

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` | Hooks, events, tools, LLM streaming. Headless, no UI concepts. |
| Server | `server/` | The session store, Studio wire, auth, per-Environment orchestration (worktrees, benches, git, terminals, transfer). One server + one engine = an Environment ([ADR-033](docs/architecture/adr/033-ion-studio-server-and-environments.md)). |
| Harness | `~/.ion/extensions/` | Extensions via SDK. Decides behavior. |
| Client | `desktop/`, `ios/` | Renders what the server publishes. Studio also builds for the browser (`npm run build:web`), served by the server. |

Engine executes, harness decides, the server owns state, clients render. The engine never blocks the socket waiting for a user, never persists memory, never decides policy. The desktop and iOS never talk to the engine; they reach it through the server's engine bridge.

The vocabulary registry has four domains (`engine`, `harness-sdk`, `clients`, `relay`) and a `server` platform for implementations under `server/`.

## Opinionless mechanics, extensible opinions

The engine owns the mechanism (discovery, parsing, scheduling, transport, persistence) and ships one generic default. Every opinion a consumer might want differently must be a config field **and** reachable through a hook/SDK seam. A hardcoded opinion with no override is a defect. Examples: the scheduler fires, the extension decides what firing does; the engine expands slash commands, a resolution hook decides special handling; tool instructions carry mechanics only, style comes from `AGENTS.md` or harness overrides ([ADR-017](docs/architecture/adr/017-opinionless-tool-instructions.md)).

## Engine consumers

The engine is the product; the server, desktop, iOS, and relay are reference implementations. "No in-repo caller" is the expected state for new engine surface, never a reason to reject or delete it. Judge an engine change by whether it breaks a hypothetical external consumer: a new optional field or event is fine; a changed decode or signature is a break. Full framing: [`docs/architecture/engine-consumers.md`](docs/architecture/engine-consumers.md).

### The typed-event corollary

When the engine has a signal, it emits one typed `NormalizedEvent` variant and stops. Never also surface it in stream content (`TaskCompleteEvent.Result`, `TextChunkEvent`), synthetic system messages, or log lines. How a consumer renders or ignores the event is the consumer's policy.

## Harnesses and extensions are in scope

When a harness under `~/.ion/extensions/` (e.g. `ion-dev`) or an in-repo canary extension is the source of a bug or the consumer of a new engine/SDK feature, its upgrade is part of the plan, committed in its own tree. When an extension feature is blocked by a missing engine/SDK capability, add the generic engine/SDK primitive and consume it. Never fake it in the harness (a timer for a missing schedule kind, polling for a missing event). Name the gap; if the fix needs a contract break, ask first. A harness consuming a brand-new SDK field may need a structural-typing shim until the SDK is rebuilt.

## Studio vocabulary lives in the Studio SDK, never in the engine SDK

Studio extension points (menu rows, panels, buttons) go in `packages/studio-sdk/`, never `engine/extensions/sdk/` or `sdk/go/`.

- Transport is a resource whose kind starts with `ion-studio.`. A Studio capability changes **zero files under `engine/`**.
- Shapes live once in `packages/studio-sdk/contract.json`, pinned by tests in each flavor and in `packages/shared/src/studio-sdk-contract.ts`.
- Any new surface that lists resources must filter with `isStudioControlKind`.
- Composer Action resources stop at the server (`server/src/engine/composer-actions.ts`), which publishes each conversation's list on `studio:composer-actions`. Clients never see the raw resource.

Reference: [`docs/extensions/studio-sdk.md`](docs/extensions/studio-sdk.md).

## Naming authority — the vocabulary registry

`docs/vocabulary/terms.json` names every shared concept. Use the canonical term in docs, comments, UI strings, and plans. A new shared concept gets an entry in the same change (definition, domain, kind, contract classification, one implementation citing a real symbol and file). After any registry edit run `make generate-vocabulary` then `make check-vocabulary`. The registry never renames a wire field or published contract.

## Server owns the store, Studio renders

`server/src/store/` owns `useSessionStore`. Studio (`desktop/src/renderer/studio/`) is the desktop's application window; the splash and the worktree-overlap visualizer are auxiliary windows with no store. Studio boots the same store in mirror mode as the union of every connected Environment: FORWARDED actions round-trip as `studio_action`, MIRROR_LOCAL actions stay window-local.

- New store action → classify in `packages/shared/src/studio-wire/actions.ts` or the mirror-parity test fails.
- New main-process event push → `broadcast()`. `make check-server-parity` fails a direct `webContents.send`.
- `desktop/src/main` holds no session logic and never reaches the engine bridge or the store. `make check-server-parity` and `desktop/src/main/__tests__/no-engine-reach.test.ts` pin it.

## Two enterprise policies

| | Device policy | Environment policy |
|---|---|---|
| Governs | The person's own desktop (`themePolicy`, `disableAutoUpdate`, `hiddenSettingsGroups`, and `environmentPolicy` for the environment catalog) | What a shared engine permits (`allowedModels`, `allowedProviders`, tools, limits) |
| Source | LOCAL environment only: `customFields['ion-desktop']` | The engine's own `EnterpriseConfig` |
| Enforced by | The desktop client | The engine, republished on `studio_welcome.enterprisePolicy` |

A remote server must never narrow a visiting desktop's own UI. What a server offers is a different thing: `customFields['ion-server'].developerSurfaces` switches a developer surface off for every connection, and a client shows no control for it on that server's conversations only (`packages/shared/src/developer-surfaces.ts`). `customFields['ion-desktop'].developerSurfaces` is the device-policy form. Neither policy is a setting; a persisted setting has one of four scopes (`environment`, `account`, `personal`, `device`) in `packages/shared/src/settings-registry.ts`. The registry's fifth value, `runtime`, marks a key that is held in memory and never persisted. Environment settings gate on the `admin` scope. `settingsHiddenGroups` is device policy only.

## Cross-platform parity

When a change touches a feature that exists on both desktop and iOS, update iOS in the same change or state why it cannot apply. iOS sees only what the snapshot sends (`server/src/remote/snapshot-polling.ts` → `server/src/thin-view/thin-sync.ts`); settled conversations ride `desktop_settled_tabs` instead. New engine features do not need to ship on both clients at once. Surface-by-surface sync paths: [`docs/architecture/cross-platform-parity.md`](docs/architecture/cross-platform-parity.md) § "Common parity surfaces".

## Resource subsystem

Session-scoped resources (`conversationId` set) belong to one conversation's attachments. Workspace-scoped ones go to the global notifications inbox. The engine stores nothing: producing extensions persist their own data and answer queries. `mark_read` and `delete` travel as deltas through the engine to every client. Reference: [`docs/architecture/resource-subsystem.md`](docs/architecture/resource-subsystem.md).

## Contract stability

**Engine wire: scrutinized.** Never ship a breaking change without explicit operator approval. Contract surfaces: `engine/internal/protocol/protocol.go`, `engine/internal/types/normalized_event.go`, `engine/internal/extension/sdk_types.go` / `sdk_hook_types.go` / `sdk_hooks_*.go`, and any event field a client reads. Event semantics (snapshot vs. incremental, replace vs. merge, when it fires) are contract too. Additive fields, variants, hooks, and optional params are fine. Removing, renaming, retyping, reordering callback args, or changing framing is a break. A legacy-name correction may ship as `fix`; the operator decides.

**Studio wire: lockstep, not scrutinized.** Every client is in this repo, so a rename is not a break; it only needs parity in one change: `packages/shared/src/studio-wire/`, `server/src/remote/protocol.ts`, iOS `RemoteCommand.swift` / `NormalizedEvent.swift` TypeKeys and `StudioTransportCommandMapping.swift`, and any handler switching on the string. A new phone command also needs a row in `packages/shared/src/studio-wire/phone-command-map.json`.

**Prefix by owner (ADR 008):** engine `engine_`, server-derived Studio-wire payloads `desktop_`, Studio SDK `ion-studio.`. Internal `NormalizedEvent` names are bare; `translateToEngineEvent()` adds `engine_`.

Full rules: [`docs/architecture/contract-stability.md`](docs/architecture/contract-stability.md).

### Cross-language contract sync

Go is the source of truth. When a shared type changes:

1. Change Go in `engine/internal/types/`.
2. `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the field map in `packages/shared/src/__tests__/contract-sync.test.ts`.
4. Update the TS type (`types-engine.ts`, `types-events.ts`, or `types-engine-event.ts` under `packages/shared/src/`).
5. Update the Swift type in `ios/IonRemote/Models/` and its contract test.
6. `make check-contracts`.

## Logging policy

Observability is the most important property of backend code: if it is not in the logs, it cannot be verified. Log every operation's outcome and every decision branch, with identifiers. Logging is permanent.

| Surface | File | Logger |
|---|---|---|
| Engine | `~/.ion/engine.jsonl` | `utils.Log`/`Debug`/`Error`. Never `log.Printf`/`fmt.Printf` (launchd daemon stderr is lost) |
| Desktop main | `~/.ion/desktop.jsonl` | `main/logger`. `@ion/server` modules main loads directly log here too; the server child writes `server.jsonl` |
| Desktop renderer | `~/.ion/desktop.jsonl` | `renderer/rendererLogger`. Never `console.*` (`make check-logging`) |
| Server | `<ION_DATA_DIR>/server.jsonl` | `server/src/logger.ts`. `component=web` for forwarded browser lines. `ION_LOG_OUTPUT` = `file`\|`stdout`\|`both` |
| iOS | `<ION_DATA_DIR>/ios-diagnostic-logs.jsonl` on the paired server's host | `DiagnosticLog.log()`. Never `os.Logger`/`print()` |
| Relay | `RELAY_LOG_FILE` or stdout (`RELAY_LOG_OUTPUT`) | Go relay logger |
| Extensions | `~/.ion/engine.jsonl`, `component=extension`, `tag=<name>` | SDK log |

Reading logs:

- Files rotate (`engine.jsonl.1`–`.3`). A miss in the current file proves nothing; search the rotations covering the timestamp.
- Filter on the `msg` field (`grep '"msg":"<marker>"'`), not the raw line. Your own tool calls are echoed into the log.
- A log line missing across every covering rotation means that code path did not run.
- `logLevel` is read once at daemon start from the global `~/.ion/engine.json` only. A project config cannot raise it. Bootstrapped clones run `debug`, consumer installs `info`. If the level hides what you need, say so.

`jq` and LogQL recipes: [`docs/observability/consuming-logs.md`](docs/observability/consuming-logs.md). Schema: [`docs/observability/log-schema.md`](docs/observability/log-schema.md).

### No silent failures

Every failure is either handled and logged, or explicitly marked benign with a reason.

- Go: no bare `_ =` on an error. Log it, or `//nolint:errcheck // <reason>`.
- TypeScript: no floating promise, no async function where `() => void` is expected, no empty `catch {}` or `.catch(() => {})`. Use `void` for fire-and-forget, log what matters, and tag benign swallows `// silent-ok: <reason>`.
- Swift: no empty `catch {}` and no discarding `try?` where failure matters. Route through `DiagnosticLog.log(..., level: .warn/.error)`.

## Engineering rules

### Aspirational comments

A comment describing behavior the code lacks means the implementation is incomplete; investigate and build it before deleting the comment. A plan never resolves a finding by documenting it (TODO, narrative comment, follow-up issue, warn-log, "later phase").

### Telemetry schema moves forward

A change to the log, span, or metric schema Ion emits bumps the schema version and upgrades every consumer in this repository in the same change: the local stack (`docs/observability/` Alloy, Loki, Tempo, Grafana provisioning), and the dashboard generator and both of its outputs. The replaced fields are dropped, not kept as duplicates for old dashboards. Anyone who wants the old schema keeps the old version.

### Volatile counts

Never write a count the code determines ("55 hooks", "12 providers") in docs or comments. Link the by-name reference instead. Only the top-level `README.md` badge line may carry such numbers.

### Solution quality — no cheap substitutes

When the proper root-cause fix is known, ship it, however large. No stopgaps, no heuristics standing in for a precise mechanism, no avoiding a new event/field/protocol surface. The only reasons to stage: a published-contract break, the architecture cannot support it yet, or the domain genuinely does not need the precision.

### Dead code is not load-bearing until proven otherwise

Before keeping a no-op, pass-through, or vestigial layer "for compat", cite the live producer or consumer that forces it (`graphify explain`, then source). Keep only that layer and delete the rest. Every surviving comment about callers or the wire must be verified.

### Tests

Every feature and fix ships a test that pins its behavior. A fix's test fails with the fix reverted. Cross-boundary fields need a serialization test. A feature on both clients needs its parity pinned.

### Premises and stale artifacts

If a user claim about the code is wrong, say so before building on it. A stale comment, doc, or test found in the path of the work is in scope; fix it in its own commit.

## Worktrees and benches

- **Worktree:** a conversation in a registered worktree cannot write into its base repo or a sibling worktree. The engine checks literal `cd`/`git -C`/`--work-tree` targets in Bash too. `/tmp`, `~/.ion`, and unrelated repos stay writable. Gitignored paths declared in `.ion/worktree.json` `sharedPaths` are exempt; git is still refused there.
- **Integration bench** (`~/.ion/integration/`): refuses `Write`/`Edit` and all history writes (commit, push, merge, rebase, reset, stash, …). It is rebuilt from member pins. Fix the file in the member worktree the refusal names, then update that member.
- **Landed worktree:** sealed and read-only; only Retire remains. Never infer or clear `landedAt`.

Land, Retire, transfer, and provisioning: [`docs/architecture/worktrees-and-benches.md`](docs/architecture/worktrees-and-benches.md).

## Conversation storage

Conversations persist as NDJSON pairs under `~/.ion/conversations/`. With principal partitioning on, each principal's conversations are under `~/.ion/principals/<dir>/conversations/` ([ADR-034](docs/architecture/adr/034-principal-isolation-and-tenancy.md)). Reference: [`docs/architecture/conversation-storage.md`](docs/architecture/conversation-storage.md).
