# Ion

## Layout

| Component | Path | Language |
|-----------|------|----------|
| Engine | `engine/` | Go |
| Desktop | `desktop/` | TypeScript (Electron + React) |
| Relay | `relay/` | Go |
| iOS | `ios/IonRemote/` | Swift |

Each component has its own `AGENTS.md` with subsystem-specific rules.

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

**Never run `make desktop`.** It builds, packages, installs to `/Applications`, and relaunches the desktop app. If you are running inside an Ion session, this kills the engine process hosting your conversation and often loses conversation state. The user runs `make desktop` manually when they are ready. If a desktop rebuild is needed, tell the user to run it.

## Quality gates (must pass before merge)

| Gate | Command |
|------|---------|
| File-size cap | `make check-file-sizes` |
| Contract sync | `make check-contracts` |
| Engine tests + race | `cd engine && go test -race ./...` |
| Engine integration | `cd engine && go test -race -tags integration ./tests/integration/...` |
| Engine vuln | `cd engine && govulncheck ./...` |
| Engine lint | `cd engine && golangci-lint run` (full mode on both PR and main) |
| Relay tests + race | `cd relay && go test -race ./...` |
| Desktop typecheck | `cd desktop && npm run typecheck` |
| Desktop tests | `cd desktop && npm test` |
| Desktop audit | `cd desktop && npm audit --audit-level=high --omit=dev` |
| iOS build | `make ios-check` |

CI: `.github/workflows/build.yml` (release), `.github/workflows/quality.yml` (per-PR).

## Branch workflow

- `main` is protected. All changes merge via pull request — never push directly to `main`.
- The current working branch can be any named feature branch (e.g. `josh`, `feat/foo`, `fix/bar`). Never hardcode a branch name; always use `git branch --show-current` to determine the active branch.
- **Standard flow:**
  1. Do work on the current feature branch, commit locally.
  2. When an external PR lands on `main` that your branch depends on or should incorporate: merge it on GitHub (`gh pr merge <number> --merge`), then `git checkout main && git pull` to sync local `main`, then `git checkout <feature-branch> && git rebase main` to rebase the feature branch onto the updated `main`.
  3. Open a PR from the feature branch into `main` (`gh pr create`). Never push directly to `main`.
- CI must pass on the PR before merge. Run quality gates locally first (see table below).

## Commits

- Conventional Commits with **required scope**: `type(scope): subject`.
- Allowed types: `feat`, `fix`, `chore`, `docs`, `feat!`.
- Allowed scopes (from `.commit.json`):

| Scope | Path trigger |
|-------|-------------|
| `engine` | `engine/` |
| `desktop` | `desktop/` |
| `relay` | `relay/` |
| `ios` | `ios/` |
| `docs` | `docs/` |
| `repo` | `.github/`, root files, or cross-cutting changes |

