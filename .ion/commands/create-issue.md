---
description: Open a GitHub issue on the Ion engine repo for a bug or feature request derived from the current conversation, with consumer project details scrubbed.
allowed_bash_commands:
  - gh issue create
  - gh issue list
  - gh issue view
model: smart
---

Open a GitHub issue on the `dsswift/ion` repository based on the current conversation. The issue must contain enough context for Ion engine developers to understand what to implement and how it should behave — without leaking any details about the consumer project that surfaced the need.

**Hard rules. These are load-bearing.**

- The issue is created on `dsswift/ion`. Never create on any other repo.
- The issue must contain **zero** references to the consumer project. No project names, product names, company names, internal paths, domain-specific terminology, proprietary APIs, team names, or person names from the consumer side. This is a confidentiality boundary, not a style preference.
- The issue must be written entirely in **Ion engine vocabulary**: hooks, events, tools, SDK types, config fields, providers, protocol commands, normalized events, engine sessions, extensions, harnesses, consumers. If a concept from the consumer project doesn't map to Ion vocabulary, describe the *capability gap* in generic terms ("a consumer needs to…", "an extension wants to…", "a harness using the SDK expects to…").
- You must present the draft to the user for review before creating the issue. The user is the final confidentiality gate.
- **Use the GitHub CLI (`gh`) for all GitHub operations.** Do not use `WebFetch`, `curl`, or any direct HTTP calls to the GitHub API. The `gh` CLI is already authenticated; raw API calls are not.
- After the issue is created, stop. Do not start implementing.

## Arguments

`$ARGUMENTS` — optional. When present, provides additional context, focus, or classification hints. Examples:

- `/ion--open-issue` — derive everything from the conversation
- `/ion--open-issue bug: error events are not emitted when tool execution fails` — explicit classification + focus
- `/ion--open-issue we need a hook that fires before compaction` — feature focus

If `$ARGUMENTS` contains an explicit classification keyword (`bug`, `feature`, `enhancement`), use it as a strong signal in Step 2. Otherwise, auto-detect.

## Step 1: Extract the engine-level need

Analyze the current conversation to identify the Ion engine gap. Extract:

- **What is missing or broken** — the specific engine behavior, hook, event, config field, protocol command, SDK method, or tool capability that is absent or incorrect.
- **Why it matters** — what a consumer or extension cannot do today because of this gap. Frame in generic terms.
- **How it would be used** — the expected interaction pattern (hook fires at X point, event carries Y fields, config field controls Z behavior).
- **What was tried** — any workarounds or alternatives discussed in the conversation that fell short.

If `$ARGUMENTS` provides additional context, incorporate it. If the conversation does not contain enough information to identify a specific engine-level need, stop and tell the user: "I cannot identify a specific Ion engine issue from this conversation. Describe the engine gap you want to file and I will draft the issue."

## Step 2: Classify the issue

Determine whether this is a **bug** or an **enhancement** (feature request).

**Bug** — the engine does something wrong:
- An event is emitted with incorrect fields or at the wrong time
- A hook fires with the wrong payload or doesn't fire when it should
- A config field is parsed but not applied
- A protocol command returns an error it shouldn't, or silently drops data
- Behavior contradicts the documented contract
- "It should do X but does Y"

**Enhancement** — the engine is missing a capability:
- A hook that doesn't exist yet
- An event variant or field that isn't emitted
- A config field that isn't supported
- A protocol command that isn't implemented
- An SDK method or context callback that isn't available
- "There is no way to…"

If the classification is ambiguous, default to **enhancement**. Bugs are reserved for things that are clearly broken, not things that are merely absent.

## Step 3: Identify the affected engine subsystem

Map the need to one or more Ion engine subsystems. This helps implementers know where to look.

