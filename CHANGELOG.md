# Changelog

Notable user-facing and contract-affecting changes to Ion. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is per-component; the engine, desktop, relay, and iOS app ship independently. Entries here cover whichever component(s) the change touched.

## Unreleased

### Engine — soft-breaking contract changes

These changes are shipped as `feat(engine)` rather than `feat!(engine)` per the maintainer's accepted scope; the breakage is bounded to known consumers and the migration paths are documented below. Third-party harness authors should treat this section as the public migration guide.

- **Early-stop continuation is now opt-in.** The engine previously shipped with `earlyStopContinue.enabled = true` and a baked Claude-Code-style continuation prompt. It now ships with `enabled = false` and supplies no default text. To restore the old behavior:
  - **Desktop users:** toggle "Early-stop continuation nudge" on in the General settings tab. The desktop bundles a reference policy implementation in [`desktop/src/main/early-stop-policy.ts`](desktop/src/main/early-stop-policy.ts) that the toggle controls.
  - **Third-party harnesses:** wire `before_early_stop_decision` (subprocess) or respond to `engine_early_stop_decision_request` (socket) and supply your own `ContinueMessage`.
  - **Operators running the engine bare:** add a minimal extension that registers `before_early_stop_decision`, or accept that early-stop continuation will not fire.

  See [ADR-002](docs/architecture/adr/002-engine-vs-harness-early-stop.md) for the full rationale.

- **`engine_plan_mode_changed{enabled: false}` no longer fires when the model calls `ExitPlanMode`.** Consumers that listened to this event to detect a plan-exit proposal must migrate to the new `engine_plan_proposal{kind: "exit"}` event. The new event carries `planFilePath` and `planSlug` directly so consumers no longer need to scrape `permissionDenials.toolInput` to recover them. The `engine_plan_mode_changed` event continues to fire on confirmed state transitions (harness `SetPlanMode`, run start with `PlanMode: true`, plan-mode abort, user-approval chokepoint).

  See [ADR-003](docs/architecture/adr/003-state-events-vs-workflow-events.md) for the state-vs-workflow split that motivated the change.

- **`EnterPlanMode` re-entry guard now driven by `RunOptions.ImplementationPhase`.** The previous mechanism — the desktop prepending an "implementing a user-approved plan" sentence to the user prompt that the `EnterPlanMode` tool docstring instructed the model to recognize — has been replaced by a structured `RunOptions.ImplementationPhase` bool. The desktop sets the flag when the user clicks Implement; the engine skips injecting the `EnterPlanMode` sentinel tool entirely for that run. No prompt-text substring matching is required. Third-party harnesses doing implement-then-execute flows should set `RunOptions.ImplementationPhase = true` on the implementation run; the model will not see the `EnterPlanMode` tool and cannot re-propose plan mode.

- **`EnterPlanMode` tool description moved to harness.** The 18-line policy prose previously baked into `engine/internal/tools/enter_plan_mode.go` (WHEN to enter plan mode, WHAT is allowed once enabled, WHEN NOT to enter) now lives in the harness. The engine ships only a one-line neutral fallback (`"Switch the current session into plan mode."`) and a new `RunOptions.EnterPlanModeDescription` field on the wire. Harnesses set the field on every `send_prompt` to override the fallback. The desktop ships the previous prose as the `ENTER_PLAN_MODE_DESCRIPTION` constant in `desktop/src/main/prompt-pipeline.ts` and applies it automatically on every engine-tab prompt, so user-facing behavior is unchanged. Third-party harnesses copy the desktop's constant or write their own prose suited to their workflow (TUI, domain-specific framing, etc.).

  See [ADR-004](docs/architecture/adr/004-enter-plan-mode-prose-in-harness.md) for the full rationale.

### Engine — additive

