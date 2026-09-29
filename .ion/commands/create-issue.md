---
description: Open a GitHub issue on the Ion repo for a bug or feature request derived from the current conversation, with consumer project details scrubbed.
allowed_bash_commands:
  - gh issue create
  - gh issue list
  - gh issue view
---

# /create-issue

Open a GitHub issue on `dsswift/ion` from the current conversation. The issue gives Ion developers enough to know what to build and how it should behave, and it carries nothing about the consumer project that surfaced the need.

## Rules

- The issue is created on `dsswift/ion`.
- The issue names no consumer project. That covers project, product, company, team, and person names, internal paths, domain terminology, and proprietary APIs. This is a confidentiality boundary.
- The issue is written in Ion vocabulary (`docs/vocabulary/terms.json`): hooks, events, tools, SDK types, config fields, providers, protocol commands, sessions, extensions, harnesses, Environments, the Studio wire, Studio SDK resources. A consumer concept with no Ion term is described as a capability gap: "a consumer needs to…", "an extension wants to…".
- The operator reviews the draft before the issue is created. The operator is the final confidentiality gate.
- Every GitHub operation goes through `gh`, which is already authenticated.
- The command ends when the issue is created and the report is printed.

## Arguments

`$ARGUMENTS` is optional. It adds context, focus, or a classification hint.

- `/create-issue` derives everything from the conversation.
- `/create-issue bug: error events are not emitted when tool execution fails` gives a classification and a focus.
- `/create-issue we need a hook that fires before compaction` gives a feature focus.

A classification keyword (`bug`, `feature`, `enhancement`) in `$ARGUMENTS` decides Step 2.

## Step 1: Extract the need

From the conversation, extract:

- **What is missing or broken.** The specific behavior, hook, event, config field, protocol command, SDK method, wire action, or tool capability.
- **Why it matters.** What a consumer or extension cannot do today. Name the class of consumer that benefits.
- **What the capability looks like.** The contract on Ion's public surface: the hook fires at X, the event carries Y, the config field controls Z.
- **What was tried.** The Ion primitives that were reached for and why they fell short.

The extraction captures Ion's gap. The consumer's use case, workflow, and architecture stay out of it.

If the conversation does not identify a specific gap, stop: "I cannot identify a specific Ion issue from this conversation. Describe the gap you want to file and I will draft the issue."

## Step 2: Classify

| Class | Means | Examples |
|---|---|---|
| **Bug** | Ion does something wrong | An event carries the wrong fields. A hook does not fire when it should. A config field is parsed and not applied. Behavior contradicts the documented contract. |
| **Enhancement** | Ion lacks a capability | A hook, event variant, config field, protocol command, SDK method, or Studio extension point that does not exist. |

When the class is unclear, use **enhancement**.

## Step 3: Identify the subsystem

| Subsystem | Scope |
|---|---|
| `hooks` | Hook definitions, firing points, payloads (`engine/internal/extension/sdk_hooks_*.go`) |
| `events` | `NormalizedEvent` variants, `StatusFields`, engine events (`engine/internal/types/`) |
| `protocol` | Engine wire commands and responses (`engine/internal/protocol/protocol.go`) |
| `sdk` | SDK types, context methods, handler signatures (`engine/internal/extension/sdk_types.go`, `sdk.go`; `sdk/go/`) |
| `config` | `EngineConfig`, runtime config (`engine/internal/types/config.go`, `engine/internal/config/`) |
| `tools` | Built-in tools (`engine/internal/tools/`) |
| `session` | Session lifecycle, prompt dispatch (`engine/internal/session/`) |
| `backend` | Backends, run loop, tool execution (`engine/internal/backend/`) |
| `providers` | LLM providers (`engine/internal/providers/`) |
| `permissions` | Permission evaluation, sandbox (`engine/internal/permissions/`, `engine/internal/sandbox/`) |
| `conversation` | Persistence, branching, compaction (`engine/internal/conversation/`) |
| `mcp` | MCP client and bridge (`engine/internal/mcp/`) |
| `transport` | Engine socket and relay transport (`engine/internal/transport/`) |
| `server` | Ion Studio Server: store, auth doors, orchestration, HTTP (`server/src/`) |
| `studio-wire` | The Studio wire: actions, channels, scopes (`packages/shared/src/studio-wire/`, `server/src/protocol/`) |
| `studio-sdk` | Studio extension points (`packages/studio-sdk/`) |