| Subsystem | Scope |
|-----------|-------|
| `hooks` | Extension hook definitions, firing points, payload shapes (`engine/internal/extension/sdk_hooks_*.go`) |
| `events` | NormalizedEvent variants, StatusFields, engine events (`engine/internal/types/normalized_event.go`, `types.go`) |
| `protocol` | Wire protocol commands and responses (`engine/internal/protocol/protocol.go`) |
| `sdk` | SDK types, context methods, hook handler signatures (`engine/internal/extension/sdk_types.go`, `sdk.go`) |
| `config` | EngineConfig, EngineRuntimeConfig, settings (`engine/internal/types/config.go`, `engine/internal/config/`) |
| `tools` | Built-in tool definitions and execution (`engine/internal/tools/`) |
| `session` | Session lifecycle, manager, prompt dispatch (`engine/internal/session/`) |
| `backend` | API/CLI backend, run loop, tool execution pipeline (`engine/internal/backend/`) |
| `providers` | LLM provider implementations (`engine/internal/providers/`) |
| `permissions` | Permission evaluation, patterns, sandbox (`engine/internal/permissions/`, `engine/internal/sandbox/`) |
| `conversation` | Persistence, branching, compaction (`engine/internal/conversation/`) |
| `mcp` | MCP client, tool/resource bridge (`engine/internal/mcp/`) |
| `transport` | Unix socket, relay client (`engine/internal/transport/`) |

Use the subsystem label(s) in the issue title prefix and body.

## Step 4: Build the issue

### Title

Write a clear, action-oriented title:

- **Bugs:** `[subsystem] Describe what is broken` — e.g. `[hooks] before_tool_execution hook does not fire for MCP tools`
- **Enhancements:** `[subsystem] Describe what should exist` — e.g. `[hooks] Add before_compaction hook with token count and strategy in payload`

Title should be specific enough that someone scanning the issue list knows exactly what it's about without opening it.

### Body

Use the appropriate template below. Every section is required unless marked optional.

#### Enhancement template

```markdown
## Summary

<1-2 sentences: what capability the engine should have>

## Motivation

<Why this is needed. Describe the use case generically:>
<- "A consumer building [generic description] needs to…">
<- "An extension that [generic purpose] wants to…">
<- "A harness using the SDK expects to…">
<Do NOT name the specific consumer, project, product, or domain.>

## Proposed behavior

<Describe the expected engine behavior in detail:>
<- When does it fire / what triggers it?>
<- What data does it carry / what fields are included?>
<- What can a consumer do with it?>
<- How does it interact with existing hooks/events/config?>

<If proposing a hook, include the expected payload shape:>
```go
// Example payload shape (proposed)
type BeforeCompactionPayload struct {
    SessionID     string `json:"sessionId"`
    TokenCount    int    `json:"tokenCount"`
    Strategy      string `json:"strategy"`
}
```

<If proposing an event, include the expected wire format:>
```json
{"type": "example_event", "data": {"field": "value"}}
```

<If proposing a config field, show where it fits in EngineConfig:>
```json
{"newField": "defaultValue"}
```

## Use case examples

<2-3 concrete examples of how a consumer or extension would use this capability.>
<Frame each as: "A consumer could…", "An extension would…", "A harness might…">
<Show example SDK code, hook handlers, or config snippets where helpful.>

## Acceptance criteria

- [ ] <Specific, testable criterion>
- [ ] <Specific, testable criterion>
- [ ] <Criterion about contract: e.g. "New field has zero-value default, additive-only">
- [ ] <Criterion about cross-language sync if types are affected: e.g. "TypeScript and Swift mirrors updated">

## Affected subsystems

<Comma-separated list from the subsystem table above>

## Alternatives considered (optional)

<If the conversation discussed workarounds or alternative approaches that were rejected, describe them generically and explain why they fell short.>
```

#### Bug template

```markdown
## Summary

<1-2 sentences: what is broken and what the correct behavior should be>

## Current behavior

<What the engine currently does. Be specific: which event, hook, config field, or protocol command misbehaves, and how.>

## Expected behavior

<What the engine should do instead. Reference the contract, documentation, or logical expectation.>

## Steps to reproduce

1. <Step using Ion engine vocabulary: "Start a session with config X">
2. <Step: "Send a prompt that triggers tool Y">
3. <Step: "Observe event Z">

<If the bug is observable through the wire protocol, show the actual vs. expected NDJSON.>
<If the bug is in a hook payload, show the actual vs. expected payload.>

## Context

<How this was discovered, framed generically:>
<- "A consumer observed that…">
<- "While building an extension that…">
<Do NOT name the specific consumer, project, or domain.>

## Acceptance criteria

- [ ] <The specific behavior that should be fixed>
- [ ] <Regression test that pins the fix>
- [ ] <Contract compliance if applicable>

## Affected subsystems

<Comma-separated list from the subsystem table above>
```

