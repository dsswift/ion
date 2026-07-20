# Ion

## Layout

| Component | Path | Language |
|-----------|------|----------|
| Engine | `engine/` | Go |
| Desktop | `desktop/` | TypeScript (Electron + React) |
| Relay | `relay/` | Go |
| iOS | `ios/IonRemote/` | Swift |

Engine, desktop, and iOS each have their own `AGENTS.md` with subsystem-specific rules.

## Extension SDK source location

The TypeScript SDK that extensions import lives in **two places**:

| Location | Role |
|----------|------|
| `engine/extensions/sdk/ion-sdk/` | **Source of truth.** Edit here. |
| `~/.ion/extensions/sdk/ion-sdk/` | **Installed copy.** Overwritten at build time. Never edit. |

The build process copies the repo source to the installed location. Any edit made only to `~/.ion/extensions/sdk/` will be lost on the next build. **Always edit `engine/extensions/sdk/ion-sdk/`** for SDK changes (types, runtime, or any other SDK file). The installed copy at `~/.ion/` is read-only from the agent's perspective.

## File-size caps (CI hard-fails above)

| Language | Cap |
|----------|----:|
| TypeScript / TSX | 600 |
| Go (`*.go`) | 800 |
| Go (`*_test.go`) | 1500 |
| Swift | 600 |

Override: `// @file-size-exception: <reason>` (`#` for shell/yaml/python) on line 1. Existing god files allowlisted in `.file-size-allowlist.yml` — do not extend them; extract new code to a new file.

### When a file exceeds the cap

Split the file — find the natural seams (logical groupings, hook boundaries, helper clusters) and extract to a new file. **Never** remove or collapse comments, collapse whitespace, or shorten code to hit the line limit. Comments are load-bearing documentation. If the choice is between a well-commented file that is 10 lines over cap and a stripped file that is under cap, the stripped version is worse. Split instead.

Cohesion of change: a feature lives in one folder. Full reference: `docs/architecture/file-organization.md`.

## Context files

- `AGENTS.md` is canonical and committed.
- `CLAUDE.md` is a local-only symlink to sibling `AGENTS.md`. Gitignored. Run `make claude-symlinks` (or `npm install` in `desktop/`) to create.
- Do not seed per-bounded-context `AGENTS.md`. Defer until traces show confusion.
- **Before any work that touches `engine/`, read [`docs/engine-grounding.md`](docs/engine-grounding.md).** It is the non-negotiable framing for engine changes — contract stability, snapshot semantics, engine-vs-harness boundaries, and the "modifying the engine is restricted" default. Engine work without this grounding is a defect.

## Local hooks

Run `make hooks` once per clone to point git at `.githooks/`. The pre-push hook runs `make check-file-sizes` so cap violations fail locally before reaching CI. Bypass with `--no-verify` only when intentional.

## Forbidden commands

**Never run `make desktop`.** It builds, packages, installs to `/Applications`, and relaunches the desktop app. On launch the desktop re-bootstraps the engine daemon and force-restarts it (`launchctl kickstart -k`) when the bundled binary or plist changed — so a `make desktop` that ships a new engine binary recycles the daemon, killing the engine process hosting your conversation and often losing conversation state. The user runs `make desktop` manually when they are ready. If a desktop rebuild is needed, tell the user to run it.

## Quality gates (run while developing)

These are the gates to run **during normal development** — they are cheap, fast, and scoped to the work in front of you. Run them as you iterate. Do **not** run the heavy gates listed in the next subsection while developing.

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Contract sync | `make check-contracts` (only when you change a shared type — see "Cross-language contract sync") |
| Status-writer check | `make check-status-writers` — run when touching code that emits `engine_status` or `engine_session_status` |
| Logging standards | `make check-logging` — enforces ADR-019: no interpolated `msg`, no `console.*` in renderer, no non-canonical field keys. |
| Engine lint | `cd engine && golangci-lint run` (scope to touched packages while iterating: `golangci-lint run ./internal/<pkg>/...`) |
| Engine tests (scoped) | `cd engine && go test ./internal/<touched-pkg>/...` — run the packages you changed, with `-race` when concurrency is involved. Do **not** routinely run the full `go test ./...` sweep while iterating. |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests (scoped) | `cd desktop && npm test -- <pattern>` for the area you touched. The full `npm test` run belongs to the pre-PR sweep. |

CI: `.github/workflows/build.yml` (release), `.github/workflows/quality.yml` (per-PR).

### Heavy gates — never run during development

The following gates are **slow** — Docker container spin-up, full-network vulnerability scan, full multi-package race runs, full iOS build. **Never run them during normal development.** Re-running them mid-session burns wall-clock and tokens for no added safety, because they run once, authoritatively, at PR time.

| Heavy gate | Command |
|------------|---------|
| Linux parity | `make test-linux` (and `make test-linux-engine` / `make test-linux-desktop`) |
| Full engine race suite | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| Relay tests + race | `cd relay && go test -race ./...` |
| Desktop audit | `cd desktop && npm audit --audit-level=high --omit=dev` |
| Full desktop suite | `cd desktop && npm test` |
| iOS build | `make ios-check` |

**The heavy gates run at PR time, not during development.** CI (`quality.yml`) is the authoritative gate: it runs the full set above — race suites, integration, `govulncheck`, `npm audit`, iOS build — on **every PR**, on `ubuntu-latest`. Locally, `/create-pr` runs the **Linux parity** subset (`make test-linux`, which executes the full race suite + desktop tests inside Linux containers) **once**, right before pushing, to catch Linux-only failures before they burn Actions minutes on a red build. The only times the agent runs a heavy gate are (a) when `/create-pr` explicitly instructs it to, or (b) when the user explicitly asks for it (e.g. to reproduce a known Linux-only failure). Outside those two cases, the heavy gates are off-limits during development — CI is what proves them green on the PR.

> **Why `/create-pr` runs `make test-linux`.** Local validation runs on macOS; the blocking CI gates run on `ubuntu-latest`. `go test -race ./...` (the `engine-test` job) and `npm test` (the `desktop-test` job) run on Linux in CI, so a macOS-only pass is **not** sufficient — OS-sensitive failures (path semantics, file-watcher timing, locale, goroutine starvation under the Linux race detector, eager `require('electron')` under `npm ci --ignore-scripts`) slip through. `make test-linux` runs the same commands CI runs, in Linux containers, so those failures surface before the PR instead of after burning Actions minutes on a red build. `/create-pr` runs this gate automatically before pushing and pauses if Docker isn't running — the common path needs no manual step.

## Branch workflow

- `main` is protected. All changes merge via pull request — never push directly to `main`.
- The current working branch can be any named feature branch (e.g. `josh`, `feat/foo`, `fix/bar`). Never hardcode a branch name; always use `git branch --show-current` to determine the active branch.
- **Standard flow:**
  1. Do work on the current feature branch, commit locally.
  2. When an external PR lands on `main` that your branch depends on or should incorporate: merge it on GitHub (`gh pr merge <number> --merge`), then `git checkout main && git pull` to sync local `main`, then `git checkout <feature-branch> && git rebase main` to rebase the feature branch onto the updated `main`.
  3. Open a PR from the feature branch into `main` (`gh pr create`). Never push directly to `main`.
- CI must pass on the PR before merge. Run the development-time quality gates as you iterate (see "Quality gates (run while developing)"); the heavy gates are run once by `/create-pr` before pushing — do not run them yourself during development.

## Commits

