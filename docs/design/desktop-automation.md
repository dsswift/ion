# Desktop Automation

Desktop Automation executes declarative user, project, and enterprise rules from desktop-owned events. It is distinct from **AI Workflows**, which are editable prompt templates for specific assistant features.

## Definition format

Automation documents contain a trigger, optional nested `all` / `any` condition groups, and ordered steps. A step is an action or an `if` branch with `then` and optional `else` steps. Conditions use dotted event paths such as `payload.stage` (the current worktree stage) and `payload.messageKind`. The evaluator never runs user-provided code, expressions, loops, or parallel graphs.

The current worktree stage is not something a producer knows, so the runtime resolves it once, before evaluation: for any event whose payload carries a `worktreePath` that names a registered worktree, it adds the live `payload.stage` from the registry. An unregistered or unstaged directory leaves `stage` absent (never an empty-string sentinel).

### Conditions fail closed on an absent path

`exists` matches a present non-null value and `not-exists` matches an absent or null value. Every other operator — including the negative `not-equals` and `not-contains` — returns false when the path is absent or malformed, so a rule gated on a field never fires for an event that lacks it. A present JSON `null` remains a real value for equality.

```json
{
  "version": 2,
  "definitions": [{
    "id": "verified-align",
    "name": "Verified runs alignment",
    "enabled": true,
    "trigger": { "kind": "event", "event": "worktree:stage-changed" },
    "condition": { "all": [
      { "path": "payload.stage", "operator": "equals", "value": "verified" },
      { "path": "payload.source", "operator": "equals", "value": "operator" }
    ] },
    "steps": [{ "kind": "conversation:slash", "payload": { "command": "align" } }],
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z"
  }]
}
```

## Sources

- User definitions live one per JSON file in `~/.ion/automation/`.
- Project definitions live one per JSON file in `{project}/.ion/automation/` and are committed with that project.
- Enterprise definitions live under `customFields['ion-desktop'].automation`; engine passes the opaque policy through and desktop validates its owned shape.

Definitions with identical ids resolve enterprise over project over user. Other definitions are additive. A local project disable ledger is stored under `~/.ion/automation-project-state/`, so disabling a project rule does not dirty its checkout.

### Source-aware listing and user-only CRUD

Settings reads a source-aware listing: every source layer that defines an id, tagged with its `source`, whether it is `effective`, `locallyDisabled` (project rules), and `overriddenBy` (the higher layer that owns the id). A locally disabled project rule stays in the listing so the operator can enable it again. The runtime still receives only effective definitions — both come from one resolution pass.

Persistence is per-item user CRUD, never a whole-list write. The main process owns the user set: it reloads the store, applies the one requested create/update/delete, validates the result, and writes atomically. It never trusts the renderer to send the source-of-truth list, so a project, enterprise, or built-in rule can never be copied into `~/.ion/automation/`. Making a non-user rule editable is an explicit **Duplicate** into a new, disabled user definition. An enterprise lock blocks user mutations without hiding any definition or its history.

## The message-submitted event and the refinement loop

`conversation:message-submitted` fires once for every admitted client Message, from both the fresh-prompt path and a mid-run **Steer**. (`prompt:submitted` and `conversation:slash` remain for compatibility.) Its payload carries `messageKind` (`prompt` / `slash` / `structured` / `machine`), `permissionMode`, `isSteer`, `source`, `worktreePath`, and the normalized `stage`. Authorship is classified at the client boundary from the source marker and injection kind — never inferred from the message text — so a slash command, a Guided Questions answer, and a machine-authored injection are each distinguished from an ordinary operator prompt.

This supports the two-way worktree refinement loop:

1. A registered worktree is in `test` (**Needs testing**).
2. The operator sends a normal auto-mode Message (a fresh prompt or a Steer) to its conversation.
3. A rule on `conversation:message-submitted` (conditions: `worktreePath` exists, `stage` = `test`, `messageKind` = `prompt`, `permissionMode` = `auto`) moves it to `bug` (**Issue found**).
4. A later changed bench pin fires `worktree:pin-advanced`.
5. The inverse rule moves `bug` back to `test`.

A slash command, plan-mode Message, structured answer, or machine-authored Message does not start the transition, because each fails one of the conditions.

## The Automation Editor

The shared Settings category renders the **Automation Editor**: one panel with three labeled sections — When / If / Then — not a wizard. The whole rule is visible and editable at once. The list stays visible while editing; selecting a rule opens the editor inline and swapping the selection swaps its content in place.

Every control offers only what the catalog allows for the selected trigger: the When picker lists real events, each condition offers only that event's fields and each field's valid operators, and finite values render as selects (a worktree stage shows **Needs testing** and stores `test`, **Ready to land** stores `ready`). Free text or numbers appear only for genuinely open values. There is no raw path input and no `payload.` placeholder — a new condition starts valid. Save stays disabled until the rule is runnable, with an inline plain-language preview. A rule that uses a construct the guided form cannot represent (nested condition groups, conditional branches) is shown read-only and preserved verbatim rather than flattened.

## Execution and safety

Main process evaluates events, persistence, conditions, causation, and main-owned worktree actions. Renderer-owned actions are typed commands sent to the owner session store and require an acknowledgement. Automation never reaches into a renderer using injected JavaScript.

Actions are finite named operations: `worktree:set-stage`, `desktop:notification`, `conversation:run`, `conversation:slash`, `tab:set-color`, `tab:set-icon`, and `tab:set-group`. An action's target is derived from the triggering event, never asked for as a raw id: a worktree/directory action uses the event's `worktreePath` (or an operator-chosen fixed directory when the trigger cannot supply one), and a tab action targets the triggering conversation. Renderer-owned actions run only through the owner-renderer command bridge.

Every derived event carries a causation root and workflow chain. A workflow already in its own chain is blocked; a non-cyclic chain is capped. Blocked/failing work is recorded in local history and logged.

Saving and enabling a user/project rule is standing authorization for its exact configured AI actions. Enterprise rules need explicit enterprise authorization before they may run an AI action. Every automated AI command is recorded in automation history.

## Extending

Add a trigger at its durable main-process chokepoint, build only documented context fields, and call the automation runtime after the owning write or operation succeeds. Add an action in the runtime registry. Actions must be typed and narrow; renderer state changes use the owner command bridge. Add shared evaluator/runtime tests before exposing a descriptor in the editor.

## Local pin-advance workflow example

When a worktree's committed change reaches an integration bench, the desktop emits the `worktree:pin-advanced` event. The desktop does not decide a workflow stage transition. An operator who wants the `Issue found` → `Needs testing` behavior saves this local definition under `~/.ion/automation/`:

```json
{
  "version": 2,
  "definitions": [{
    "id": "local.issue-fix-reaches-bench-needs-testing",
    "name": "When an issue fix reaches the bench, move it to Needs testing",
    "enabled": true,
    "trigger": { "kind": "event", "event": "worktree:pin-advanced" },
    "steps": [{
      "kind": "worktree:set-stage",
      "payload": { "stage": "test", "onlyIfStage": "bug" }
    }],
    "createdAt": "2026-01-01T00:00:00Z",
    "updatedAt": "2026-01-01T00:00:00Z"
  }]
}
```