## Step 5: Confidentiality scrub

**This step is mandatory. Do not skip it.**

Before presenting the draft, walk this checklist against the **entire issue body and title**. For each item, actively search the text. If found, replace with the generic equivalent shown.

| Check | What to look for | Replace with |
|-------|-----------------|--------------|
| Project names | Any project, product, or repo name other than `ion`, `dsswift/ion` | "a consumer project", "a downstream project" |
| Company names | Any company or organization name other than `dsswift` | "an organization", "a team" |
| Person names | Any person's name other than public Ion contributors | Remove entirely |
| Internal paths | File paths outside `engine/`, `desktop/`, `ios/`, `relay/`, `docs/` | "a consumer's codebase", or remove |
| Domain terms | Industry-specific or product-specific terminology that reveals what the consumer does | Generic equivalent: "a workflow", "a data pipeline", "a user-facing feature" |
| Proprietary APIs | References to non-public APIs, databases, internal services | "an external service", "a backend API" |
| Internal URLs | URLs pointing to internal tools, dashboards, repos (not `dsswift/ion`) | Remove entirely |
| Logs/output | Console output, error messages, or stack traces containing consumer-specific data | Redact consumer-specific portions, keep only Ion engine frames |
| Conversation quotes | Direct quotes from the conversation that contain consumer context | Rephrase in Ion engine terms |

After the scrub, re-read the full draft one more time with the question: *"If a stranger read this issue, could they determine what project filed it, what that project does, or who works on it?"* If the answer is anything other than a firm no, scrub again.

## Step 6: Present draft for review

Show the user the complete draft in this format:

```
📋 Ion Engine Issue Draft

Classification: <Bug | Enhancement>
Subsystems: <list>
Repo: dsswift/ion

---

Title: <title>

---

<full issue body>

---

🔒 Confidentiality check:
  - Project/product names: ✅ none found
  - Company names: ✅ none found
  - Person names: ✅ none found
  - Internal paths: ✅ none found
  - Domain-specific terms: ✅ none found (or: ⚠️ "<term>" replaced with "<generic>")
  - Proprietary APIs: ✅ none found
  - Internal URLs: ✅ none found
```

Then call `AskUserQuestion` with the question "Ready to create this issue on dsswift/ion?" and options: `Create it`, `Make changes`.

Do **not** create the issue until the user selects `Create it`. If the user selects `Make changes` or describes edits, apply them, re-run the confidentiality scrub (Step 5), and present the updated draft with another `AskUserQuestion`.

## Step 7: Create the issue

Once the user confirms:

```bash
gh issue create --repo dsswift/ion --title "<title>" --label "<bug|enhancement>" --body "<body>"
```

If the `gh` command fails, report the error and stop. Do not retry with different parameters unless the user asks.

## Step 8: Plan-mode integration

If this command was invoked while an active plan exists, restructure the plan so that the engine work tied to this issue is isolated, worked first, and committed independently — before any other plan items are touched. This prevents scope creep from bundling unrelated consumer-side changes into commits that close an engine issue.

**The core principle:** An engine issue's closing commit(s) must contain only the work that resolves that issue. Consumer-side work that happens to be in the same plan is separate work with separate commits that do not reference the issue.

### Detect the active plan

Resolve the most recently modified plan file:

```bash
ls -1t ~/.ion/plans/*.md 2>/dev/null | head -1
```

If no plan file exists, skip this step entirely — there is no plan to update.

If a plan file is found, read it and check whether it is plausibly related to the conversation (the plan's title or content should overlap with the engine gap that was just filed). If the plan is clearly unrelated (e.g. it's about a completely different feature), skip this step and note in the report: "⚠️ Active plan found but appears unrelated — skipped plan update."