Use the subsystem in the title prefix and the body.

## Step 4: Build the issue

Write in impersonal third person, as an outside developer building on Ion who met the same limitation. Use "a consumer", "an extension", "a harness", "extension authors". Do not use "we", "our", "I", "us", or "my".

### Title

- Bug: `[subsystem] What is broken`, for example `[hooks] before_tool_execution hook does not fire for MCP tools`.
- Enhancement: `[subsystem] What should exist`, for example `[hooks] Add before_compaction hook with token count and strategy in payload`.

Someone scanning the issue list knows what it is about from the title alone.

### Body

Every section is required unless marked optional.

#### Enhancement template

```markdown
## Summary

<1-2 sentences: the capability Ion should have>

## Motivation

<Why it is needed, from the view of any developer building on Ion.>

<Patterns that work:>
<- "Extensions that need to observe X currently have no way to…">
<- "A harness that manages Y has no primitive for…">
<- "Consumers who want to customize Z must approximate it with…">

<Frame the need around the capability, so it implies no organization, product, industry, or workflow.>

## Proposed behavior

<- When does it fire, and what triggers it?>
<- What data does it carry?>
<- What can a consumer do with it?>
<- How does it interact with existing hooks, events, and config?>

<For a hook, the payload shape:>
```go
// Example payload shape (proposed)
type BeforeCompactionPayload struct {
    SessionID     string `json:"sessionId"`
    TokenCount    int    `json:"tokenCount"`
    Strategy      string `json:"strategy"`
}
```

<For an event, the wire format:>
```json
{"type": "example_event", "data": {"field": "value"}}
```

<For a config field, where it fits:>
```json
{"newField": "defaultValue"}
```

## Use case examples

<2-3 examples, each framed as "A consumer could…", "An extension would…", "A harness might…", with SDK code or config where it helps.>

<The examples cover different applications of the capability, so each one justifies it on its own and none points at the use case that motivated the issue.>

## Acceptance criteria

- [ ] <Specific, testable criterion>
- [ ] <Specific, testable criterion>
- [ ] <Contract criterion, e.g. "New field has a zero-value default and is additive">
- [ ] <Cross-language criterion when types change, e.g. "TypeScript and Swift mirrors updated">

## Affected subsystems

<Comma-separated, from the subsystem table>

## Alternatives considered (optional)

<Workarounds or approaches that were rejected, described generically, and why they fell short.>
```

#### Bug template

```markdown
## Summary

<1-2 sentences: what is broken and what the correct behavior is>

## Current behavior

<What Ion does now: which event, hook, config field, or command misbehaves, and how.>

## Expected behavior

<What Ion should do, with the contract or documentation it follows from.>

## Steps to reproduce

1. <In Ion vocabulary: "Start a session with config X">
2. <"Send a prompt that triggers tool Y">
3. <"Observe event Z">

<Actual versus expected NDJSON, or actual versus expected hook payload, when the bug shows there.>

## Context (optional)

<One or two sentences saying this was found while building on Ion. Omit the section when there is nothing to say without consumer context.>

## Acceptance criteria

- [ ] <The behavior that is fixed>
- [ ] <A regression test that pins the fix>
- [ ] <Contract compliance, if applicable>

## Affected subsystems

<Comma-separated, from the subsystem table>
```

## Step 5: Confidentiality scrub

Search the whole title and body for each row. Replace what you find.

| Check | Look for | Replace with |
|---|---|---|
| Project names | Any project, product, or repo name other than `ion`, `dsswift/ion` | "a consumer project" |
| Company names | Any organization other than `dsswift` | "an organization", "a team" |
| Person names | Any person's name | Remove |
| Internal paths | File paths outside the Ion repo | "a consumer's codebase", or remove |
| Domain terms | Industry or product terminology that reveals what the consumer does | "a workflow", "a data pipeline", "a user-facing feature" |
| Organizational vocabulary | Jargon with no common meaning outside one organization | "a scheduled operation", "a queued task", "a processing step" |
| Workflow patterns | A multi-step process specific enough to imply one industry or product | Capability terms: "before the operation completes", "after a hook fires" |
| Insider voice | "we need", "our extension", "for us" | "a consumer", "an extension author", "this was observed" |
| Proprietary APIs | Non-public APIs, databases, internal services | "an external service", "a backend API" |
| Internal URLs | URLs to internal tools, dashboards, or repos | Remove |
| Logs and output | Console output or stack traces with consumer data | Redact the consumer parts; keep the Ion frames |
| Conversation quotes | Quotes that carry consumer context | Rephrase in Ion terms |