- Conventional Commits with **required scope**: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `chore`, `docs`, `feat!`.
- Allowed scopes (enforced by `commitlint.config.js`):

| Scope | Path trigger |
|-------|-------------|
| `engine` | `engine/` |
| `desktop` | `desktop/` |
| `relay` | `relay/` |
| `ios` | `ios/` |
| `docs` | `docs/` |
| `repo` | root files or cross-cutting changes |
| `ci` | `.github/` workflows and CI config |
| `deps` | dependency-only updates (Dependabot / manual bumps) |

- `ci` and `deps` are in `commitlint.config.js` but not in `.commit.json` (the commit binary does not auto-scope them; use them via `git commit -m` directly when appropriate).
- Pick the scope matching the primary path touched. If files span multiple scopes, use the scope of the *primary* change.
- Examples: `feat(engine): add streaming support`, `fix(desktop): correct tab order`, `chore(repo): update ci workflow`.
- Subject ≤ 65 chars, lowercase, imperative, no period. (This 65-char target is a self-imposed stylistic guideline, not the enforced limit: commitlint's `header-max-length` from `@commitlint/config-conventional` is 100. The tighter target leaves ample headroom for the ` (#N)` issue suffix.)
- **Issue association is mandatory when working from a GitHub issue.** If the work was initiated by an issue (e.g. user said "let's work on #126"), the commit must associate it both ways:
  - **Subject line**: append ` (#N)` so GitHub auto-links and the issue number is visible in `git log --oneline`. Example: `fix(engine): wire agent_start / agent_end hooks (#126)`. Stay within the 65-char subject cap.
  - **Body trailer**: include `Fixes #N` (or `Closes #N` for non-bug work) on its own line at the end of the body. This is what GitHub uses to auto-close the issue when the PR merges.
  - Both are required. Subject alone gives the auto-link but won't close the issue; body alone closes the issue but isn't visible in short logs.
- Never `--no-verify`.
- Never commit `.env*`, `appsettings.json`, `local.settings.json`, `engine/tests/e2e/testconfig.json`.
- **Always `git commit` completed work.** When all quality gates pass and the implementation is done, commit before reporting back to the user. Uncommitted changes in the working tree get lost — other sessions, rebuilds, and checkouts will overwrite them. The commit is the unit of durable work; an uncommitted edit is not "done."
- Never `git push`. Tell the user the changes are ready to push.

## Layered architecture

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` (Go) | Hooks, events, tools, LLM streaming. Headless, no UI concepts. |
| Harness | `~/.ion/extensions/` (TS) | Extensions via SDK. Decides behavior. |
| Client | `desktop/`, `ios/` | Renders UI from engine events. |

Engine executes, harness decides. Engine never blocks for user input, never persists memory, never decides policy.

When labeling work: engine, harness, or client. If a harness gap is caused by missing engine capability, note both.

## Opinionless mechanics, extensible opinions

The engine owns the **mechanism** — the dirty, load-bearing work that every consumer would otherwise have to reimplement — and ships the **most generic, least-opinionated standard behavior** for it. Consumers and extensions own and customize the **opinions**. This is the core engine-design principle: provide standards generically, and let opinions be modified and extended *off* the core mechanics. The engine is an opinionless core that anyone can build opinionated layers over.

The principle stands on its own. It is **not** "match whatever a competitor does." When prior art informs a standard, adopt the generic shape of the mechanism; do not import another product's opinions as the engine's defaults, and never document engine behavior by reference to an external product's source (those references rot — see § "Aspirational comments" and § "Volatile counts").

### The two obligations

1. **Own the mechanism; carry the least-opinionated standard.** The engine does the work (discovery, parsing, scheduling, transport, persistence) and ships one generic, predictable default behavior. It does not bake in a consumer's workflow, UI shape, or policy.
2. **Every opinion is configurable and extensible.** Any behavior that is an *opinion* — anything a reasonable consumer might want to do differently — must be exposed as a config field **and** reachable through a hook/SDK seam, so a consumer can observe, override, or augment it. **Forcing a consumer to do something exactly one way is the anti-pattern.** If you find the engine dictating a single fixed behavior where consumers would reasonably differ, that is a defect to fix, not a constraint to defend.

### Canonical examples

| Feature | Engine owns (mechanism) | Consumer owns (opinion) |
|---------|-------------------------|--------------------------|
| **Schedules** | The scheduler — timing, persistence, firing | What a schedule *does* when it fires |
| **Webhooks** | The HTTP-server mechanics — listening, routing, lifecycle | The action taken on an inbound webhook; the consumer just registers it |
| **Slash commands** | Discovery across the conventional roots, frontmatter parsing (full map preserved), precedence resolution, `$ARGUMENTS` expansion, the persisted-invocation-vs-expanded-content split | Whether non-standard activation modes are enabled (config), and specialized handling via a resolution hook that sees the full frontmatter + invocation metadata — so the same `/command` can behave differently in an extension-hosted conversation than in a plain one |
| **Tool instructions** | Input-shape mechanics, channel correctness (e.g. "the user sees only visible assistant text — private reasoning never reaches them"), interception semantics | Style, depth, tone, workflow framing (tradeoff analysis, recommendations, domain phrasing) — via operator `AGENTS.md`, harness prose overrides, or `RegisterTool` replacement. See [ADR-017](docs/architecture/adr/017-opinionless-tool-instructions.md) |

When you add a feature to the engine, decide explicitly: what is the mechanism (engine-owned, generic) and what is the opinion (consumer-owned, configurable + hookable)? Ship the mechanism with a least-opinionated default and a seam for every opinion. A feature that hardcodes an opinion with no override is incomplete.

## Engine consumers

> **The Ion Engine is the product. The desktop, iOS, and relay applications in this repo are reference implementations — opinionated demonstrations of how to consume the engine. They are not the canonical consumer set. The canonical consumer is every external developer building against the wire protocol and SDK.**

### Who the real consumers are

- **TypeScript SDK consumers** — extensions installed at `~/.ion/extensions/` and third-party extension authors.
- **Go SDK consumers** — third-party harnesses, custom backends, server-side integrations.
- **Wire-protocol consumers** — anyone building a custom client (CLI, web app, mobile app, IDE plugin, automation pipeline, shell script) directly against the NDJSON socket.
- **The desktop, iOS, and relay applications in this repo** — one reference implementation, not the only one. **Reference implementations consume the engine; they do not define its surface.**
- **Future consumers we have not met yet** — every public release of the engine ships with the expectation that someone we have never spoken to will build something on top of it tomorrow.

### Reframe 1 — "No in-repo caller" is the expected default for new engine surface, not evidence of accidental addition

When the engine ships a new hook, protocol field, SDK type, normalized event variant, tool, or config option, the expected steady state is that the in-repo reference implementations do **not** consume it. They consume *some* engine features to be useful as references; they do not consume *every* engine feature, and they should not.

When you find a piece of engine surface with no desktop/iOS caller, the questions to ask are:

- Is this surface useful to a plausible external consumer? (If yes → ship it.)
- Does it have tests pinning its behavior? (If yes → ship it.)
- Does it have documentation explaining how external consumers should use it? (If no → that's the gap to fix, not the engine surface itself.)

The question to **never** ask: *"Does desktop use this yet?"* That framing is forbidden. A reviewer who anchors a recommendation on it is reviewing the wrong codebase.

### Reframe 2 — Reference implementations carry a reputational quality bar, not a coverage bar

External developers learn how to consume the engine by looking at the desktop and iOS apps. So those apps must be exemplary — idiomatic, well-architected, well-tested, observable, free of anti-patterns. But "exemplary" is about *how* the references consume the engine, not *how much* they consume. A desktop that demonstrates 30% of engine features at the highest quality bar is a better reference than a desktop that demonstrates 100% of engine features sloppily. The desktop is not the SDK contract; it is one careful interpretation.

### The forbidden review question

**Do not ask "does desktop use this?" when reviewing engine changes.** That question presupposes the reference implementation is the canonical consumer. It is not. Ask instead: *would any plausible external consumer want this?* If yes, the engine should ship it. The absence of an in-repo caller is not a smell; it is the expected default for a healthy engine that ships ahead of its reference implementations.

### The external-consumer simulation (use this instead of in-repo caller search)

Before flagging an engine change as a contract violation, ask: *would this break a hypothetical external consumer who built against the previously-published surface?*

- If the answer is "they would have to ignore a new optional return value" or "they would have to add a new optional field" — that's **not** a break. It's good evolution.
- If the answer is "their existing struct decode would fail" or "their existing argument list would no longer match" — that **is** a break.

Use the external-consumer simulation, not the in-repo caller search, to decide.

### The typed-event corollary

When the engine has signal to communicate, it emits a typed `NormalizedEvent` variant. That emission is the engine's *complete* fulfillment of its signaling obligation for that signal. The engine does not also owe a parallel surface in stream content (no appending to `TaskCompleteEvent.Result`, no mutating `TextChunkEvent`, no synthetic system messages, no log-line-as-source-of-truth). Doing any of that would force every consumer through one specific UI-shaped interpretation and would corrupt headless pipelines that parse stream content as the LLM's verbatim output.

Consequence: when a reviewer asks *"but a headless user who isn't subscribed to event X wouldn't notice Y"* — that is the engine working as designed. The headless user receives the JSON event stream; the typed event is in it. Their orchestration may abort, retry, notify, ignore, or do anything else. The engine has no opinion. Reference implementations in this repo (desktop, iOS) choose their own opinionated rendering; that is **one consumer's policy**, not the engine's recommendation.

This applies equally to warnings (model fallback, deprecation notices), advisories (rate limits, retries, context compaction), and state transitions (agent lifecycle, plan-mode changes). Pick the right event shape, emit it once, and stop. Do not double-surface.

### Consequences (the operational rules that flow from the framing above)

- **Do not require an in-repo consumer before adding engine API surface.** If a hook, protocol field, or SDK method is useful to external consumers, it belongs in the engine — even if desktop and iOS don't use it yet. The absence of desktop/iOS usage is not evidence of premature code; it is evidence that the reference implementations haven't caught up.
- **Engine API surface should be generous.** Every configurable behavior should be exposed: as an `engine.json` config field, as a per-prompt `ClientCommand` override, and (where applicable) as an SDK context method. External consumers want every hook we can imagine.
- **Desktop and iOS are not gatekeepers.** They consume the engine; they do not define its surface. When reviewing engine changes, do not ask "does desktop use this?" — ask "would an external consumer want this?"

## Harnesses and extensions are in scope

When a local extension or harness is referenced during investigation as the **source** of an issue, or is the **end-goal consumer** of an engine/SDK feature, the plan **must** include the actual upgrade to that extension/harness — not merely the engine/SDK mechanism. An engine feature with no consumer is an unfinished plan: it leaves the reported bug unfixed in practice and the new capability unexercised. These extensions are the reference and testable implementations; shipping the mechanism without wiring the consumer is half a fix.

This holds regardless of where the harness lives or who owns it:

- **In-repo** harnesses that ship with the engine (e.g. `ion-meta`, installed to end users when the engine is installed).
- The primary **engine-development harness** I use most (`ion-dev`) — a private extension at `~/.ion/extensions/ion-dev/`, not part of the Ion repository, but the active extension I use to find bugs, exercise new engine/SDK surface, and test the engine inside the desktop.
- Fully **private** harnesses with no relation to Ion development beyond consuming the engine (e.g. `chief-of-staff`).
- **Any other harness installed under `~/.ion/extensions/`** that is what we are troubleshooting or enhancing.

If the harness is on the machine and it is what we are troubleshooting or enhancing, its upgrade is in the plan and gets implemented and committed (at its own scope seam, in its own working tree) alongside the engine/SDK change.

This generalizes the `## Scope` rule above (no deferral of ordered work) to the engine↔harness boundary. Note the SDK source-of-truth split: edit the SDK in the engine repo at `engine/extensions/sdk/ion-sdk/`; never edit the installed copy at `~/.ion/extensions/sdk/` (it is overwritten at build time). A harness that consumes a brand-new SDK field may need a structural-typing shim until the operator rebuilds the engine/SDK so the installed copy carries the field.

## Missing engine/SDK capability is fixed at the root, not worked around in the harness

I own the Ion engine and I am the extension developer. When a requested extension feature is **blocked by a missing engine or SDK capability**, the correct resolution is to add the proper engine/SDK primitive — a new hook, tool, event, config field, SDK method, or scheduler/async kind — and then consume it in the harness. It is **not** to build a load-bearing workaround in the extension that routes around the gap (a raw timer standing in for a missing schedule kind, a polling loop standing in for a missing event, a local reimplementation of mechanics the engine should own). Workarounds around an engine gap are the same anti-pattern as substituting a heuristic for a precise mechanism: they drift, they leak, and they leave the real capability unbuilt.

The trigger is any moment where the honest description of a plan is "the SDK can't do X, so the extension fakes X." When you catch that, stop and make the distinction explicit to me:

- **Name the gap** as a first-class finding: "the SDK has no one-shot schedule / no self-unregister / no such event."
- **Propose the engine/SDK enhancement** as the primary fix (additive and generic — built for any external consumer, per the engine-consumer framing, not just this harness), and
- **Name the consuming-harness upgrade** that exercises it — both land in the same plan (per `## Harnesses and extensions are in scope`), each committed at its own scope seam in its own working tree.

This is not license to gold-plate every extension task into an engine change. Most harness work is genuinely harness work. The rule fires specifically when a feature is *blocked by* an engine/SDK limitation and I own the engine: in that case the engine enhancement is the plan, and the workaround is the defect to avoid. When I ask for cutting-edge extension features, assume engine/SDK enhancements are in scope and surface them rather than defaulting to a harness-local hack. If there is a genuine reason the engine change is out of scope (published-contract break needing my approval, or the capability truly belongs in the harness), say so and let me decide — never silently pick the workaround.

## Cross-client parity (overlay ↔ ATV)

The desktop has two clients in one process: the overlay glass and the ATV shell (`desktop/src/renderer/atv/`). Same parity obligation as desktop ↔ iOS: a feature that exists in both must be the same in both. Full architecture: [ADR-021](docs/architecture/adr/021-atv-shell-mirror-store.md).

- **Reuse is the parity system.** A shared surface is ONE component reading the same store, mounted in both windows (the ATV runs the session store in mirror mode). Never build a bespoke ATV widget for something the overlay already has a component for; bespoke is only for canvas-coupled surfaces (marquee, inspector, control bar).
- **New store action** → classify it in `desktop/src/shared/atv-mirror-actions.ts` (forwarded vs mirror-local, with justification); the mirror-parity test fails otherwise.
- **New main-process event push** → route through `broadcast()`; `make check-atv-parity` (CI) fails direct `webContents.send` outside the owner-only allowlist.
- **Checklist for overlay UI/state changes:** does the surface exist in the ATV shell? Shared component → done by construction. Not shared → mount it in the ATV, or state why it is overlay-only. The inverse holds for ATV changes.

## Cross-platform parity (desktop ↔ iOS)

> **Scope of this table.** The parity rules below apply when a feature *exists* on both desktop and iOS today and a change to one demands a change to the other. They do not require every new engine feature to ship simultaneously on desktop and iOS — engine surface ships ahead of reference implementations by design (see § "Engine consumers"). Use this section as a sync checklist for already-paired surfaces, not as a coverage mandate for new ones.

Desktop and iOS are co-equal clients. When a desktop change touches a feature that also exists on iOS, **you must assess the iOS impact before considering the work complete.**

### Checklist for every desktop UI/state change

1. **Does this feature exist on iOS?** Check `ios/IonRemote/Views/` and `ios/IonRemote/ViewModels/` for the iOS counterpart.
2. **If yes:** update the iOS side in the same PR, or document why it's deferred.
3. **If the feature can't translate to iOS** (no physical space, no interaction model): document the trade-off. Consider an alternate iOS-appropriate rendering before deciding to skip.
4. **If state flows through the snapshot** (`desktop/src/main/remote/snapshot.ts`): check whether the snapshot projection needs updating. The snapshot is the bridge — iOS can only see what the snapshot sends.

### Common parity surfaces

| Desktop | iOS counterpart | Sync path |
|---------|----------------|-----------|
| Tab status dot (TabStripTabPill, StatusDot) | Tab list dot (TabRowView.statusInfo) | `snapshot.ts` → `RemoteTabState.status` |
| Engine instance bar (TabStripTabPill) | Engine instance bar (EngineInstanceBar) | `snapshot.ts` → `RemoteTabState.conversationInstances`. Note: `EngineTabStrip` was deleted in #256 (conversation unification); the model-fallback indicator is now derived via `resolveTabModelFallback` in `TabStripTabPill`. |
| Permission denials / waiting state | Permission queue / waiting state | `snapshot.ts` promotes denials into `permissionQueue`; per-instance `waitingState` on `conversationInstances` |
| Tab group pills | Tab group sections | `snapshot.ts` → group fields on `RemoteTabState` |
| Thinking indicator / interrupt button | Activity indicator / interrupt button | Real-time events (`engineTextDelta`, `tabStatus`) |
| Tab context menu (TabStripTabContextMenu) | Tab context menu (TabRowContextMenu) | Actions operate on `RemoteTabState` fields; session identity via `snapshot.ts` → `RemoteTabState.conversationId` for all conversations. For extension-loaded tabs, per-instance session IDs are available in `conversationInstances[i].conversationIds` (historical) and `StatusFields.sessionId` (live). |
| Desktop Settings dialog (SettingsDialog categories) | Desktop Settings detail (DesktopSettingsView sections) | `projectable-settings.ts` → `desktop_settings_snapshot` event → `DesktopSettingsView` auto-renders sections. iOS group IDs **must** match `PROJECTABLE_GROUP_ORDER` (exported from `projectable-settings.ts`); renaming a group requires updating `PROJECTABLE_GROUP_LABELS` in that same file and the test in `src/main/__tests__/projectable-settings.test.ts`. Adding a new user-editable desktop preference requires a parallel entry in `PROJECTABLE_SETTINGS_DATA` in `projectable-settings-data.ts` unless the setting is local-machine-only (font, path, secret). |
| Model fallback indicator (EngineStatusBar per-instance ⚠) | Model fallback indicator (EngineInstanceBar per-instance ⚠) | `snapshot.ts` → `RemoteTabState.conversationInstances[i].modelFallback`. Desktop populates `engineModelFallbacks` from the `engine_model_fallback` event; the snapshot poller projects each entry onto the corresponding `conversationInstances[i]` and iOS reads it from the snapshot. Cleared on the next idle transition (per-instance). |

### When to skip iOS

Only when the interface physically cannot work on iOS (e.g. a keyboard-only interaction, a desktop window management feature, or a rendering surface that doesn't exist on mobile). In that case:
- Note in the PR description why iOS was skipped.
- Consider whether an alternate mobile-appropriate rendering exists.
- At minimum, ensure the iOS app doesn't break or show stale data because of the desktop change.

## Resource subsystem

The engine provides a generic resource subsystem for durable structured content. Extensions declare resource kinds, publish items, and handle queries. Clients subscribe and receive snapshots + incremental deltas.

### Scoping

- **Session-scoped** (`conversationId` set): resource belongs to a specific conversation. Appears in that tab's attachments panel. Persists for the lifetime of the conversation.
- **Workspace-scoped** (`conversationId` empty): resource belongs to no conversation. Appears in the global notifications inbox. Persists until the producing extension cleans it up.

### Cross-device synchronization

The desktop is the primary client. The iOS app is a thin client connected via WebSocket (directly or through the relay). All state changes flow through the engine:

- When a resource is published, the engine broadcasts the delta to all subscribers (desktop + iOS).
- When a user reads a resource on either device, the client sends a `resource_publish` with `op: 'mark_read'`. The engine fans the delta to all subscribers. Both devices update their read state.
- The engine does not track read state. Clients send the mark_read delta; the engine routes it. Producer extensions persist read state if they choose to.

### Producer-owned persistence

The engine stores nothing. Extensions that declare resource kinds are responsible for persisting their data. When a client subscribes (or resubscribes after disconnect), the engine routes a query to the producing extension, which answers from its own store.

### Notifications

`ctx.notify()` sends a push notification through the engine's relay pipeline. Notifications are signals, not payloads. The push body is a doorbell string ("New briefing ready"), not content. The relay includes `ionResourceId` and `ionKind` in the APNs payload for future deep-linking. iOS does not yet read these fields; the current `AppDelegate` navigates by `tabId` only.

## Contract stability

Not all wire contracts carry the same stability obligation. The rules differ by owner.

### Engine wire - scrutinized contract

The engine wire is a **scrutinized contract**. External integrators build custom clients, shell scripts, and automation pipelines directly against the engine NDJSON socket. Ion cannot reach those consumers to coordinate a migration. A breaking change to the engine wire must be a conscious, surfaced decision — never committed silently.

**Never ship a breaking change to the engine wire contract without explicit operator approval.**

Event-shape contracts are not just about field names. Event **semantics** (snapshot vs. incremental, replace vs. merge, idempotency) are also part of the engine contract. See [docs/architecture/agent-state.md](docs/architecture/agent-state.md) for the canonical example: `engine_agent_state` is always a complete snapshot, and consumers replace local state with the payload.

Correcting an improper legacy name on the engine wire **may** be committed as a breaking change in a future version using `fix` (not `feat!`) unless the rename is genuinely application-sweeping. The operator decides; the agent surfaces the decision, never makes it alone.

#### What counts as an engine contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON shape) |
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go`, mirrored in `desktop/src/shared/types.ts` and `ios/IonRemote/Models/NormalizedEvent.swift` |
| SDK types & hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` (`HookHandler`, `Context`, payload types) |
| Hook names & payload shapes | All hooks registered in `engine/internal/extension/sdk_hooks_*.go` |
| Engine events consumed by clients | Any event type or field a client reads to render UI |

#### Allowed (non-breaking engine changes)

- **Add** new fields with zero-value defaults, new event variants, new hooks, new optional parameters.
- **Fix** bugs in existing methods (behavior change that corrects a documented or obvious defect).
- **Version** a new alternative when a design must evolve (e.g. `ToolCallV2`) — leave the original intact.

#### Forbidden (breaking engine changes)

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type (e.g. `string` → `int`, `[]T` → `map`).
- Alter a hook's payload shape in a non-additive way.
- Remove or reorder positional arguments in an SDK callback signature.
- Change wire-protocol message framing or envelope structure.

If you believe a break is truly necessary, stop and discuss with the user — never commit it silently.

### Desktop↔iOS wire and future client wires - lockstep, not scrutinized

The desktop↔iOS wire (and any future client wire such as desktop↔Android or desktop↔web) operates under a **lockstep model**. All clients that share a wire are co-located in this repo. A wire rename ships to every side in one PR — there is no deployment window where one side has the new string and the other has the old one. These wire changes are not breaking changes in the external-integrator sense.

**Do not push back on desktop↔iOS wire changes as though they were published-contract breaks.** They are not. The only obligation is **parity**: every side of the wire is updated in the same PR. If you are reviewing or implementing a desktop↔iOS wire rename and all clients are updated together, the change conforms to this policy.

Parity check: confirm `desktop/src/main/remote/protocol.ts`, the iOS `RemoteCommand.swift` and `NormalizedEvent.swift` TypeKey raw values, and any ViewModel or handler that switches on the string are all updated in the same commit (or PR).

### Wire event naming - prefix by owner (ADR 008)

Wire events are prefixed by the **owner of the contract**. See [docs/architecture/adr/008-wire-event-naming-and-ownership.md](docs/architecture/adr/008-wire-event-naming-and-ownership.md) for the full rationale.

| Owner | Prefix | Wire |
|-------|--------|------|
| Engine | `engine_` | Engine NDJSON socket |
| Desktop | `desktop_` | Desktop↔iOS WebSocket |
| Android (future) | `android_` | Desktop↔Android WebSocket |
| Web (future) | `web_` | Desktop↔Web WebSocket |

The engine's outbound event set is uniformly `engine_`-prefixed (see `engine/internal/types/engine_event.go`). All `RemoteEvent` and `RemoteCommand` members on the desktop↔iOS wire carry the `desktop_` prefix. Any new member introduced to either wire must carry the correct prefix from its first commit. PRs that introduce unprefixed or cross-prefixed members are non-conforming.

**Internal vs. wire names.** `NormalizedEvent` uses bare names internally. These never reach a consumer: `translateToEngineEvent()` converts them to `engine_*` before anything is written to the socket. The bare internal names and the wire names are distinct layers.

### Cross-language contract sync

Go is the source of truth. A reflection-based test (`engine/internal/types/contract_test.go`) extracts every shared struct's JSON field names into a golden manifest (`engine/internal/types/testdata/contracts.json`). TS and Swift tests validate against it.

**Workflow when you change a shared type (NormalizedEvent variant, StatusFields, EngineConfig, etc.):**

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the TS field map in `desktop/src/shared/__tests__/contract-sync.test.ts` to match.
4. Update the TS type definition in the appropriate file under `desktop/src/shared/`: `types-engine.ts`, `types-events.ts`, or `types-engine-event.ts` (the `EngineEvent` discriminated union lives in `types-engine-event.ts`, split from `types-engine.ts` to stay under the 600-line cap).
5. Update the Swift type in `ios/IonRemote/Models/` and the Swift contract test if field coverage changed.
6. Run `make check-contracts`, `npm test`, and `make ios-check` to verify.

If you skip a step, CI fails with a clear message identifying the drift (e.g. `"Go-only: [newField]"`).

## Logging policy

Logging is a **first-class citizen** of the architecture. Every code path must be observable through logs alone.

**Observability is the single most important property of the backend/mechanical implementation.** User experience is paramount — but the backend has no UX; where the user cannot see, observability is what makes the work real. It is the only way the engineering team and the agents working in this codebase verify that a build actually does what it claims, and the only way anyone understands why the system does — or does not do — what it should. A feature that works but cannot be observed is indistinguishable from one that is silently broken. When there is a tension between a slightly cleaner mechanism and an observable one, choose observable. Instrumentation is not overhead on the feature; it *is* part of the feature.

### No silent failures

**A failure that is invisible in the logs is a defect, regardless of whether it is otherwise handled.** Every failure branch on every surface must be observable. This rule is enforced structurally (see § "Quality gates" — `errcheck` check-blank/type-assertions, the desktop ESLint `no-floating-promises`/`no-misused-promises`/`no-empty` rules, the `check-logging` SILENT-CATCH category, and SwiftLint `empty_catch_block`), but the gates are a backstop for the discipline, not a substitute for it.

The forbidden patterns, by surface:

- **Go:** a discarded error — `_ = fn()` or an `if err != nil { return }` branch with no log. Either handle-and-log the error, or, when the discard is genuinely unactionable (a deferred `Close()` on a read-only body, best-effort cleanup, a call whose error is already logged internally), mark it `//nolint:errcheck // <reason>` so the decision is explicit and reviewed. Never a bare `_ =` on an error.
- **TypeScript:** a floating promise, an `async` function passed where a `() => void` is expected, a swallowed `.catch(() => {})`, or an empty `catch {}`. Fire-and-forget gets `void`; a failure that matters gets `.catch()` logging via `main/logger` or `renderer/rendererLogger`; a genuinely-benign swallow carries `// silent-ok: <reason>`.
- **Swift:** an empty `catch {}`, or a `try?` that discards an error on a path where the failure matters. Route the error through `DiagnosticLog.log(..., level: .warn/.error)` — never `os.Logger`/`print()`, which never reach the operator's log file.

The distinction is always the same: a failure is either **acted on and logged**, or it is **explicitly and visibly declared benign with a stated reason**. Silence is never the third option.

### Log files and format

Logs are structured JSONL (one JSON object per line). Every line has a canonical schema — see [`docs/observability/log-schema.md`](docs/observability/log-schema.md) for the full field reference.

| Surface | File | Notes |
|---|---|---|
| Engine | `~/.ion/engine.jsonl` | Go `utils.Log` / `utils.LogCtx` via slog JSON handler |
| Desktop | `~/.ion/desktop.jsonl` | Electron main process logger |
| iOS | `~/.ion/ios-diagnostic-logs.jsonl` | Written via `DiagnosticLog.log()` |
| Relay | `RELAY_LOG_FILE` (default `/var/log/ion/relay.jsonl`, inside the container) or stdout / `docker logs ion-relay` — `RELAY_LOG_OUTPUT` selects `stdout` \| `file` \| `both` (default `stdout`) | Go relay logger, canonical JSONL |
| Extensions | `~/.ion/engine.jsonl` | `component=extension`, `tag=<extension-name>` |

### Check Logs First

Check the logs before investigating any issue. All files are JSONL — use `jq` to filter rather than reading them raw.

**Filter one conversation** (all surfaces, all log lines for a conversation ID):
```bash
jq -c 'select(.conversation_id=="<id>")' ~/.ion/engine.jsonl
```

**Filter one session across all surfaces**:
```bash
jq -c 'select(.session_id=="<id>")' ~/.ion/*.jsonl
```

**Filter one extension** (by name):
```bash
jq -c 'select(.component=="extension" and .tag=="ion-meta")' ~/.ion/engine.jsonl
```

**Filter by time range** (logs after a given timestamp):
```bash
jq -c 'select(.ts >= "2024-11-15T22:00:00Z")' ~/.ion/engine.jsonl
```

**Filter by level** (errors only):
```bash
jq -c 'select(.level=="ERROR")' ~/.ion/*.jsonl
```

**When the Loki stack is running** (`docker compose up` in `docs/observability/`), use LogQL instead:

| Goal | LogQL |
|---|---|
| One conversation | `{component=~".+"} \| json \| conversation_id = "<id>"` |
| One session across surfaces | `{component=~".+"} \| json \| session_id = "<id>"` |
| Errors in time range | `{level="ERROR"}` (use Grafana time picker) |
| One extension | `{component="extension", tag="ion-meta"}` |
| Trace correlation | `{component=~".+"} \| json \| trace_id = "<32-hex-id>"` |

### Rules

1. **Every operation must log.** Before execution, after success, and inside every failure branch. A developer reading logs must be able to reconstruct the exact code path from start to finish without attaching a debugger.
2. **No blind spots.** When entering existing code that lacks sufficient logging, **add comprehensive logging as the first step** before attempting any fix or feature work. This is not optional prep — it is part of the implementation.
3. **Logging is permanent.** Never treat logs as "debug scaffolding" to be removed later. Log statements ship to production. Use appropriate levels:
   - `utils.Log` / `INFO` — state transitions, resolved decisions, operation outcomes. Always present.
   - `utils.Debug` / `DEBUG` — per-request details, intermediate values, loop iterations. Verbose but useful for replay.
   - `utils.Error` / `ERROR` — unexpected failures, caught panics, invariant violations.
4. **Include context in every log.** Always log the relevant identifiers (provider ID, model ID, session key, request ID, key lengths, URL, status codes). A log line without context is useless.
5. **Log both sides of conditionals.** If an `if/else` branch makes a decision, log which branch was taken and why. Don't log only the happy path.
6. **Desktop main process** uses the `log`/`debug`/`warn`/`error` helpers from `main/logger`. **Renderer code** uses `renderer/rendererLogger` (`rInfo`/`rDebug`/`rWarn`/`rError`/`rTrace`) — never `console.*`, which `make check-logging` (ADR-019) forbids with zero tolerance in shipped renderer code.
7. **Engine Go code** uses `utils.Log(tag, msg)`, `utils.Debug(tag, msg)`, and `utils.Error(tag, msg)`. Never use `log.Printf` or `fmt.Printf` for operational logging — those go to stderr, which is not a reliable operational channel for the headless launchd engine daemon. All operational logs must go through `utils.Log` so they land in `~/.ion/engine.jsonl`.

### Anti-patterns

- Adding a single log line per investigation cycle and hoping it's enough. **Instrument the entire code path in one pass.**
- Logging only the error case. **Log the success case too** — "operation X completed with result Y" is as valuable as "operation X failed with error Z".
- Using opaque messages like "failed" or "error occurred". **Include the what, the why, and the relevant IDs.**

## Aspirational comments

When a comment describes behavior that the code does not implement (e.g. "This is exposed to extensions via the SDK" on a method with no SDK wiring), the default assumption is that the **implementation is incomplete**, not that the comment is wrong.

1. **Investigate first.** Check whether the described behavior was partially implemented, planned in a related issue, or left behind by an incomplete PR.
2. **Implement the feature** if the comment describes a legitimate capability gap. The comment is documentation of intent — honor it.
3. **Remove the comment only** if investigation confirms the described behavior is explicitly unwanted or was superseded by a different design decision. Document why in the commit message.

Never silently delete an aspirational comment. A comment that describes unimplemented functionality is a bug report, not a false statement.

### The rule applies to plans, not just code

The Aspirational-comments rule extends to **planning artifacts**: any fix-plan, design doc, ADR draft, or PR description that resolves a finding by *documenting* the defect instead of fixing it is itself an aspirational artifact and is subject to the same rule.

Specifically forbidden as plan resolutions for *any* finding you can fix in the same branch:

- "Add a `TODO` / `FIXME` / `HACK` / `XXX` comment" — the repository forbids these markers in code; planning them is the same anti-pattern with extra steps.
- "Add a narrative comment establishing the intentional scope of a known fragility" — same anti-pattern as the TODO marker, with the marker stripped.
- "Open a follow-up issue / file a tracking ticket" as the resolution — deferring the work without doing it.
- "Add a `console.warn` / `log.Warn` when the bad case happens" without preventing the bad case.
- "Mark this for the next decomposition phase" / "address in Phase N" without doing the phase work.
- "Flag this in the PR description so reviewers know" as the only resolution.

A valid plan resolution is one of: change code, change a contract, delete code, add a test that pins behavior, or explicitly decide to do nothing with a stated rationale. "Document the problem" is not a resolution.

The `ion--review-changes.md` and `ion--align.md` commands enforce this rule at plan-generation time. Reviewers should reject any plan that violates it.

## Volatile counts — keep them out of docs and code

**Never hand-encode a count that the code already determines.** Hook count, hook-category count, provider count, command-type count, tool count, event-variant count — any "N of X" where X is enumerable in source — goes stale the moment it is written. Every commit that adds a hook, a provider, a tool, or a command silently invalidates every prose statement that pinned the old number, and nothing fails to catch it. The result is documentation that lies about the code.

This is the same defect family as the "Aspirational comments" rule above: a number that no longer matches the code is a comment that lies. The next agent or contributor reads "55 hooks" as ground truth, builds on it, and is wrong.

### The one exception

The **top-level `README.md` header badge** (the single tagline + badge line at the very top of the file) may carry a curated set of these numbers as marketing/bragging-rights figures. That surface is deliberately refreshed when the product is showcased. Nowhere else — not the README body, not a leaf doc, not a component `README.md`, not a `docs/` page, and not a code comment — may restate them.

### What to write instead

- Use qualitative phrasing: "a comprehensive set of hooks across the agent lifecycle", "a broad set of LLM providers", "the built-in core tool set".
- Link to the authoritative by-name reference: `docs/hooks/reference.md`, `docs/tools/reference.md`, or the source file (`engine/internal/extension/sdk.go`, `engine/internal/providers/provider.go`, etc.).
- **By-name lists are fine** — listing the tools or providers by name is self-maintaining and is the source of truth. A bare count is not. If you list them by name, do not also assert how many there are.

When you touch a doc or comment that pins such a count, remove the count as part of the change (good-citizen rule below). Do not "correct" it to the new number — the new number is stale on the next PR.

## Good citizen — fix what you find

If, during any feature or fix, you **stumble across something that is wrong** — a stale or incorrect comment, documentation that no longer matches the code, a failing or stale-assertion test, a lie-to-the-future of any kind — it is **always in scope**. Fix it.

You are not breaking functionality by correcting a comment, a doc, or a test; you are **restoring** it. An incorrect comment is worse than no comment: whoever comes after you will not have the context that let you silently work around the discrepancy. They will read the stale statement as ground truth and build on a falsehood, breaking a future implementation. The only safe state is: the artifact tells the truth.

### The boundary (so this never becomes a tangent)

- **Do not go hunting.** This rule fires on what you *encounter in the path of the work*, not on a codebase-wide audit you launch to find problems. No speculative sweeps.
- **Roll it into the current plan.** When you find it, add it to the plan you are executing. Do not defer it to a "future PR", an issue, or a `TODO` — deferral is the forbidden anti-pattern (see "## Aspirational comments" and the "## Scope" rule in the user's global rules).
- **Commit separately when unrelated.** The fix does not have to address the same issue you are working on. A stale comment found while implementing feature X is committed as its own `fix` / `chore` / `docs` commit at a clean scope seam, before or after the main work — it does not have to be entangled with feature X's commit.

This generalizes "## Aspirational comments" (incomplete or lying comments are bugs), "## Volatile counts" (stale counts are lies), and the global "## Scope" rule (never defer ordered work).

## Operator premises — verify before acting

Operator requests routinely contain **factual premises about the codebase** — "we only support X", "the only place that happens is Y", "this field is unused", "feature Z doesn't exist yet". These premises are frequently wrong. The author of this repository is wrong about them sometimes; new contributors are wrong about them more often. **Treat every premise as a claim to be verified, not as ground truth.**

The failure mode this rule prevents: the operator states a premise, the agent silently accepts it, and the agent then refactors, deletes, restricts, or "fixes" code based on a misunderstanding the operator would have corrected if asked. By the time the operator sees the change, the wrong work is done.

### When this rule fires

Any operator request that asserts a concrete fact about the codebase. Common signals:

- "we only support …" / "the only … is …" / "X is the only place that …"
- "we don't have …" / "there's no …" / "X doesn't exist yet"
- "X always does Y" / "X never does Y"
- "the file picker only accepts …" / "the engine only emits …" / "the SDK only exposes …"
- Any naming, shape, count, or scope claim about events, fields, hooks, tools, file types, config keys, protocol messages, or supported inputs.

The trigger is **the presence of a factual claim**, not the operator's tone or confidence. A confidently stated wrong premise is the most dangerous kind.

### What verification looks like

Before designing or implementing anything that depends on the premise:

1. **Locate the ground-truth source.** Find the code, contract, or doc that proves or disproves the claim — the actual file filter, the actual event variant list, the actual SDK surface, the actual permission list.
2. **Compare the premise to ground truth.** Be specific: "the operator said *only* `index.ts` and `extension.ts`; the manifest loader at `engine/internal/extension/manifest.go` accepts `<actual list>`."
3. **Decide based on the comparison, not the premise.**

This step is not "extra rigor." It is the first step of the work. Skipping it is a defect.

### What to do when the premise is wrong

**Stop and surface the discrepancy to the operator before doing any of the requested work.** Do not:

- Silently implement what was asked, hoping the operator was right.
- Silently implement the "corrected" version you think they meant.
- Refactor, narrow, delete, or restrict existing functionality to match the (wrong) premise.

Instead, respond with a short message that contains:

1. **The premise as stated.** ("You said we only support `index.ts` and `extension.ts`.")
2. **The ground truth.** ("The engine actually accepts `<list>`, loaded via `<path>`.")
3. **A direct question.** ("Do you still want the picker restricted to the two filenames, or should it match the engine's full set?")

Only proceed once the operator confirms which version of reality the change should target.

### What this rule is not

- It is **not** an excuse to pepper the operator with questions about every adjective in their request. The trigger is a verifiable factual claim about the codebase, not stylistic ambiguity ("make it pretty") or judgment calls ("pick a good default").
- It is **not** a license to refuse work. The expected outcome is *clarification in seconds*, then the right work — not an extended debate.
- It is **not** limited to the author. New contributors and external developers will hit this more often than the author does. The rule exists because *any* operator can be wrong about *any* codebase fact, and the agent is the last line of defense against acting on the wrong fact.

### Anti-patterns

- "The operator said X, so I'll implement X." — Without verifying X against the code, this is the exact failure mode the rule exists to prevent.
- "I noticed the premise is wrong, but I implemented what they asked anyway and noted it in the response." — Too late. The wrong work is done. Surface the discrepancy *before* writing code, not after.
- "I noticed the premise is wrong, so I implemented what I thought they really meant." — Also wrong. Confirm with the operator which version is correct; do not silently substitute your interpretation.
- "The premise is *probably* right, I'll skip verification." — The premises that look most obviously right are the ones where verification is cheapest and the cost of being wrong is highest. Verify anyway.

## Solution quality — no cheap substitutes

Every solution must solve the problem at its root cause. **Never trade correctness for implementation convenience.**

### Rules

1. **Never substitute a heuristic for a precise mechanism.** If the problem requires tracking identity, track identity — don't approximate it with a distance metric. If the problem requires a boundary marker, store a boundary marker — don't estimate freshness from a turn counter. Heuristics drift, precise mechanisms don't.

2. **"Simpler to implement" is not a valid justification for a weaker solution.** The only acceptable reasons to choose a less rigorous approach are:
   - It would break a published contract or require a backward-incompatible change to consumers.
   - The architecture physically cannot support the approach (missing data, wrong layer, no stable identity).
   - The problem domain genuinely doesn't require the precision (not just "it's probably fine").
   
   "It's easier" and "it's fewer lines of code" are never acceptable. If the proper solution requires more work, do the work.

3. **Solve the root cause, not the symptom.** If data is stale because there's no coverage tracking, add coverage tracking — don't add a staleness heuristic that guesses whether the data is still good. If a threshold can go negative because compaction reduces token counts, reset the baseline — don't raise the threshold and hope for the best.

4. **When proposing a simpler alternative, justify it rigorously.** If you believe a simpler approach is genuinely sufficient, the explanation must include:
   - What failure modes the simpler approach introduces
   - Why those failure modes are acceptable (with specifics, not hand-waving)
   - What would need to change if the simpler approach proves insufficient
   
   If you can't articulate the failure modes, you haven't analyzed the problem deeply enough to justify the shortcut.

5. **Never avoid expanding a surface to dodge work.** If a feature requires a new event type on iOS, a new protocol field, a new enum case, or a new handler — add it. Workarounds that relay, proxy, or approximate the proper mechanism to "keep the surface small" are the same anti-pattern as substituting a heuristic for a precise mechanism. API surfaces, event surfaces, and wire protocols are meant to grow as the product grows. A comment like "iOS does not yet act on this" is a gap waiting for its first consumer, not a reason to route around the gap.

6. **When the proper fix is known, ship the proper fix — never a stopgap, stepping stone, or intermittent workaround.** If analysis has identified the correct root-cause solution, implement *that*, not a cheaper interim version of it that will have to be replaced or collapsed later. Stopgaps become legacy: they add code that the next change must first unwind, they create a second mechanism that drifts from the proper one, and they leave the real fix undone while signaling that it's "handled." This holds **regardless of how much larger the proper fix is, how many files it touches, how many commits it takes, or how many PRs it spans.** PR size, commit count, and diff size are never reasons to choose a stepping stone over the known-correct fix. The only acceptable reasons to *stage* work are the same three in rule 2 (published-contract break, architecture physically can't support it yet, domain genuinely doesn't need the precision) — and "the proper fix is bigger" is **not** one of them. If you catch yourself proposing an interim fix because the real one is more work, stop and propose the real one. Do not ask the operator to choose between a stopgap and the proper fix; if the proper fix is known, that is the plan. (This is the forward-looking complement to the "## Aspirational comments → The rule applies to plans" rule: that rule forbids *documenting* a defect instead of fixing it; this rule forbids *half-fixing* it when the full fix is known.)

## Dead code is not load-bearing until proven otherwise — verify the layer, then delete

Leaving a **no-op / pass-through / vestigial layer** in place because removing it *looks* risky — and justifying the keep with an **unverified claim** about what some caller, wire event, or consumer "still needs" — is a recurring defect. "It compiles, the tests pass, and I added a comment explaining why it stays" is **not** verification; it is the exact rationalization the "## Solution quality" rule forbids, wearing a comment as a disguise. The keep is only legitimate after you have located the *actual* load-bearing layer and proven the dead code is not it.

### The failure mode (what this rule prevents)

You encounter a handler that logs and does nothing, a helper that returns its input unchanged, an enum case routed to `break`, a field nothing reads, or a parameter every caller ignores. Removing it would touch several call sites and *feels* unsafe, so you keep it and write a comment — "kept so older clients still decode", "retained for API compat", "the desktop may still send this". Then it turns out the premise in your own comment was **false** (the current in-repo emitter *does* send it, or *no longer* sends it), and you kept the **wrong layer** for a reason that actually applied to a **different layer** — or to no layer at all. The dead code now lies to the next reader about being meaningful, and the comment lies about the wire.

### The discipline (do this every time)

When you find a no-op / vestigial / pass-through construct in the path of your work:

1. **Identify every layer involved.** A "dead" event handler is usually three separable layers: the wire **TypeKey / decoder** (what makes the bytes parse), the **typed case / struct field** (the in-memory representation), and the **handler body** (what acts on it). A "dead" helper is its **signature** vs its **callers** vs its **body**. Name them explicitly; do not treat the cluster as one indivisible thing.
2. **Find the real load-bearing layer by checking the producer/consumer in source — not from memory.** Grep the actual emitter (`desktop/src/`, the engine, the SDK), the actual callers, the actual decoder's failure mode. *"Does the live, in-repo producer still emit this? Does any caller still invoke it? What happens on the unhandled path — silent drop, or thrown error?"* Answer with a citation, not an assumption. (This is the "## Operator premises" rule applied to your *own* premise.)
3. **Delete every layer above the one that is genuinely required.** Keep only the minimum the producer/consumer actually forces you to keep, and say *why that exact layer* is required (with the source citation). If the wire decoder must stay because a live event would otherwise throw, keep the decoder and **delete the no-op handler** — do not keep both and call the handler "load-bearing."
4. **If nothing is load-bearing, delete all of it.** A construct with no producer and no consumer is not "compat surface"; it is dead code. Remove it. The "## Good citizen" rule already puts this in scope when you encounter it.
5. **Make every surviving comment true.** A comment asserting wire/caller behavior ("desktop no longer sends this", "kept for older clients") is a factual claim subject to "## Aspirational comments" and "## Volatile counts": if you did not grep it, do not write it, and if it is stale, fix it as part of the same change.

### Forbidden justifications (each is the anti-pattern, not a reason)

- "Removing it touches N call sites, so I kept it." — Effort is never a reason to keep dead code (mirrors "## Solution quality" rule 2).
- "It's safer to leave it and add a comment." — Unverified safety. A no-op that misrepresents itself as meaningful is *less* safe for the next change, not more.
- "Some older/hypothetical client might still need it." — If you cannot name and cite the live consumer, this is a guess. Verify or delete.
- "I'll leave the handler as a no-op so the event still decodes." — The handler is not what makes it decode; the TypeKey/decoder is. Keep the right layer.

### When a keep IS legitimate

Keeping a layer is correct only when step 2 produced a **cited** reason the producer or consumer forces it — e.g. the wire decoder for an event a **current in-repo emitter still sends** (removing the TypeKey would throw on a live message), or a parser still reachable by a **real cached-key / migration path**. In that case: keep the **minimum** layer, delete the rest, and write the true reason with its source citation. "Verified the desktop still emits `X` at `path:line`, so the decoder stays; the no-op handler does not" is a resolution. "Kept to be safe" is not.

## Testing is mandatory — every feature, every fix

**No feature and no bug fix is complete without a test that pins its behavior.** A change that compiles, type-checks, and "looks correct on read" is *not* verified. "I read the code and it's right" is the exact reasoning that lets defects reach production — it is never an acceptable substitute for a test.

### The non-negotiable rule

Every PR that adds a feature or fixes a bug **must** include a test that:

- **For a feature:** asserts the feature does what it is specified to do — the field arrives, the event fires, the branch is taken, the value propagates end to end.
- **For a bug fix:** *fails on the unfixed code and passes on the fixed code.* This is the definition of a regression test. If the test passes with your fix reverted, it does not test your fix — it tests something else. Before claiming a bug fix is tested, mentally (or actually) revert the fix and confirm the test goes red.

If you cannot write a test that distinguishes the fixed behavior from the broken behavior, you do not yet understand the bug well enough to claim it is fixed.

### Why this is a critical-severity rule, not a style preference

A bug found in production is *prima facie evidence that coverage was inadequate* — the feature shipped, nobody knew whether it worked, an external consumer found the failure, and only then was it corrected. **Fixing that bug without adding a test repeats the identical mistake:** the corrected behavior is once again unprotected, and the next innocuous refactor can silently re-break it with every quality gate still green. The test is what converts "we hope this works" into "we know this works, and we will know immediately if it stops."

The canonical example is this repository's own #227: `before_agent_start` shipped with no test pinning the root-vs-sub-agent payload distinction, so the root firing's empty-`AgentInfo` sentinel went undetected until an external consumer's system prompt was poisoned in production. The fix added an `IsRoot` flag — and must add the test that asserts `IsRoot` is `true` on the root firing and `false` on sub-agent firings, *and* that the wire payload serializes the field. Without that test, a later edit reverting the call site to `AgentInfo{}` passes every gate.

### What the test must actually pin (avoid false coverage)

Test the *behavior the change introduces*, not the plumbing that was already there.

- A test that asserts a handler *receives* a payload but never asserts the *new field's value* gives false confidence. If the change is "set `IsRoot: true` at the root call site," the test must assert `received.IsRoot == true` at that path — not merely that some payload arrived.
- A cross-boundary field (Go → JSON → TS/Swift) needs a **serialization** test pinning the wire shape (`"isRoot":true` present; omitted when false if `omitempty`). A Go-only struct-equality test does not protect the consumer contract.
- A "field propagates from A to B" claim needs a test that exercises A→B, not two separate unit tests that each assume the wire-up.

### Don't trade correctness for un-brittle-ness — but don't write brittle tests either

Well-architected tests survive innocuous refactors and fail only when real behavior changes. Aim for that. But "a good test is hard to write here" is **not** a license to skip the test. The bar is: pin the behavioral contract at the most stable seam available (the public hook payload, the serialized wire shape, the observable event), not the incidental internals. If the only way you can think to test it is brittle, that usually signals the behavior should be observable at a more stable boundary — fix the seam, then test it.

### Parity is part of the contract (test it too)

When a feature exists on one client and not another, or is implemented two different ways across clients, that divergence is itself a defect this rule is meant to catch. A field that flows through the snapshot to one client must have a test pinning that it reaches the other (or an explicit, documented decision that it does not apply). "One client has it, the other silently doesn't" is the class of bug that should never survive to production — pin the parity.

### The forbidden completion claim

Do not report a feature or fix as "done," "complete," or "verified" when the only verification performed is: it compiles, it type-checks, existing tests still pass, and the code reads correctly. Those are necessary but **not sufficient**. The sufficient condition is a test that exercises the new behavior and would fail without the change. If you are about to commit and there is no such test, the work is not done — write the test first.

## Conversation storage

Conversations persist as NDJSON file pairs under `~/.ion/conversations/`. Full reference: [`docs/architecture/conversation-storage.md`](docs/architecture/conversation-storage.md) — covers ID format, file layout (`.tree.jsonl`, `.llm.jsonl`, `.memory.md`), struct shapes, and the legacy migration path.