### Analyze the plan and partition the work

Read the full plan. Identify every item in the plan (steps, file modifications, verification tasks) and classify each as one of:

- **Issue work** — directly resolves the engine issue that was just filed. This includes: engine code changes, engine test additions, contract manifest regeneration, cross-language type sync (TS/Swift mirrors of engine types), engine documentation updates. These are the items whose commits carry the `(#N)` suffix and `Closes #N` trailer.
- **Remaining work** — everything else in the plan. Consumer-side code changes, consumer tests, consumer config, harness/extension changes, UI changes, anything that is not part of the engine issue resolution. These items are committed separately with no issue reference.

If the entire plan is engine issue work (e.g. the plan was created specifically to address this gap), then there is no partition — the whole plan is issue work. Note this in the section.

If the plan contains no engine issue work (e.g. the issue was filed as a future need, not something this plan implements), note that the issue is filed for future work and the current plan proceeds without issue association.

### Update the plan

Add an `## Issue Association` section to the plan. Insert it immediately after the plan's first heading (the `# Title` line) and before any existing content.

The section has three parts: the issue reference, the execution order, and the commit rules.

```markdown
## Issue Association

**GitHub Issue:** dsswift/ion#<number> — <title>
**Classification:** <Bug | Enhancement>

### Execution order

The engine work that resolves this issue must be implemented and committed **before** the remaining plan items. This is not optional — it prevents scope creep from bundling unrelated changes into the issue's closing commit.

**Phase 1 — Engine issue resolution (commits reference #<number>):**
<bulleted list of the specific plan items that are issue work — file paths, steps, tests>

**Phase 2 — Remaining plan work (commits do NOT reference #<number>):**
<bulleted list of the remaining plan items, or "None — the entire plan is issue work">

### Commit rules for Phase 1

All Phase 1 commits must associate with the issue per AGENTS.md rules:
- **Subject line:** append ` (#<number>)` — e.g. `feat(engine): add before_compaction hook (#<number>)`
- **Body trailer:** include `Closes #<number>` (or `Fixes #<number>` for bug fixes) on its own line at the end of the commit body. Only the **final** Phase 1 commit carries `Closes`/`Fixes`; earlier Phase 1 commits (if multiple) use the `(#<number>)` subject suffix but omit the closing trailer so the issue isn't closed prematurely.
- Both subject suffix and body trailer are required on the final commit. Subject alone gives the auto-link but won't close the issue; body alone closes but isn't visible in short logs.

Phase 2 commits use normal conventional commit format with no issue reference.
```

**Rules for the plan update:**

- Do not rewrite any other part of the plan. Only add the `## Issue Association` section.
- The partition must be specific — list actual file paths and plan step references, not vague categories. The implementer should be able to look at this section and know exactly which items belong to Phase 1 vs. Phase 2 without re-reading the full plan.
- If the plan already has an `## Issue Association` section (e.g. from a prior run of this command), replace it with the updated one. Do not duplicate.
- The section must use the actual issue number from Step 7, not a placeholder.

## Step 9: Report

Print:

```
✅ Issue #<number> created: <URL>
   <title>
   Classification: <Bug | Enhancement>
   Subsystems: <list>
```

If Step 8 updated a plan:

```
📋 Plan updated: <plan file path>
   Phase 1 (issue #<number>): <N> items — engine work, committed first
   Phase 2 (no issue ref): <N> items — remaining plan work
```

If the entire plan is issue work:

```
📋 Plan updated: <plan file path>
   All plan items are issue #<number> work — no phase split needed
```

If the issue is filed for future work (not implemented by this plan):

```
📋 Plan updated: <plan file path>
   Issue #<number> filed for future work — current plan proceeds without issue association
```

If Step 8 was skipped (no plan or unrelated plan):

```
ℹ️ No active plan updated (no plan found / plan appears unrelated)
```

After this line, the response ends. Do not offer to start implementing. Do not open a PR. The issue is now in the Ion engine backlog for prioritization.