Then read the full draft against two questions:

1. Could a stranger tell what project filed this, what it does, or who works on it? The answer must be no.
2. Could a developer who never met the filer have found this gap and written this issue? The answer must be yes.

Scrub again until both hold.

## Step 6: Present the draft

```
📋 Ion Issue Draft

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
  - Organizational vocabulary: ✅ none found
  - Workflow specificity: ✅ none found
  - Insider voice (we/our/I): ✅ none found
  - Proprietary APIs: ✅ none found
  - Internal URLs: ✅ none found
  - Independent-filer test: ✅ reads as externally filed
```

Call `AskUserQuestion` with "Ready to create this issue on dsswift/ion?" and the options `Create it` and `Make changes`.

On `Make changes`, or when the operator describes edits: apply them, run Step 5 again, and present the updated draft with the same question.

## Step 7: Create the issue

After the operator selects `Create it`:

```bash
gh issue create --repo dsswift/ion --title "<title>" --label "<bug|enhancement>" --body "<body>"
```

If `gh` fails, report the error and stop.

## Step 8: Update the active plan

When this conversation has an active plan, partition it so the work that resolves the issue is done first and committed on its own. The issue's closing commits then contain only the work that resolves it.

### Find the plan

The plan is the one pinned in this conversation's context, in one of these forms:

- `**Your plan file for this session: <absolute-path>**`
- `[Attached plan: <path>]`
- `Implement the following plan:` followed by the plan

With no plan pinned, skip this step.

Read the plan. If its content does not overlap the gap that was filed, skip this step and report: "⚠️ Active plan found but appears unrelated — skipped plan update."

### Partition the work

Classify every item in the plan:

- **Issue work** resolves the filed issue: Ion code changes, tests, contract manifest regeneration, cross-language type sync, Ion documentation.
- **Remaining work** is everything else: consumer code, consumer tests, consumer config, harness changes outside the issue.

### Write the section

Add `## Issue Association` immediately after the plan's first heading. Replace the section if it already exists. Leave the rest of the plan as it is.

```markdown
## Issue Association

**GitHub Issue:** dsswift/ion#<number> — <title>
**Classification:** <Bug | Enhancement>

### Execution order

The work that resolves this issue is implemented and committed before the remaining plan items.

**Phase 1 — Issue resolution (commits reference #<number>):**
<the plan items that are issue work, with file paths and step references>

**Phase 2 — Remaining plan work (commits do not reference #<number>):**
<the remaining plan items, or "None — the entire plan is issue work">

### Commit rules for Phase 1

- **Subject:** ends with ` (#<number>)`, e.g. `feat(engine): add before_compaction hook (#<number>)`.
- **Body:** the final Phase 1 commit carries `Closes #<number>` (or `Fixes #<number>` for a bug) on its own line. Earlier Phase 1 commits carry the subject suffix only, so the issue closes when the work is complete.

Phase 2 commits carry no issue reference.
```

List actual file paths and plan steps in each phase, and use the real issue number.

When the plan contains no issue work, write the section with the issue reference and the line "Filed for future work. This plan proceeds without issue association."

## Step 9: Report

```
✅ Issue #<number> created: <URL>
   <title>
   Classification: <Bug | Enhancement>
   Subsystems: <list>
```

Then one of:

```
📋 Plan updated: <plan file path>
   Phase 1 (issue #<number>): <N> items, committed first
   Phase 2 (no issue ref): <N> items
```

```
📋 Plan updated: <plan file path>
   All plan items are issue #<number> work
```

```
📋 Plan updated: <plan file path>
   Issue #<number> filed for future work
```

```
ℹ️ No active plan updated (no plan found / plan appears unrelated)
```
