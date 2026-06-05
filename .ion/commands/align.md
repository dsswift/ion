---
description: Context-aware alignment. In plan mode: injects Ion quality standards into the current plan before implementation. Outside plan mode: reviews all branch changes against Ion quality gates and principles. Supports PR mode (in PR #N), branch mode (in branch <name>), and optional focus narrowing. Analyze-only — never edits source files.
allowed-tools: Bash(ls *), Bash(stat *), Bash(git *), Bash(gh pr view *), Bash(gh pr diff *), Bash(gh pr list *), Bash(gh pr checks *), Read, Grep, Glob
---

You are running the `/align` command. This command operates in two modes depending on context. Detect the active mode first, then follow the instructions for that mode.

**Hard rules. These apply in both modes.**

- You will not edit, create, or delete any source file.
- You will not stage, commit, amend, rebase, push, or open a PR.
- You will not run `gh pr create`, `gh pr merge`, `gh pr review`, `gh pr comment`, `git commit`, `git push`, or any mutating command.
- Your output is a single markdown report in this chat response. That is the entire deliverable.
- After the report, stop. The user reads the findings and decides what to do next.

---

## Mode Detection

**Plan mode (pre-alignment):** A plan file exists and plan mode is active — the user ran `/spec` and is still in the planning phase before implementation started.

Check: `ls -1t ~/.ion/plans/*.md 2>/dev/null | head -1`

If a recent plan file exists AND the context indicates plan mode is active (the user has been in a planning conversation, no implementation commits have been made since the plan was created), run **Mode A: Plan Alignment**.

**Post-changes mode (pre-PR gate):** No plan mode active, or implementation has already happened. The branch has commits that haven't been through alignment yet.

Parse `$ARGUMENTS` for target and focus (see the argument grammar in Mode B). If `$ARGUMENTS` contains `in PR` or `in branch`, that forces post-changes mode regardless of plan state.

Check: `git log main..HEAD --oneline`

If the branch has commits ahead of `main` (or has uncommitted changes) and plan mode is not active, run **Mode B: Post-Changes Alignment**.

If neither condition applies (branch is even with `main`, no plan, no uncommitted work), report: "Nothing to align — no plan in progress and branch is even with `main`." and stop.

When context is ambiguous, ask the user which mode to run.

---

## Grounding docs (both modes — always read these)

Read every one of these before evaluating anything. Do not operate from memory. Read them every invocation.

- `docs/engine-grounding.md` — non-negotiable engine framing.
- `docs/architecture/adr/001-engine-vs-harness.md` — engine-vs-harness boundary.
- `docs/architecture/agent-state.md` — snapshot semantics; the exemplar of how event contracts are reasoned about.
- `docs/architecture/file-organization.md` — cohesion of change, size caps, file-organization rules.
- `AGENTS.md` (repo root) — logging policy, commit rules, contract stability, layered architecture, **and § "Engine consumers" — who the engine ships for, and the forbidden review question *"does desktop use this?"***. This section is load-bearing for every engine finding; an audit that re-derives the consumer list from its own prose without anchoring to § "Engine consumers" is malformed.

Then read the per-component `AGENTS.md` for every component in scope:
- `engine/AGENTS.md` — if engine is touched.
- `desktop/AGENTS.md` — if desktop is touched.
- `ios/AGENTS.md` — if iOS is touched.
- `relay/AGENTS.md` — if relay is touched.

If a subsystem with its own doc page is in scope:
- `docs/architecture/hybrid-backend.md` — if provider routing or backend selection is involved.
- `docs/hooks/reference.md` — if hooks or the extension SDK are involved.
- `docs/protocol/normalized-events.md` — if events or wire protocol are involved.

---

## Plan resolution rules — no "document-instead-of-fix" moves

This rule applies in both modes. When evaluating whether a plan entry (Mode A) or a fix recommendation (Mode B) resolves a finding, every resolution must *change code*, *change a contract*, *delete code*, *add a test that pins behavior*, or *explicitly decide to do nothing with a stated rationale*. The following moves are **forbidden** because they look like fixes but aren't:

- **Adding a `TODO` / `FIXME` / `HACK` / `XXX` comment** describing the defect. The repository policy already forbids these markers; planning ones in is just slow-motion forbidding.
- **Adding a "narrative" / "boundary" / "intentional scope" comment** that documents a known fragility instead of removing it. A comment that says "this parser is intentionally minimal; replace with X when Y" is an aspirational comment by another name.
- **"Open a follow-up issue / file a tracking ticket"** as the resolution. Issues filed during a fix-plan generation are documenting the problem to the issue tracker rather than to a code comment, but it's the same anti-pattern: deferring the work without doing it. If the fix is genuinely out of scope, name the scope boundary explicitly and justify it.
- **"Add a `console.warn` / `log.Warn` when the bad case happens"** as the fix. Logging the symptom is not preventing it.
- **"Mark this for the next decomposition phase" / "address in Phase N"** without a corresponding code change in this branch. Phase markers without phase work are aspirational.
- **"Flag this in the PR description so reviewers know"** as the resolution. Reviewer-aware notes don't close defects.
- **Plain narrative comments establishing the intentional scope of a known-fragile implementation** — same anti-pattern as the TODO marker, with the marker stripped. The defect is still documented, not fixed.

Each resolution must be one of:

1. **Code change**: source files modified, with the specific change described.
2. **Contract change**: wire protocol, type definition, or hook signature modified (with documented rationale per the contract-stability rules).
3. **Code deletion**: dead surface removed.
4. **Test addition**: a new test that *pins* the intended behavior so future regressions fail loudly. Must reference the specific assertion, not just "add a test".
5. **Explicit do-nothing**: state plainly that the right answer is no change, and explain why (e.g. "this would be a breaking change to consumers without an ADR; we accept the documented limitation"). Decide-not-to-fix is a valid resolution; document-and-leave-it is not.

If a plan entry or recommendation uses "add a TODO", "document the limitation with…", "open a follow-up issue for…", "add a narrative comment explaining…", or "track in Phase N" — **flag it**. These are not fixes.

The plan and any fix plan generated from this review are themselves subject to the root `AGENTS.md` "Aspirational comments" and "Solution quality — no cheap substitutes" rules. A plan that resolves a finding by documenting it is an aspirational artifact; the rule applies to plans, not just to code.

---

---

# Mode A: Plan Alignment (pre-implementation)

You are reviewing the current plan before any code is written. The goal is to catch misalignment with Ion's architectural principles while the plan is still cheap to change. You produce findings and propose amendments — you do not edit the plan file.

**Additional hard rules for Mode A.**

- You will not edit the plan file. Amendments are *proposed* inline in this response, never applied.
- You will not start implementing the plan.

**Sister command:** Mode B reviews the same dimensions against actual code (post-implementation). If you add a grounding document, dimension, or plan-resolution rule to Mode A, add it to Mode B too.

## A-Step 1: Resolve and read the plan

> **Plan selection is anchored to the conversation, not to filesystem mtime.**
>
> Parallel planning is the common case — the user often has several plan-mode conversations open at once (one per worktree, one per topic, one per AI assistant window). Every plan-mode conversation has the *exact* plan it was opened against already pinned in the agent's context window: the harness attaches it as `[Attached plan: <absolute-path>]` (or its equivalent `Implement the following plan:` block) at conversation start, and that attachment is the authoritative source for which plan this conversation is auditing.
>
> **Resolution order — use the first one that applies:**

1. **`$ARGUMENTS` provided.** Resolve as the user passed it:
   - Absolute path: use it directly.
   - Bare filename or hash (with or without `.md`): resolve from `~/.ion/plans/`.
   - Unique hash prefix: glob `~/.ion/plans/{prefix}*.md`. If zero or more than one match, stop and report ambiguity — do not fall back to context-derived or mtime-derived defaults silently.

2. **No `$ARGUMENTS`, but the conversation has an attached plan in context.** This is the standard plan-mode default. The agent must look back through the conversation context and find the most recent message that introduced the plan — typically a user message containing `[Attached plan: <path>]` or `Implement the following plan:` followed by the plan markdown. The path from that attachment **is** the canonical plan for this session. Use it without further lookup.

3. **No `$ARGUMENTS` and no plan attachment in the conversation context.** This is the fallback path, and even here the agent must verify before proceeding:
   - List the three most-recently-modified plan files: `ls -1t ~/.ion/plans/*.md 2>/dev/null | head -3`.
   - Read the first heading (`#`) of each candidate.
   - Compare against any topic signals the conversation provides (recent prompts, the working branch name, recent commit messages, recent tool calls).
   - **If exactly one candidate's title matches the conversation topic**, use it and clearly mark `Selected by: mtime-fallback + topic-match` in the orientation block.
   - **If zero candidates match, or more than one is plausible**, stop and report the ambiguity to the user. List the candidates and their titles. Ask which plan to audit. **Do not silently pick the newest.**

> **The forbidden move:** Defaulting to the most recently modified plan in `~/.ion/plans/` without verifying it matches the conversation. With parallel planning sessions, the newest plan globally is *very often not* this conversation's plan — and silently auditing the wrong plan is worse than asking the user.

If no plan exists at any of the resolution paths above, stop: "No plan found in `~/.ion/plans/` and no plan attachment in this conversation. Create a plan first, or pass a plan path as an argument."

Read the resolved plan in full. Run `git branch --show-current` and `git status --porcelain`.

Print a one-paragraph orientation: plan file path, plan title (first `#` heading), how the plan was selected (one of: `argument`, `conversation attachment`, `mtime-fallback + topic-match`), branch it would land on, one-line summary of what the plan proposes. The user must see exactly which plan is being audited before reading any findings.

If the plan is empty, a stub, or not a plan (a session note, a transcript), say so and stop.

## A-Step 2: Ground in the principles

Read all grounding docs listed in the Grounding section above, for every component the plan proposes to touch.

## A-Step 3: Audit the plan across these dimensions

Tag every finding: **BLOCKER**, **CONCERN**, or **NIT**.
Cite the exact plan section (heading or quoted line) for every finding. A finding without a plan citation is not a finding.

> **Run the engine-consumer test before flagging any engine change.**
>
> The engine is the product. The desktop, iOS, and relay applications in this repo are reference implementations. External consumers are the canonical audience: TypeScript SDK extensions, Go SDK harnesses, third-party clients, automation pipelines, IDE plugins, server agents.
>
> The question *"does desktop use this?"* is **forbidden** as a justification for flagging a proposed engine change. Use *"would any plausible external consumer want this?"* instead. The absence of an in-repo caller for new engine surface is the **expected default**, not a smell. See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers". **This rule is load-bearing; a finding that violates it must be removed before the report is emitted.**

### Layer choice

Walk the plan and check every proposed change for correct layer assignment (engine, harness, or client):

- Engine changes must be justified as core engine mechanics. The default verdict on a proposed engine change is "this should live in the harness or client" unless the plan proves otherwise.
- UI policy (retention rules, what to render, when to clear) belongs in the consumer.
- User preferences and cross-session memory belong in the harness or client.
- Hook payloads shaped to a specific renderer's needs ("for the desktop sidebar") must be reshaped to be UI-agnostic.
- Plan steps that propose conditional branches inside engine packages keyed on consumer identity ("if desktop, do X") are BLOCKER.

For every proposed engine touch: write one sentence answering *Why does this need to be in the engine and not the harness or client?*

### Contract impact

If the plan proposes changes to wire protocol, NormalizedEvent variants, SDK types, or hook payloads:
- Is it additive (allowed) or does it remove/rename/retype something (forbidden)?
- Does the plan name the regen step (`cd engine && go test ./internal/types/ -run TestContractManifest -update`) and the cross-language mirror updates (TS in `desktop/src/shared/`, Swift in `ios/IonRemote/Models/`)?

Missing regen step for a contract change = BLOCKER.

### Cross-platform completeness

A plan that names one half of a cross-platform feature without its counterpart is a half-baked plan:
- Shared Go type changes → does the plan name `desktop/src/shared/types-engine.ts`, `contract-sync.test.ts`, and the Swift model?
- Desktop user-facing change → does the plan acknowledge the iOS counterpart?
- New SDK hook or type → does the plan name the SDK and hook reference docs?

List the exact companion file paths the plan should add.

> **What this section is not.** The parity rule does not require every engine change to have a desktop or iOS counterpart. New engine surface with no in-repo consumer is the steady state; it is **not** a parity gap.

### Abstraction posture

Flag:
- "Quick fix" or "workaround" language where a proper extension point exists.
- Conditional branches inside engine packages keyed on consumer identity.
- TODO/HACK/FIXME/XXX markers as deliverables.
- Code added to allowlisted god files when a sibling file would be cohesive.
- Comment-stripping to satisfy file-size caps (comments are load-bearing; splitting is correct).
- New state bolted into existing types rather than introducing a new typed concept.

### Logging plan

Does the plan pre-commit to instrumentation?
- Which operations will log success and failure?
- Are both sides of new conditionals covered?
- Engine Go code: `utils.Log`/`utils.Debug`/`utils.Error` — never `log.Printf` or `fmt.Printf`.

Silent plan for non-trivial behavior = CONCERN.

### Test plan

Does the plan name the specific test files and what they validate?
- Agent lifecycle changes → `manager_agent_lifecycle_test.go`
- New hook wiring → a test that the hook fires
- Contract changes → `TestContractManifest -update`
- Desktop logic → corresponding `*.test.ts`

Contract change with no test plan = BLOCKER. Behavior change with no test plan = CONCERN.

### File organization

- Are changes cohesive in one folder per feature?
- Does any planned file approach the hard cap (600 TS / 800 Go / 1500 Go test / 600 Swift)?
- Is code being added to an allowlisted god file when a sibling file would be correct?

### Necessity and correctness

For each logical change in the plan, answer both:
1. **Who is the consumer?** Name the canonical consumer audience. For engine changes, the default answer is "external SDK users and third-party harnesses." If the plan's answer is "the in-repo desktop/iOS app" for an *engine* change, that's the smell — see § "Engine consumers" in root `AGENTS.md`.
2. **Does the change serve that consumer well?** Right layer, right primitive, right place?

Where the honest answer is "not really," recommend the smaller, cleaner alternative and propose the specific plan section that should change.

### Unstated assumptions

List assumptions the plan makes but doesn't state:
- That a particular client is the only consumer
- That an event is incremental when it is a snapshot
- That a hook fires somewhere it doesn't currently fire
- That code is already instrumented when it isn't

## A-Step 4: Emit the alignment report

The report is structured for **terminal-first reading**: the user's cursor lands at the bottom of the streamed output, so the most actionable content goes there. Scrolling up walks the user backward through the narrative. The conventional Header/Verdict-at-top order is *inverted* here on purpose.

Render the sections in this exact order, top-to-bottom:

```
1. Header                           (plan path, scope orientation)
2. What was not audited             (scope boundary; boring; goes early)
3. Findings                         (grouped by dimension, each with severity + action class)
4. Proposed plan amendments         (numbered list)
5. ⚠️ Destructive Plan Steps        (only if any exist)
6. Critical Plan Actions Summary    (scannable table, all amendments)
7. Verdict                          (final line — last thing on screen)
```

When the report streams complete, the user sees the **Verdict** first (without scrolling), then the **Critical Plan Actions Summary** one screen up, then any **Destructive Plan Steps** loudly called out above that.

### 1. Header

```
Plan: <absolute path to plan file>
Selected by: <one of: argument: "<arg as passed>" | conversation attachment | mtime-fallback + topic-match>
Title: <first heading of the plan>
Branch: <git branch --show-current>
Uncommitted work for this plan: yes/no
Scopes the plan proposes to touch: <engine/desktop/relay/ios/docs/repo>
```

### 2. What was not audited

Be explicit about the boundaries of this alignment pass. Name anything you skipped or could not evaluate from the plan alone.

### 3. Findings

Group findings by dimension in the order they appear in A-Step 3. Under each dimension, list findings with severity prefixes AND an action class icon:

```
🛑 [BLOCKER] 🟢 CONSTRUCTIVE — Add <one-sentence claim>
  Plan section: <heading or quoted line>
  Why: <concise reasoning, citing the principle being violated>

🔶 [CONCERN] ⚠️ DESTRUCTIVE — Remove <one-sentence claim>
  Plan section: ...
  Why: ...
  (Any DESTRUCTIVE amendment must also appear in the dedicated
   Destructive Plan Steps section below, with the four-check
   gate explicitly addressed.)

💬 [NIT] 🟢 CONSTRUCTIVE — Replace ...
```

Severity is BLOCKER / CONCERN / NIT (urgency). Action class is CONSTRUCTIVE / DESTRUCTIVE (effect on the plan). The two are orthogonal.

If a dimension has no findings, write a single line: `No findings.` Do not pad. Do not invent.

### 4. Proposed plan amendments

A numbered list of concrete amendments to the plan, in priority order. Each amendment is one of:

- **Add** — a section, step, file path, or verification step the plan currently omits.
- **Move** — a step from one layer to another.
- **Remove** — a step that should not happen at all.
- **Replace** — wording or approach in a specific plan section.

For every amendment, quote the plan section it modifies and write the proposed replacement text or addition. Be concrete enough for copy/paste application — but do **not** edit the plan file yourself.

### 5. ⚠️ Destructive Plan Steps (only render if any exist)

If the audit produces zero destructive amendments, **omit this section entirely**.

If one or more destructive amendments exist, render each in its own subsection:

```
⚠️ Destructive Plan Step #N — <one-line summary>

What is lost:
  <Name the functionality, consistency, or capability the plan proposes
   to remove or that the amendment would remove from the plan.>

Higher-bar justification:
  <Why this destructive action is necessary instead of a constructive
   alternative. Cite the consumer impact, not a rule book.>

Alternatives considered:
  - <Constructive alternative #1, with reason rejected.>
  - <Constructive alternative #2, with reason rejected.>
  (At minimum one constructive alternative must be named and explicitly
   rejected with a reason. "No alternative considered" is itself a
   gate failure.)

Four-check gate:
  1. Concrete failure mode: <name the consumer, the failure, the repro>
  2. Constructive alternative considered: <name it; explain why rejected>
  3. Preserves prior investment: <yes/no, with brief justification>
  4. Surfaced in Critical Plan Actions Summary: <yes>
```

The **destructive-amendment gate**: before recommending any destructive amendment, clear all four checks. If any check fails, recommend a constructive alternative instead.

**Plan-equivalent-to-production principle.** A plan that has reached `/align` represents committed thinking. Recommending that the plan remove a step is asking the author to undo their thinking; the bar is the same as recommending a code revert at post-changes review. It had better be failing thinking, and there had better be no other way to reach the right outcome.

### 6. Critical Plan Actions Summary

A single table directly above the Verdict line. Render every proposed amendment as one row:

```
| # | Severity | Action class | Amendment | Plan section | One-line rationale |
|---|---|---|---|---|---|
| 1 | 🛑 BLOCKER | 🟢 CONSTRUCTIVE — Add | <amendment> | <section> | <rationale> |
| 2 | 🔶 CONCERN | ⚠️ **DESTRUCTIVE — Remove** | <amendment> | <section> | <rationale> |
| 3 | 💬 NIT | 🟢 CONSTRUCTIVE — Replace | <amendment> | <section> | <rationale> |
```

Action class labels:
- 🟢 **CONSTRUCTIVE — Add** (new plan step, missing file path, missing verification)
- 🟢 **CONSTRUCTIVE — Move** (relocate a plan step to a different layer)
- 🟢 **CONSTRUCTIVE — Replace** (rewrite wording without changing intent)
- 🟢 **CONSTRUCTIVE — Strengthen** (tighten an existing step's scope or success criterion)
- ⚠️ **DESTRUCTIVE — Remove** (delete a plan step entirely)
- ⚠️ **DESTRUCTIVE — Revert planned change** (the plan calls for a change; this amendment says don't make it)
- ⚠️ **DESTRUCTIVE — Narrow planned scope** (the plan calls for a broad change; this amendment narrows it past the consumer's intent)

Destructive rows are bolded in the table.

### 7. Verdict

Exactly one of:

- ✅ **ALIGNED** — {0 blockers, 0 concerns}. The plan is ready to execute as written.
- 💬 **ALIGNED WITH NITS** — {0 blockers, 0 concerns, N nits}. Execute as-is; consider folding the nits in.
- 🔶 **NEEDS AMENDMENT** — {N concerns, 0 blockers}. Amend the plan before starting implementation, or explicitly justify each concern.
- 🛑 **MISALIGNED** — {N blockers}. Do not start implementation. The plan needs material change first.

Include the actual counts. The verdict is conservative: any unresolved BLOCKER → `MISALIGNED`. Any CONCERN with no BLOCKERs → at most `NEEDS AMENDMENT`.

The verdict is the final line on screen. Place it last; nothing else follows.

## A-Step 5: Stop

Print:

`✅ Alignment check complete — {verdict} with {N blockers, N concerns, N nits}.`

End with:

> Alignment check complete. I will not edit the plan file, make code changes, or start implementation from this command. Read the findings and proposed amendments above. When you are ready, tell me which amendments to apply and we will update the plan together before any code is written.

Stop. Do not offer to implement. Do not edit the plan.

---

---

# Mode B: Post-Changes Alignment (pre-PR gate)

You are running the final alignment gate before a pull request is opened. Your job is to analyze the branch changes against Ion's quality standards, report findings, and recommend fixes. You do not make any changes.

**Additional hard rules for Mode B.**

- After the report, stop. The user reads the findings and we discuss them before any PR is created.
- Do not offer to start fixing. The user drives the next step.

**Sister command:** Mode A reviews the same dimensions against a plan (pre-implementation). If you add a grounding document, dimension, or plan-resolution rule to Mode B, add it to Mode A too.

## B-Step 1: Parse arguments and determine scope

### Argument grammar

```
$ARGUMENTS ::= [<target>] [<focus>]

<target> ::=
  | "in PR" <pr-list>         → PR mode   (Step 1B)
  | "in branch" <branch-name> → Branch mode (Step 1C)
  | (empty)                   → Local mode  (Step 1A)

<pr-list> ::= <pr-ref> ("," <pr-ref>)*
<pr-ref>  ::= ("PR")? "#"? <positive-integer>    e.g. #161, 162, PR #163

<focus> ::= free text not matching any target pattern
```

### Parsing algorithm

Apply these rules in order against the trimmed `$ARGUMENTS` string:

0. **Empty or whitespace-only** → Local mode (Step 1A), no focus. Done.

1. **Backward-compat auto-detect:** Check if the *entire* string consists of nothing but PR-number-shaped tokens (positive integers with optional `#` or `PR #` prefixes, separated by commas and/or whitespace). If yes, treat as implicit PR mode — run Step 1B with no focus. Done.

2. **Explicit `in PR` prefix** (case-insensitive): Extract PR numbers after `in PR`. Everything after the last PR-number token is the **focus instruction**. Run Step 1B. Done.

3. **Explicit `in branch` prefix** (case-insensitive): The next whitespace-delimited token is the **branch name**. Everything after the branch name is the **focus instruction**. Run Step 1C. Done.

4. **Fallback — focus only:** The entire string is a focus instruction. Run Local mode (Step 1A) with focus applied. Done.

### What "focus" does

When a focus instruction is present, Step 3 (review dimensions) is narrowed: only the matching dimensions are evaluated in full depth; remaining dimensions get a brief pass (one-paragraph summary). The report header includes a `Focus: "<quoted instruction>"` line. Step 2 (grounding docs) is **never** skipped regardless of focus.

### Step 1A: Local mode

Run:

```bash
git branch --show-current
```

If the result is `main`, stop: "Review is meaningless on `main`. Switch to a feature branch and rerun, or pass PR numbers to review specific pull requests." Do nothing else.

```bash
git status --porcelain
git diff
git diff --staged
git log main..HEAD --oneline
git log main..HEAD --format=fuller --no-merges
git diff main...HEAD --stat
git diff main...HEAD
```

If `git log main..HEAD --oneline` is empty AND there are no uncommitted changes, stop: "Nothing to review — branch is even with `main` and the working tree is clean."

Print a one-paragraph orientation: branch name, number of commits ahead of `main`, number of files changed, scopes touched (engine/desktop/relay/ios/docs/repo), focus instruction (if any).

### Step 1B: PR mode

For each parsed PR number:

1. `gh pr view <N> --json number,title,author,state,baseRefName,headRefName,headRefOid,baseRefOid,additions,deletions,changedFiles,body,labels,isDraft,mergeable,mergeStateStatus,url` — if the PR does not exist or `gh` errors, capture the failure and continue to the next PR; surface it in the "What was not reviewed" section.
2. `gh pr diff <N>` — the full diff. This is the primary review surface for that PR.
3. `gh pr checks <N>` — CI state. Failed required checks are a CONCERN (or BLOCKER if they include contract-sync or file-size gates).

Print a one-paragraph orientation: how many PRs are being reviewed, their numbers and titles, total files changed, scopes touched, focus instruction (if any).

In PR mode, do not run `git status`, `git diff`, or `git log main..HEAD` against the local checkout — the PR's own diff is the source of truth.

If `$ARGUMENTS` contained PR numbers but every one failed to resolve via `gh`, stop and report the failures. Do not fall back to local mode.

### Step 1C: Branch mode

1. Verify the branch exists: `git rev-parse --verify <name>`. If that fails, try `git rev-parse --verify origin/<name>`. If both fail, stop: "Branch `<name>` not found locally or on origin."
2. Run:
   ```bash
   git log main..<branch> --oneline
   git log main..<branch> --format=fuller --no-merges
   git diff main...<branch> --stat
   git diff main...<branch>
   ```

Do **not** run `git status`, `git diff`, or `git diff --staged` — those are working-tree concepts irrelevant to a named branch.

If `git log main..<branch> --oneline` is empty, stop: "Nothing to review — branch `<name>` is even with `main`."

Print a one-paragraph orientation: branch name, number of commits ahead of `main`, number of files changed, scopes touched, focus instruction (if any).

## B-Step 2: Ground in the principles

Read all grounding docs listed in the Grounding section above, for every component actually touched in the diff. In PR mode, "the change set" means the union of files touched across all PRs — read each relevant `AGENTS.md` once per invocation, not once per PR.

## B-Step 3: Review across these dimensions

Tag every finding: **BLOCKER**, **CONCERN**, or **NIT**.
Cite concrete file paths, line ranges, and commit SHAs in every finding. A finding without a citation is not a finding.

If a **focus instruction** was parsed, prioritize the matching dimensions at full depth; give remaining dimensions a brief pass (one-paragraph summary rather than line-by-line). If no focus was specified, all dimensions run at full depth.

### Engine gravity

Did the diff touch `engine/`? The burden of proof is on the diff: justify every engine change as core engine mechanics.

> **Run the engine-consumer test before flagging.**
>
> The question *"does desktop use this?"* is **forbidden** as a justification for flagging an engine change. Use *"would any plausible external consumer want this?"* instead. Engine surface ships ahead of reference implementations by design. The absence of an in-repo caller for new engine surface is the **expected default**, not a smell. See root [`AGENTS.md`](../AGENTS.md) § "Engine consumers". **This rule is load-bearing; a recommendation that violates it must be removed before the report is emitted.**

Specifically flag:

- UI-flavored language in engine code, comments, or docs ("clear the panel", "show as cancelled", "highlight the row", "tab", "panel", "render").
- Renderer policy bleeding into engine events or hook payloads.
- Engine code that blocks for user input.
- Engine code that persists user preferences or reads them from disk at runtime.
- Hardcoded policy decisions (which agent loads, delegation routing, retention rules) inside engine packages.
- Engine changes that exist only to compensate for a consumer-side gap that could be fixed in the consumer.

For every engine commit: write one sentence answering *Why did this need to be in the engine?* If you cannot answer that from the diff, that is a BLOCKER.

### Contract stability

Inspect every diff hunk touching:
- `engine/internal/protocol/` — wire protocol
- `engine/internal/types/` — shared types
- `engine/internal/extension/sdk_*.go` — SDK types, hook signatures

Flag as BLOCKER:
- Removed or renamed fields, types, constants, hook names, event variants.
- Type changes on existing fields (`string` → `int`, `[]T` → `map`, etc.).
- Reordered positional arguments in an SDK callback signature.
- Non-additive payload changes on existing hooks.
- Changes to wire-protocol framing or envelope structure.
- Changes to **event semantics** even when wire shape is unchanged (snapshot ↔ incremental). Cross-reference `docs/architecture/agent-state.md`.

If `engine/internal/types/` changed: was `contracts.json` regenerated in the same commit? If not, BLOCKER: `cd engine && go test ./internal/types/ -run TestContractManifest -update`.

### Cross-platform sync

Flag every half-shipped feature:
- Shared Go type changed → desktop (`desktop/src/shared/types-engine.ts` or `types-events.ts` AND `contract-sync.test.ts`) and iOS (`ios/IonRemote/Models/**`) mirrors updated?
- Desktop user-facing setting changed → iOS counterpart considered (Remote settings tab, main-process write helper, broadcast path, sync snapshot)?
- New SDK hook or type → SDK docs (`docs/extensions/sdk-typescript.md`, `sdk-go.md`, `sdk-raw.md`) and hook reference (`docs/hooks/reference.md`) updated?
- New normalized event variant or field → protocol docs (`docs/protocol/normalized-events.md` and/or `docs/protocol/server-events.md`) updated?

Name the exact missing file paths.

> **What this section is not.** The parity rule does not require every engine change to have a desktop or iOS counterpart. New engine surface with no in-repo consumer is the steady state; it is **not** a parity gap.

### SDK pace

If engine hooks, hook payloads, tool definitions, or SDK types changed: are the TypeScript SDK / Go SDK / raw protocol docs current? Flag any divergence — including hooks that exist in `sdk_hooks_*.go` but are not documented, and SDK types that exist in `sdk_types.go` but have no mirror in the docs.

### Abstraction and laziness

Flag:
- In-file workarounds where a proper extension point exists.
- Consumer-specific conditionals inside engine packages.
- `TODO`, `HACK`, `FIXME`, or `XXX` comments added in this diff (quote each with file and line).
- Copy-pasted blocks that should be extracted into a helper.
- Code added to allowlisted god files (`engine/internal/session/manager.go`, `engine/internal/extension/host.go`).
- Comment-stripping or whitespace-collapsing edits done to satisfy file-size caps. Per root `AGENTS.md`: comments are load-bearing; splitting is the answer, not stripping.

### Logging discipline

Per the logging-policy section of root `AGENTS.md`:
- New operations must log success and failure with context.
- New `if/else` branches must log which branch ran and why. Both sides.
- Engine Go code: `utils.Log`/`utils.Debug`/`utils.Error` — never `log.Printf`, `fmt.Printf`, or `fmt.Println` for operational logging.
- Desktop main-process code: `log()` helper from `../logger`. Renderer hot paths are excepted.
- When the diff touches under-instrumented code, the "first, add comprehensive logging" rule applies.

### File size and organization

Read `docs/architecture/file-organization.md` and `.file-size-allowlist.yml`. Walk the diff:
- Note the new line count for each changed file. Flag files approaching the hard cap (600 TS / 800 Go / 1500 Go test / 600 Swift) as CONCERN; exceeding the hard cap as BLOCKER (unless allowlisted or carrying `@file-size-exception` on line 1).
- Flag new code added to allowlisted god files.
- Flag features whose changes are spread across many folders (violating cohesion-of-change).

### Tests

For every engine behavior change: corresponding `*_test.go` or integration test? Absent = BLOCKER.
- Agent lifecycle changes: `manager_agent_lifecycle_test.go` extended?
- New hook wiring: test that the hook fires?
- Contract changes: `TestContractManifest` rerun?
- Desktop logic changes: corresponding `*.test.ts` updated?

### Commit hygiene

Walk every commit on the branch:
- Conventional Commits with required scope: `type(scope): subject`
- Allowed types: `feat`, `fix`, `chore`, `docs`, `feat!`
- Allowed scopes: `engine`, `desktop`, `relay`, `ios`, `docs`, `repo`
- Subject ≤ 75 chars, lowercase, imperative, no trailing period
- Issue association (when working from an issue): subject must end with ` (#N)` AND body must include `Fixes #N` or `Closes #N` trailer. Both are required.

### Necessity and correctness

For each logical change in the diff:
1. **Who is the consumer?** Name the canonical consumer audience. For engine changes, the default answer is "external SDK users and third-party harnesses." The forbidden answers for engine changes are "no one yet" and "desktop will use it."
2. **Does the change serve that consumer well?** Correctly layered, correctly tested, correctly documented, additive where possible?

Where the answer to either is "not really," recommend the smaller, cleaner, correctly-layered alternative. Be willing to say "this should have been done in the harness" or "this did not need to be done at all" when that is the honest answer.

## B-Step 4: Emit the report

The report is structured for **terminal-first reading**: the user's cursor lands at the bottom of the streamed output, so the most actionable content goes there. The conventional Header/Verdict-at-top order is *inverted* here on purpose.

### Local mode and Branch mode — single report

Render sections in this exact order, top-to-bottom:

```
1. Header              (mode, branch, scope orientation)
2. What was not reviewed (scope boundary; boring; goes early)
3. Findings            (grouped by dimension, each with severity + action class)
4. Recommendations     (numbered list)
5. ⚠️ Destructive Recommendations  (only if any exist)
6. Critical Actions Summary        (scannable table, all actions)
7. Verdict             (final line — last thing on screen)
```

#### Header (Local mode)

```
Mode: local
Branch: <name>
Range: main..HEAD (<N> commits)
Files changed: <N>
Scopes touched: <comma-separated list>
Uncommitted changes: yes/no
Focus: <quoted instruction or "none">
```

#### Header (Branch mode)

```
Mode: branch
Branch: <name>
Range: main..<branch> (<N> commits)
Files changed: <N>
Scopes touched: <comma-separated list>
Focus: <quoted instruction or "none">
```

No `Uncommitted changes` field in branch mode.

#### 2. What was not reviewed

Be explicit about the boundaries of this gate. Name anything you skipped or could not evaluate: binary assets, vendored dependencies, generated files, large refactors where spot-checking was the limit, runtime behavior requiring execution, anything outside the model's read scope.

#### 3. Findings

Group findings by dimension. Under each dimension, list findings with severity prefixes AND action class icons:

```
🛑 [BLOCKER] 🟢 CONSTRUCTIVE — Add <one-sentence claim>
  Where: <file:line-range or commit SHA>
  Why: <concise reasoning, citing the principle being violated>

🔶 [CONCERN] ⚠️ DESTRUCTIVE — Revert <one-sentence claim>
  Where: ...
  Why: ...
  (Any DESTRUCTIVE finding must also appear in the dedicated
   Destructive Recommendations section below, with the four-check
   gate explicitly addressed.)

💬 [NIT] 🟢 CONSTRUCTIVE — Refactor ...
```

Severity is BLOCKER / CONCERN / NIT (urgency). Action class is CONSTRUCTIVE / DESTRUCTIVE (effect on shipped code). The two are orthogonal — a 🟢 BLOCKER ("add this missing test") is normal; a ⚠️ BLOCKER ("revert this change") is rare and must be loudly justified.

If a dimension has no findings, write a single line: `No findings.` Do not pad. Do not invent.

#### 4. Recommendations

A numbered list of concrete fixes in priority order. Each recommendation is an action with the exact command or file change — not a principle restatement. Good: "Regenerate the contract manifest: `cd engine && go test ./internal/types/ -run TestContractManifest -update`, then update `desktop/src/shared/types-engine.ts` to mirror the new `StatusFields.foo` field." Bad: "Maintain contract stability."

Recommendations should map back to specific findings — reference the dimension and the file path so the user can trace each recommendation to its root finding.

#### 5. ⚠️ Destructive Recommendations (only render if any exist)

If the review produces zero destructive recommendations, **omit this section entirely**.

If one or more destructive recommendations exist, render each in its own subsection:

```
⚠️ Destructive Recommendation #N — <one-line summary>

What is lost:
  <Name the functionality, consistency, error-surfacing channel, or
   capability that disappears if the recommendation is followed.>

Higher-bar justification:
  <Why this destructive action is necessary instead of a constructive
   alternative. Cite the consumer impact, not a rule book.>

Alternatives considered:
  - <Constructive alternative #1, with reason rejected.>
  - <Constructive alternative #2, with reason rejected.>
  (At minimum one constructive alternative must be named and explicitly
   rejected with a reason. "No alternative considered" is itself a
   gate failure.)

Four-check gate:
  1. Concrete failure mode: <name the consumer, the failure, the repro>
  2. Constructive alternative considered: <name it; explain why rejected>
  3. Preserves prior investment: <yes/no, with brief justification>
  4. Surfaced in Critical Actions Summary: <yes>
```

The **destructive-recommendation gate**: before recommending any destructive action (revert, remove, narrow), clear all four checks. If any check fails, recommend a constructive alternative instead.

**Production-equivalence principle.** Code arriving at `/align` post-changes has passed tests and is expected to ship. Recommending reverts at this gate is equivalent to destroying production work. The bar is the same: it had better be failing, and there had better be no other way to make it work.

#### 6. Critical Actions Summary

A single table directly above the Verdict line. Render every recommendation as one row:

```
| # | Severity | Action class | What | Files | One-line rationale |
|---|---|---|---|---|---|
| 1 | 🛑 BLOCKER | 🟢 CONSTRUCTIVE — Add | <action> | <files> | <rationale> |
| 2 | 🔶 CONCERN | ⚠️ **DESTRUCTIVE — Revert** | <action> | <files> | <rationale> |
| 3 | 💬 NIT | 🟢 CONSTRUCTIVE — Refactor | <action> | <files> | <rationale> |
```

Action class labels:
- 🟢 **CONSTRUCTIVE — Add** (new tests, new logging, new fields, new hooks)
- 🟢 **CONSTRUCTIVE — Refactor** (extracting, splitting, renaming locally, restructuring without behavior change)
- 🟢 **CONSTRUCTIVE — Fix** (correcting a defect; behavior change for the better)
- 🟢 **CONSTRUCTIVE — Document** (changing docs to reflect reality; not as a substitute for code work)
- ⚠️ **DESTRUCTIVE — Revert** (removing or backing out work already shipped on this branch)
- ⚠️ **DESTRUCTIVE — Remove feature** (deleting a method, hook, field, or capability that already works)
- ⚠️ **DESTRUCTIVE — Narrow contract** (tightening a previously permissive surface in a way that may break consumers)

Destructive rows are bolded.

**Optional split:** When the action set is large (> 8 actions), render a separate `🟢 Constructive Actions Summary` table immediately above the Destructive Recommendations section. For small reviews (≤5 total actions) skip the split.

#### 7. Verdict

Exactly one of:

- ✅ **READY** — {0 blockers, 0 concerns}. The PR is ready to open as-is.
- 💬 **READY WITH NITS** — {0 blockers, 0 concerns, N nits}. The PR can be opened; consider addressing the nits in the same PR.
- 🔶 **NEEDS WORK** — {N concerns, 0 blockers}. The PR should not be opened until the concerns are addressed or explicitly justified.
- 🛑 **BLOCKED** — {N blockers}. The PR must not be opened until every blocker is resolved.

Include the actual counts. The verdict is conservative: any unresolved BLOCKER → `BLOCKED`. Any CONCERN with no BLOCKERs → at most `NEEDS WORK`.

The verdict is the final line on screen. Place it last; nothing else follows.

### PR mode — batch report

Open with a batch orientation block:

```
Mode: pr
PRs reviewed: <N>
PR numbers: <comma-separated list>
Total files changed across batch: <N>
Scopes touched across batch: <comma-separated list>
Focus: <quoted instruction or "none">
```

Then produce one self-contained sub-report per PR, in the order the PRs were passed in. Each sub-report uses the same terminal-first inverted structure as local mode (Header → What was not reviewed → Findings → Recommendations → ⚠️ Destructive Recommendations (if any) → Critical Actions Summary → Verdict), except the Header reads:

```
PR: #<N> — <title>
Author: <author>
Base → Head: <baseRefName> ← <headRefName> (<additions> additions, <deletions> deletions, <changedFiles> files)
State: <state>, draft: <isDraft>, mergeable: <mergeable> (<mergeStateStatus>)
CI: <summary of `gh pr checks` — passing / failing / pending>
URL: <url>
```

After all per-PR sub-reports, emit a **Cross-PR section** if and only if the PRs interact (overlapping files, shared contract changes that could conflict, one depends on another, or they contradict each other). If none apply, omit the Cross-PR section.

Emit a **Batch verdict** line: e.g. `🛑 Batch verdict: BLOCKED (PR #138 has 2 blockers)` or `✅ Batch verdict: READY (all 3 PRs clean)`. The most severe per-PR verdict wins for the batch.

## B-Step 5: Stop

Print:

Local mode: `✅ Review complete — {verdict} with {N blockers, N concerns, N nits}.`
Branch mode: `✅ Branch review complete — {verdict} with {N blockers, N concerns, N nits}.`
PR mode: `✅ PR review complete — {batch verdict} across {N} PRs.`

End with the appropriate handoff paragraph:

Local mode:

> Review complete. I will not make edits, stage files, amend commits, or open a PR from this command. Read the findings above. When you are ready, we will discuss them together and put a fix plan in place before the pull request is created.

Branch mode:

> Review complete. I will not make edits, stage files, amend commits, or open a PR from this command. Read the findings above. When you are ready, we will discuss them together and decide whether the branch is ready for a pull request.

PR mode:

> Review complete. I will not edit, comment on, approve, request changes on, or merge any of these pull requests from this command. Read the findings above. When you are ready, we will discuss them together and decide which PRs are safe to merge, which need changes requested, and which need a follow-up plan.

After that line, the response ends. Do not offer to start fixing. Do not propose patches inline. Do not run any further commands. The user drives the next step.
