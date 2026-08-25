# Desktop Automation

Desktop Automation executes declarative user, project, and enterprise rules from desktop-owned events. It is distinct from **AI Workflows**, which are editable prompt templates for specific assistant features.

## Definition format

Automation documents contain a trigger, optional nested `all` / `any` condition groups, and ordered steps. A step is an action or an `if` branch with `then` and optional `else` steps. Values use dotted event paths such as `payload.worktree.stage`. The evaluator never runs user-provided code, expressions, loops, or parallel graphs.

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

## Execution and safety

Main process evaluates events, persistence, conditions, causation, and main-owned worktree actions. Renderer-owned actions are typed commands sent to the owner session store and require an acknowledgement. Automation never reaches into a renderer using injected JavaScript.

Actions are finite named operations: `worktree:set-stage`, `desktop:notification`, `conversation:run`, `conversation:slash`, `tab:set-color`, `tab:set-icon`, and `tab:set-group`. Conversation actions receive `payload.directory` or derive it from triggering event's `worktreePath`; they run only through owner-renderer command bridge. Tab metadata actions target explicit `tabId`.

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