- Pick the scope matching the primary path touched. If files span multiple scopes, use the scope of the *primary* change; for pure CI/config/root changes use `repo`.
- Examples: `feat(engine): add streaming support`, `fix(desktop): correct tab order`, `chore(repo): update ci workflow`.
- Subject ≤ 65 chars, lowercase, imperative, no period. (Commitlint's hard cap from `@commitlint/config-conventional` is 72; 65 leaves headroom for the ` (#N)` issue suffix without tripping the warning.)
- **Issue association is mandatory when working from a GitHub issue.** If the work was initiated by an issue (e.g. user said "let's work on #126"), the commit must associate it both ways:
  - **Subject line**: append ` (#N)` so GitHub auto-links and the issue number is visible in `git log --oneline`. Example: `fix(engine): wire agent_start / agent_end hooks (#126)`. Stay within the 65-char subject cap; precedent: commit `a73824a9` (`fix(engine): wire before_provider_request hook (#128)`).
  - **Body trailer**: include `Fixes #N` (or `Closes #N` for non-bug work) on its own line at the end of the body. This is what GitHub uses to auto-close the issue when the PR merges.
  - Both are required. Subject alone gives the auto-link but won't close the issue; body alone closes the issue but isn't visible in short logs.
- Never `--no-verify`.
- Never commit `.env*`, `appsettings.json`, `local.settings.json`, `engine/tests/e2e/testconfig.json`.
- Never `git push`. Tell the user the changes are ready.

## Layered architecture

| Layer | Where | Role |
|-------|-------|------|
| Engine | `engine/` (Go) | Hooks, events, tools, LLM streaming. Headless, no UI concepts. |
| Harness | `~/.ion/extensions/` (TS) | Extensions via SDK. Decides behavior. |
| Client | `desktop/`, `ios/` | Renders UI from engine events. |

Engine executes, harness decides. Engine never blocks for user input, never persists memory, never decides policy.

When labeling work: engine, harness, or client. If a harness gap is caused by missing engine capability, note both.

## Engine consumers

The Ion engine is the product. Desktop and iOS are **reference implementations** — one opinion on how to use the engine, not the only way. The engine's real consumers are external developers building their own clients, extensions, and integrations against the wire protocol and SDK.

Consequences:

- **Do not require an in-repo consumer before adding engine API surface.** If a hook, protocol field, or SDK method is useful to external consumers, it belongs in the engine — even if desktop and iOS don't use it yet. The absence of desktop/iOS usage is not evidence of premature code; it is evidence that the reference implementations haven't caught up.
- **Engine API surface should be generous.** Every configurable behavior should be exposed: as an `engine.json` config field, as a per-prompt `ClientCommand` override, and (where applicable) as an SDK context method. External consumers want every hook we can imagine.
- **Desktop and iOS are not gatekeepers.** They consume the engine; they do not define its surface. When reviewing engine changes, do not ask "does desktop use this?" — ask "would an external consumer want this?"

## Cross-platform parity (desktop ↔ iOS)

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
| Engine instance bar (EngineStatusBar) | Engine instance bar (EngineInstanceBar) | `snapshot.ts` → `RemoteTabState.engineInstances` |
| Permission denials / waiting state | Permission queue / waiting state | `snapshot.ts` promotes denials into `permissionQueue`; per-instance `waitingState` on `engineInstances` |
| Tab group pills | Tab group sections | `snapshot.ts` → group fields on `RemoteTabState` |
| Thinking indicator / interrupt button | Activity indicator / interrupt button | Real-time events (`engineTextDelta`, `tabStatus`) |

### When to skip iOS

Only when the interface physically cannot work on iOS (e.g. a keyboard-only interaction, a desktop window management feature, or a rendering surface that doesn't exist on mobile). In that case:
- Note in the PR description why iOS was skipped.
- Consider whether an alternate mobile-appropriate rendering exists.
- At minimum, ensure the iOS app doesn't break or show stale data because of the desktop change.

## Contract stability (never break the client)

The client is the consumer of the Ion engine — desktop, iOS, and harness extensions all depend on published contracts. **Never ship a breaking change to a published contract.**

Event-shape contracts are not just about field names. Event **semantics** (snapshot vs. incremental, replace vs. merge, idempotency) are also part of the contract. See [docs/architecture/agent-state.md](docs/architecture/agent-state.md) for the canonical example: `engine_agent_state` is always a complete snapshot, and consumers replace local state with the payload.

### What counts as a contract

| Surface | Key files |
|---------|-----------|
| Wire protocol | `engine/internal/protocol/protocol.go` (`ClientCommand`, `ServerMessage`, NDJSON shape) |
| NormalizedEvent variants & fields | `engine/internal/types/normalized_event.go`, mirrored in `desktop/src/shared/types.ts` and `ios/IonRemote/Models/NormalizedEvent.swift` |
| SDK types & hook signatures | `engine/internal/extension/sdk_types.go`, `sdk_hook_types.go` (`HookHandler`, `Context`, payload types) |
| Hook names & payload shapes | All hooks registered in `engine/internal/extension/sdk_hooks_*.go` |
| Engine events consumed by clients | Any event type or field a client reads to render UI |

### Allowed (non-breaking)

- **Add** new fields with zero-value defaults, new event variants, new hooks, new optional parameters.
- **Fix** bugs in existing methods (behavior change that corrects a documented or obvious defect).
- **Version** a new alternative when a design must evolve (e.g. `ToolCallV2`) — leave the original intact.

### Forbidden (breaking)

- Remove or rename a field, type, constant, hook name, or event variant.
- Change a field's type (e.g. `string` → `int`, `[]T` → `map`).
- Alter a hook's payload shape in a non-additive way.
- Remove or reorder positional arguments in an SDK callback signature.
- Change wire-protocol message framing or envelope structure.

If you believe a break is truly necessary, stop and discuss with the user — never commit it silently.

### Cross-language contract sync

Go is the source of truth. A reflection-based test (`engine/internal/types/contract_test.go`) extracts every shared struct's JSON field names into a golden manifest (`engine/internal/types/testdata/contracts.json`). TS and Swift tests validate against it.

**Workflow when you change a shared type (NormalizedEvent variant, StatusFields, EngineConfig, etc.):**

1. Make the Go change in `engine/internal/types/`.
2. Regenerate the manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`
3. Update the TS field map in `desktop/src/shared/__tests__/contract-sync.test.ts` to match.
4. Update the TS type definition in `desktop/src/shared/types-engine.ts` or `types-events.ts`.
5. Update the Swift type in `ios/IonRemote/Models/` and the Swift contract test if field coverage changed.
6. Run `make check-contracts`, `npm test`, and `make ios-check` to verify.

If you skip a step, CI fails with a clear message identifying the drift (e.g. `"Go-only: [newField]"`).

## Logging policy

Logging is a **first-class citizen** of the architecture. Every code path must be observable through logs alone.

### Check Logs First

Check the logs before assuming anything when investigating issues.
Caution: These files are large >20KB. Use intelligent searching when looking through the logs, don't just try to read the whole file.

- Engine Logs: ~/.ion/engine.log
- Desktop Client Logs: ~/.ion/desktop.log
- iOS Diagnostic Logs: ~/.ion/ios-diagnostic-logs.txt

### Rules

1. **Every operation must log.** Before execution, after success, and inside every failure branch. A developer reading logs must be able to reconstruct the exact code path from start to finish without attaching a debugger.
2. **No blind spots.** When entering existing code that lacks sufficient logging, **add comprehensive logging as the first step** before attempting any fix or feature work. This is not optional prep — it is part of the implementation.
3. **Logging is permanent.** Never treat logs as "debug scaffolding" to be removed later. Log statements ship to production. Use appropriate levels:
   - `utils.Log` / `INFO` — state transitions, resolved decisions, operation outcomes. Always present.
   - `utils.Debug` / `DEBUG` — per-request details, intermediate values, loop iterations. Verbose but useful for replay.
   - `utils.Error` / `ERROR` — unexpected failures, caught panics, invariant violations.
4. **Include context in every log.** Always log the relevant identifiers (provider ID, model ID, session key, request ID, key lengths, URL, status codes). A log line without context is useless.
5. **Log both sides of conditionals.** If an `if/else` branch makes a decision, log which branch was taken and why. Don't log only the happy path.
6. **Desktop main process** uses the `log()` helper from `../logger`. Renderer code uses `console.log` sparingly (performance-sensitive hot paths excepted).
7. **Engine Go code** uses `utils.Log(tag, msg)`, `utils.Debug(tag, msg)`, and `utils.Error(tag, msg)`. Never use `log.Printf` or `fmt.Printf` for operational logging — those go to stderr which is invisible when the desktop spawns the engine. All operational logs must go through `utils.Log` so they land in `~/.ion/engine.log`.

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

## Conversation storage

Conversations are persisted as NDJSON file pairs under `~/.ion/conversations/`.

### ID format

Each conversation ID is `{unix-millis}-{12-hex-chars}` (e.g. `1780093348767-c1c03e998388`). Generated in `engine/internal/backend/runloop_setup.go` via `time.Now().UnixMilli()` + `newConvSuffix()` (see `runloop_helpers.go`).

### File layout

A conversation with ID `<id>` produces up to three files:

| File | Purpose |
|------|---------|
| `<id>.tree.jsonl` | Conversation tree for rendering and branching. Source of truth for the full message history with parent/child relationships. |
| `<id>.llm.jsonl` | LLM-authoritative message history. Source of truth for what the model actually saw and for token/cost accounting. |
| `<id>.memory.md` | Session memory summary. Background-generated Markdown summary used for zero-cost compaction and system prompt injection. Optional — only present after enough turns and token growth. |

Legacy formats may also exist: `.jsonl` (v1) and `.json` (v0). The engine auto-migrates legacy files to the split format on the next save.

### `.tree.jsonl` structure

- **Line 1 (header):** JSON object with `"meta": true`, `"id"`, `"leafId"`, `"workingDirectory"`, `"version"`.
- **Subsequent lines:** `SessionEntry` objects (`engine/internal/conversation/conversation.go`), each with:
  - `id` — unique entry identifier
  - `parentId` — pointer to parent entry (null for roots)
  - `type` — one of `message`, `compaction`, `model_change`, `label`, `custom`
  - `timestamp` — Unix millis
  - `data` — type-specific payload (message content, compaction summary, etc.)

### `.llm.jsonl` structure

- **Line 1 (header):** JSON object with `"meta": true`, `"id"`, `"version"`, `"model"`, `"system"` (system prompt), `"totalInputTokens"`, `"totalOutputTokens"`, `"lastInputTokens"`, `"lastInputTokensMsgCount"`, `"totalCost"`, `"createdAt"`, and optional `"parentId"`.
- **Subsequent lines:** `LlmMessage` objects (`engine/internal/types/llm.go`), each with:
  - `role` — `user`, `assistant`, or `system`
  - `content` — string or array of `LlmContentBlock` (text, tool_use, tool_result, image, etc.)

### Looking up a conversation

When given a conversation ID, glob for its files:

```
~/.ion/conversations/{id}.*
```

- Read `{id}.tree.jsonl` for the full message history with branching structure.
- Read `{id}.llm.jsonl` for the LLM-side view, system prompt, and token/cost accounting.
- Read `{id}.memory.md` for the background session memory summary (if present).
- If only `{id}.jsonl` or `{id}.json` exists, the conversation is in legacy format (pre-split).

### Key source files

| What | Where |
|------|-------|
| ID generation | `engine/internal/backend/runloop_helpers.go` (`newConvSuffix`) |
| Save/load logic | `engine/internal/conversation/persistence.go` (`Save`, `Load`, `saveSplit`) |
| Data structures | `engine/internal/conversation/conversation.go` (`Conversation`, `SessionEntry`) |
| LLM message type | `engine/internal/types/llm.go` (`LlmMessage`) |