- New event variant `engine_plan_proposal` (kind-discriminated; `"exit"` initially). See [Server Events](docs/protocol/server-events.md#engine_plan_proposal).
- New event variant `engine_early_stop_decision_request` carrying the wire-protocol surface for the `before_early_stop_decision` hook so socket-only harnesses can participate without running a subprocess extension.
- New client command `early_stop_decision_response` complementing the request event.
- New hooks: `before_plan_mode_enter`, `before_plan_mode_exit`, `before_early_stop_decision`, `early_stop_continued`, `system_inject`, `before_provider_request`, `workspace_file_changed`.
- New shared type `EngineCommandListing` carried inside `engine_command_registry` snapshots.
- New `RunOptions.EnterPlanModeDescription` field (and its socket-wire mirror `ClientCommand.EnterPlanModeDescription`) for the harness-supplied `EnterPlanMode` tool description per ADR-004. Additive `omitempty` — third-party harnesses that don't set it inherit the engine's one-line neutral fallback.

### Desktop

- **Git watcher ignored-directories config.** New setting `gitWatcherIgnoredDirectories` (default `['~/.ion']`). When a repo path matches an entry by exact path or subtree (segment-aware), the file watcher is not started for that directory. The panel still refreshes on window focus, tab switch, and the manual refresh button, and shows an info icon when watching is suppressed. Configurable in Settings > Git > Watcher > Ignored Directories. Eliminates churn from high-write directories like `~/.ion` (conversation logs, diagnostics). New pure module `desktop/src/main/git/ignore-paths.ts` handles tilde and `$HOME` expansion and segment-aware prefix matching.
- New setting `enableEarlyStopContinuation` in the General settings tab. Defaults to `false`. Toggle on to opt into the Claude-Code-style "keep working" nudge -- the desktop's `early-stop-policy.ts` replies to the engine's `engine_early_stop_decision_request` event with a ContinueMessage when the setting is on.
- New module `desktop/src/main/early-stop-policy.ts` implementing the reference policy for the `engine_early_stop_decision_request` wire event.
- `engine_plan_proposal` is now the primary first-class signal for plan-exit approval cards. The existing permission-denial card-render path keeps working as a back-compat fallback.
- **Desktop settings projection to iOS.** New module `desktop/src/main/projectable-settings.ts` defines an allowlist of user-projectable desktop preferences — booleans such as the early-stop nudge, AI-generated titles, expand tool results, show TODO list, Claude Code compat, bash command entry, auto-group movement, scroll on tab switch, close explorer on file open, open Markdown in preview, editor word-wrap, and hide on external launch, plus list settings like hidden notification kinds. Two new wire types: `desktop_settings_snapshot` (event, snapshot semantics) and `set_desktop_setting` (command). Settings written from iOS round-trip through the desktop's validation + persistence path and broadcast back to every paired device. The snapshot carries the projection schema (type, group, label, description, defaultValue) so iOS auto-renders new settings without a Swift change.

### iOS

- Decodes `engine_plan_proposal` cleanly (the desktop is the authoritative consumer; iOS observes for diagnostic visibility).
- Decodes `engine_early_stop_decision_request` cleanly (same posture — desktop responds, iOS observes).
- **Desktop Settings tab section.** The Settings tab gains a "Desktop Settings" NavigationLink row that pushes a per-desktop detail screen titled with the active desktop's display name. The detail screen renders the projection schema as Apple-style grouped sections with toggle rows. iOS shows settings for the currently-connected desktop only — to edit a different paired desktop, switch transports first.

### Architecture documentation

- New ADRs: [ADR-002](docs/architecture/adr/002-engine-vs-harness-early-stop.md) (engine-vs-harness for early-stop continuation), [ADR-003](docs/architecture/adr/003-state-events-vs-workflow-events.md) (state events vs workflow events).
- `docs/engine-grounding.md` gains a new "Forbidden (breaking)" bullet codifying that stopping the emission of an existing event on one of its established triggers is a breaking change, even when the wire shape is unchanged.
- `docs/architecture/agent-state.md` gains a "Related contracts" section that generalizes the snapshot-replace pattern beyond the agent-state example.
