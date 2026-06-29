---
description: Detect behavioral regressions by challenging whether branch changes were necessary and tracing their cascading effects. Does not treat branch changes as correct -- challenges each behavioral change against whether the goal could have been achieved without breaking prior behavior. Hunts the cardinal failure mode: state that moved location/source/type/key while readers kept reading the old contract and silently broke (green build, green tests, dead feature). Analyzes necessity, cascading effects, state-contract/field-relocation, wire-up, sequencing, variant-aware coverage, and configuration. Produces a regression report, then enters planning mode to author a fix plan. Never squashes, rebases, pushes, or opens PRs.
allowed_bash_commands: [ls, stat, git, gh pr view, gh pr diff, gh pr list, gh pr checks, go, npm, grep, find, wc, cat, head, tail]
---

You are running the `/regression` command. This command detects behavioral regressions introduced by branch changes -- not general quality alignment (that is `/align`'s job). The focus is on **cascading effects**: a change to system A that breaks system B because B depended on A's prior behavior.

**The cardinal failure mode this command exists to prevent.** A change relocates, renames, or reshapes a piece of *shared state* (a field moves from object X to object Y; a value's source of truth moves; a status is now computed instead of stored). Every site that *reads* that state from the old location keeps compiling, keeps passing its tests, and silently reads a stale or default value. The build is green, the types check, the existing tests pass -- and a feature is dead in production. The auto-move-tabs-between-groups regression was exactly this: `permissionMode` and status moved off `TabState` onto the per-conversation instance, but the group-mover sites kept reading `tab.permissionMode`, so engine/extension tabs stopped moving between Planning / In-Progress / Done. The analysis dimensions below MUST be applied with this failure mode as the primary hunting target, not as an afterthought.

**Three disciplines that override "follow the loud signal."** Past runs of this command missed regressions by (a) anchoring on the two or three loudest themes of a large branch and never enumerating the quiet, multi-site features that were also touched; (b) tracing *function call chains* but not *field-read sites*; and (c) treating a green test as proof of coverage without checking which **variant** the test exercises. The elevated command corrects all three. Read the "Mandatory analysis disciplines" section below before Step 1 and apply it throughout.

---

## Mandatory analysis disciplines (apply in every dimension)

These are not optional heuristics. They are gates. A report that violates any of them is incomplete and must be redone before emission.

### Discipline A: Enumerate every touched feature, not just the loud themes

Large branches have one or two dramatic changes (a daemon migration, a restart storm) and many quiet ones (a field relocation, a status-source change, a multi-site feature whose call sites were each lightly edited). The dramatic changes are *not* where regressions hide -- they get downstream patches precisely because they are loud and someone noticed. Regressions hide in the **quiet, multi-site features** that were touched incidentally and that no single commit was "about."

Before scoring any dimension, build a **feature inventory**: list every user-facing feature or cross-cutting behavior whose files appear in the diff, however lightly. For each, ask "did this branch touch a file this feature reads from or writes to?" -- if yes, the feature is in scope for full tracing, regardless of whether any commit message mentions it. Do not let commit-message framing decide what you analyze; the diff decides. A feature with one changed line in one of its five call sites gets the same scrutiny as the headline change.

### Discipline B: Field-read tracing, not just call-chain tracing

"Identify consumers" means two distinct things, and the function-call sense is the one that lulls you. Trace BOTH:

1. **Call-chain consumers** -- who invokes the changed function / handler / event.
2. **Field-read consumers** -- who *reads a field or piece of state* whose location, source of truth, type, or population timing changed.

Field-read consumers are invisible to call-chain tracing: they do not call anything that changed; they just read `someObject.someField`, and the field now lives somewhere else, is populated by a different code path, or holds a different value. They compile. Their tests pass (the test seeds the field directly). They break at runtime.

A single `\.fieldName` grep is not sufficient -- it misses destructured reads, type-level mentions, and boundary projections. For every state-shape change, trace readers in these explicit **layers**, and in the relocation trace report the pattern used and the sites found for each:

1. **Direct property access** -- `\.permissionMode\b`, `\.status\b`, `tab\.`, `instance\.`, etc.
2. **Destructuring / pattern matching** -- `const { permissionMode }`, `({ permissionMode }) =>`, Go struct field access in literals, Swift `case .permissionMode:`.
3. **Type / interface / contract definitions** that still mention the old field or shape (even if not read in this diff) -- a stale type definition is a future reader waiting to break.
4. **Serialization, snapshot projection, IPC payload construction, and remote handler sites** -- the engine↔desktop↔iOS boundary is where a relocated field most often keeps reading the old location while everything still compiles.
5. **Helper functions / getters / selectors** that return or transform the field -- search for functions whose body mentions the field, not just call sites that name it.

A reader found in any layer that still uses the old contract for any variant is a **REGRESSION** (not RISK) unless you can prove the old location remains authoritative for every variant the feature runs in. See Dimension 3.5.

### Discipline C: Variant-aware coverage -- a green test is not proof

A test that exercises variant V1 of a code path proves nothing about variant V2 of the same path. When a change affects a code path that runs in multiple variants (CLI tab vs engine/extension tab; root agent vs sub-agent; LAN vs relay transport; macOS vs Linux; plain conversation vs extension-hosted), a passing test for V1 is **false coverage** for V2. Before trusting any existing test as coverage for a behavioral change, identify which variant its fixtures construct and whether that is the variant the change actually affects. If the test builds a CLI tab and the change breaks engine tabs, the test is blind. See Dimension 6.

**Hard rules.**

- You will not squash, rebase, amend, force-push, push, or open/modify a PR.
- You will not run `gh pr create`, `gh pr merge`, `gh pr review`, `gh pr comment`, `git push`, `git rebase`, `git commit --amend`, `git push --force`, or any commit-rewriting or remote-mutating command.
- **Committing is allowed only after the operator approves the fix plan.** During the analysis and plan phase, the only write is the plan file.
- Your analysis output is a single markdown report in this chat response. After the report, you enter planning mode to author a fix plan, then wait for operator approval before implementing.
- Do not run the heavy test gates during analysis. You may run scoped read-only commands (`git diff`, `grep`, `go build`, `npm run typecheck`) to verify hypotheses about behavioral changes.

---

## Grounding docs (always read these)

Read every one of these before evaluating anything. Do not operate from memory. Read them every invocation.

- `docs/engine-grounding.md`
- `docs/architecture/adr/001-engine-vs-harness.md`
- `docs/architecture/agent-state.md`
- `docs/architecture/file-organization.md`
- `AGENTS.md` (repo root) -- all sections, especially § "Engine consumers", § "Contract stability", § "Cross-platform parity"

Then read per-component `AGENTS.md` for every component touched in the diff:
- `engine/AGENTS.md` -- if engine touched
- `desktop/AGENTS.md` -- if desktop touched
- `ios/AGENTS.md` -- if iOS touched
- `relay/AGENTS.md` -- if relay touched and the file is present (relay has no AGENTS.md today; skip if absent)

When building the feature inventory (Discipline A) and the Changed State Shapes inventory (Step 1.5), cross-reference `docs/architecture/file-organization.md` and the component `AGENTS.md` files to map changed files to the user-facing behaviors and state contracts they participate in. Do not rely solely on commit messages or surface-level grep -- the AGENTS.md files document where per-conversation state lives (e.g. desktop's `conversationPanes` / instance fields), which is exactly the mapping needed to spot a relocation.

---

## Plan resolution rules

Inherited from `/align`. Every resolution must be a code change, contract change, code deletion, test addition, or explicit do-nothing with rationale. The following are forbidden as resolutions: TODO/FIXME comments, "open a follow-up issue", "add a narrative comment", "address in Phase N", "flag in PR description."

---

## Step 1: Determine scope

### Argument grammar

```
$ARGUMENTS ::= [<target>] [<focus>]

<target> ::=
  | "in branch" <branch-name> -> Branch mode
  | (empty)                   -> Local mode (current branch)

<focus> ::= free text narrowing which subsystems or behavioral areas to analyze
```

### Local mode (default)

```bash
git branch --show-current
```

If `main`, stop: "Regression analysis requires a feature branch. Switch to a feature branch or pass `in branch <name>`."

```bash
git log main..HEAD --oneline
git log main..HEAD --format=fuller --no-merges
git diff main...HEAD --stat
git diff main...HEAD
```

If branch is even with `main`, stop: "Nothing to analyze -- branch is even with `main`."

Print orientation: branch name, commit count, files changed, scopes touched, focus (if any).

### Branch mode

Same as local mode but uses the named branch instead of HEAD.

---

## Step 1.5: Changed State Shapes inventory (mandatory input to Dimension 3.5)

Before grounding and analysis, build an explicit inventory of every type/struct/interface whose *shape or population contract* changed. Derive it from the diff hunks that touch type definitions, struct literals, field assignments, and field accesses in the files surfaced by the feature inventory (Discipline A) -- not from commit messages.

For each changed type, record:

- **Fields added / removed / moved** to another type (relocation).
- **Fields whose source of truth, population timing, or derivation changed** (stored → computed, populated by a different event, populated by a different code path, set at creation → set on first event).
- **Fields whose keying or variant behavior changed** (compound key → bare key; keyed per-tab → keyed per-instance).
- **Ghost fields**: fields that *still exist on the type for backward compat* but are no longer populated (or are populated with a stale/default value) for some variants. These are the highest-yield entries -- a ghost field is the exact signature of the cardinal failure mode: the reader compiles, the type still has the field, but the value is wrong for the affected variant.

This inventory is the explicit trigger list for Dimension 3.5: every entry here must produce a relocation trace. If the feature inventory shows state-shape files were touched (type definitions, store slices, snapshot/IPC projection, shared types) but this inventory is empty, you have not looked hard enough -- re-examine the diff before proceeding.

Carry this inventory forward; the header reports its size and Dimension 3.5 consumes it entry-by-entry.

---

## Step 2: Ground in the principles

Read all grounding docs listed above for every component touched in the diff.

---

## Step 3: Regression analysis across the dimensions

Tag every finding: **REGRESSION** (confirmed behavioral break), **RISK** (behavioral change that may break downstream), or **COSMETIC** (behavioral change that is unlikely to cause issues).

Cite concrete file paths, line ranges, and commit SHAs in every finding. A finding without a citation is not a finding.

Apply the three Mandatory Analysis Disciplines (A: enumerate every touched feature; B: field-read tracing; C: variant-aware coverage) throughout. They are gates, not suggestions.

If a **focus instruction** was parsed, prioritize the matching dimensions at full depth; give remaining dimensions a brief pass. **Dimension 3.5 (state-contract / field-relocation) is never reduced to a brief pass** -- it runs at full depth on every invocation, focus or not, because it is the dimension that catches the cardinal failure mode.

### Dimension 1: Behavioral change detection

For each file touched on the branch, classify every diff hunk as one of:
- **Structural** (rename, extract, move, reformat -- no behavior change)
- **Behavioral** (changed control flow, sequencing, defaults, error handling, return values)
- **Additive** (new code path that didn't exist before -- no prior behavior to regress)

List every behavioral change with:
- What the old behavior was (quote the removed code or describe from context)
- What the new behavior is
- Whether any downstream consumer depended on the old behavior

### Dimension 2: Necessity challenge

Before tracing cascading effects, challenge the behavioral change itself. The branch changes are NOT the source of truth -- the prior working behavior is. For each behavioral change:

1. **Was this change necessary?** What goal does it serve? Could the goal have been achieved while preserving the old behavior? If yes, the change is a candidate for reversion rather than downstream patching.

2. **Was this the right way to achieve the goal?** Even if the goal is valid, the implementation may have introduced unnecessary behavioral changes. Example: switching from child-process engine to launchd daemon is a valid architectural goal, but it doesn't require changing the session startup pattern -- the desktop could still start sessions the same way it always did. A behavioral change that is a side effect of an implementation choice (not a requirement of the goal) is an accidental regression, not a design trade-off.

3. **Count the downstream patches.** If a single behavioral change required 2+ downstream fixes to restore the system to a working state, that is strong evidence the change itself was wrong -- or at minimum, was done without adapting its dependents. The proper fix may be reverting the behavioral change and finding a different implementation path, not patching every downstream consumer.

4. **Compare cost of reversion vs patching.** For each behavioral change that caused downstream breaks: would reverting the change and finding an alternative approach be simpler and more reliable than the patches? If reverting one change eliminates the need for three patches, reversion is the better engineering choice.

For each behavioral change, produce a necessity assessment:

```
CHANGE: <what changed>
GOAL: <what the change was trying to achieve>
NECESSARY: yes / no / partially (the goal is valid but the implementation introduced unnecessary behavioral changes)
ALTERNATIVE: <how the goal could be achieved without changing this behavior, if applicable>
DOWNSTREAM PATCHES REQUIRED: <count and list>
VERDICT: KEEP / REVISE / REVERT
```

### Dimension 3: Cascade analysis

This is the cascade-tracing dimension. For each behavioral change that survives the necessity challenge (verdict KEEP or REVISE) in Dimension 2:

1. **Identify consumers**: who called/consumed/depended on the old behavior? Trace the call chain: direct callers, event subscribers, IPC handlers, socket protocol consumers, extension SDK users.

2. **Trace the cascade**: if consumer A depended on behavior X, and X changed, did A adapt? If A adapted, did A's adaptation break A's own consumers (B, C, D)?

3. **Depth check**: go at least 3 levels deep in the dependency chain. The session timeout bug was a 3-level cascade: daemon model (level 1) -> simultaneous session starts (level 2) -> queue overflow dropping results (level 3).

4. **Environmental cascades**: changes to how the system starts, stops, installs, or recovers can cascade through every runtime path. Flag: changed process lifecycle (spawn vs daemon), changed socket paths, changed file locations, changed timing assumptions, changed ordering assumptions.

For each cascade, produce a trace:

```
TRIGGER: <what changed> (<commit SHA>)
  L1: <first-order effect>
  L2: <second-order effect>
  L3: <third-order effect (if any)>
CONSUMERS AFFECTED: <list>
ADAPTED: yes/no (per consumer)
BLAST RADIUS: <X read/call sites across Y files; Z features; variants: [list]; hot path? yes/no>
USER-VISIBLE SYMPTOM IF THIS FIRES: <concrete observable failure, or "none (internal only)">
VERDICT: REGRESSION / RISK / OK
```

### Dimension 3.5: State contract and field-relocation tracing (the field-read cascade)

**This is the dimension that catches the cardinal failure mode.** It is mandatory on every run, and it is the highest-yield dimension on any branch that refactors state shape. Run it with Discipline B.

A *state contract* is the agreement about where a piece of data lives, what populates it, what type it is, and when it is valid. Branches that unify models, collapse keys, move per-X state onto per-Y objects, derive-instead-of-store, or change which code path populates a field all mutate state contracts. The danger: readers that still read the old contract compile cleanly and fail silently.

**Step 1 -- detect state-contract changes.** Scan the diff for any of these signals:

- A field removed from one type/struct and added to another (relocation). Example: `permissionMode` removed from `TabState`, now on `ConversationInstance`.
- A field that changed from *stored* to *derived/computed* (or vice versa). Example: `hasEngineExtension` removed from runtime state, now derived via `tabHasExtensions()`.
- A field whose *source of truth* moved (one code path used to populate it; now a different one does, or it is populated from a different event/key).
- A key or identifier whose format changed (compound `tabId:instanceId` -> bare `tabId`); anything that parses or constructs it.
- A field whose population *timing* changed (was set at creation; now set on first event -- so early readers see a default).
- A Map/collection that was keyed one way and is now keyed another, or split/merged.
- A status or mode that is now sourced from a sub-object (instance, pane) instead of the parent (tab), or now flows through a different event variant.

**Step 2 -- for EACH detected state-contract change, enumerate every reader.** This is not optional and not sample-based. Grep the entire consuming surface for reads of the affected field by name (and by any alias/destructure). For a desktop field like `permissionMode`, that means searching `desktop/src/` exhaustively: store slices, hooks, components, IPC handlers, snapshot projection, remote handlers. For an engine field, search every package plus the TS/Swift mirrors. List every read site.

**Step 3 -- classify each reader against the new contract.** For each read site:

- Does it read from the NEW location/source/format, or the OLD one?
- If it reads the old location, does that location still hold a valid value for ALL variants, or only some? (The classic break: the field still exists on the old object for variant V1 (CLI tab) but is now stale/default for variant V2 (engine tab), because V2's real value moved to the instance.)
- Is this reader on a hot path for a user-facing feature? (Auto-move, status dots, badges, permission gating, routing.)

**Step 3.5 -- compatibility / transition-layer audit.** Before producing the trace, determine whether the branch introduced any adapter / migration / shim that populates the *old* location from the *new* one (or vice versa) so existing readers keep working during the transition:

- **If a shim is present:** is it complete for *every* variant the feature runs in? Check the awkward variants explicitly -- engine/extension tab vs CLI tab, root vs sub-agent, LAN vs relay, plain vs extension-hosted. An *incomplete* shim is the exact auto-move signature: the field still exists on the old object (readers compile) but is populated only for some variants. Treat an incomplete shim's unpopulated variant as a REGRESSION.
- **If no shim is present:** this is a clean break on a shared state contract. Raise severity -- a clean break on a field that multiple independent readers depend on is higher risk than an imperfect attempt to preserve the old contract, because nothing is even trying to keep the old readers correct.

**Step 4 -- a reader that reads the old contract for any variant is a REGRESSION, not a RISK**, unless you can prove the old location is still authoritative for every variant. "It compiles and the test passes" is not such a proof -- see Discipline C.

Produce, for each state-contract change, a relocation trace:

```
STATE CHANGE: <field> moved/derived/retyped/rekeyed (<commit SHA>)
OLD CONTRACT: <where it lived / how it was sourced before>
NEW CONTRACT: <where it lives / how it is sourced now>
READERS FOUND (layered, per Discipline B): <file:line list, grouped by layer 1-5>
READERS STILL ON OLD CONTRACT: <subset that did not adapt>
COMPATIBILITY SHIM: present / incomplete / absent
VARIANT GAP: <which variant(s) now read a stale/default value, e.g. "engine/extension tabs">
BLAST RADIUS: <X reader sites across Y files; Z features; affected variants: [list]; hot path? yes/no>
USER-VISIBLE SYMPTOM IF THIS FIRES: <concrete observable failure, e.g. "engine/extension tabs stop auto-moving between Planning/In-Progress/Done">
VERDICT: REGRESSION / RISK / OK (per reader)
```

If you find zero state-contract changes on a branch that the feature inventory (Discipline A) shows touched state-shape files, you have not looked hard enough -- re-scan.

### Dimension 4: Wire-up audit

Check that features which existed before the branch still have their wiring intact:

- Event handlers: were any removed or renamed without updating all consumers?
- IPC channels: did any channel name or shape change without updating both sides?
- Hook registrations: did any hook lose its registration site?
- Extension entry points: did extension loading, init, or dispatch paths change?
- Socket protocol: did any command or event type change without updating all consumers?

For each broken wire-up, name: the old wire, the commit that broke it, and the consumer that lost it.

### Dimension 5: Sequencing and timing regressions

Changes to execution order are a major regression source. Check:

- Did the order of initialization change? (e.g., engine starts before/after desktop connects)
- Did synchronous operations become async or vice versa?
- Did sequential operations become parallel or vice versa?
- Did blocking operations become non-blocking or vice versa?
- Did timeout values change?
- Did retry logic change?
- Did queue sizes, buffer sizes, or concurrency limits change?

For each sequencing change: what was the old order, what is the new order, and does any consumer depend on the old order?

### Dimension 6: Test coverage of behavioral changes (variant-aware -- guard against false coverage)

For each behavioral change from Dimension 1 and each state-contract change from Dimension 3.5:

- Does a test pin the NEW behavior? (Not just "does a test exist" -- does it assert the specific behavioral change?)
- If the behavioral change were reverted, would the test fail? (Mentally revert; if the test stays green, it does not cover the change.)
- **Variant check (Discipline C):** which variant do the test's fixtures construct, and is that the variant the change affects? A green test that builds variant V1 is FALSE COVERAGE for a change that breaks variant V2. Concretely: a test that constructs a CLI tab (`engineProfileId: null`, `permissionMode` set directly on the tab) does NOT cover an auto-move change that breaks engine/extension tabs (where `permissionMode` lives on the instance). When the changed path runs in multiple variants, the test must construct the variant that changed -- otherwise flag the change as **uncovered (false coverage)**, which is a RISK at minimum and a REGRESSION if Dimension 3.5 already showed the variant breaks.
- If no test pins the new behavior for the affected variant, flag as RISK (or REGRESSION if the break is already demonstrated).
- **Intentional vs accidental discriminator:** would a test asserting the *old* behavior now fail (or have been updated/deleted on this branch)? If an old-behavior test was deliberately changed to match the new behavior, the change was intentional. If no test ever asserted the old behavior, the change could be an accidental side effect -- weight it toward REGRESSION and scrutinize necessity (Dimension 2) harder.

When you cite an existing test as evidence a behavior is covered, you MUST state which variant its fixtures build. "tab-group-pin.test.ts asserts moveTabToGroup is called" is insufficient; "tab-group-pin.test.ts asserts it for a CLI tab (engineProfileId: null) but never for an engine tab" is the required form -- and it exposes the gap.

### Dimension 7: Configuration and environment regressions

Check:
- Did any config key names change?
- Did any default values change?
- Did any environment variable handling change?
- Did any file paths change (socket paths, config paths, PID paths, log paths)?
- Did any launchd/systemd/daemon configuration change?
- Did install/uninstall scripts change in a way that affects existing installations?

---

## Step 3.9: Pre-emission self-check (mandatory gate before the report)

Before emitting the report, answer each question below in your working notes. If any answer is "no" or "not sure," return to the relevant dimension and finish the work -- do not emit the report yet. These questions encode the exact ways past runs missed regressions.

1. **Feature completeness (Discipline A).** Did I build a feature inventory from the *diff*, not the commit messages? Is every feature in it traced somewhere in the report? Are the *quiet, multi-site* features (not just the loud themes) each given full tracing?

2. **State-contract scan (Dimension 3.5).** Did I scan the diff for field relocations, derive-instead-of-store changes, source-of-truth moves, key-format changes, population-timing changes, and re-keyed collections? For each one found, did I run an *exhaustive* grep for readers and classify every reader against the new contract?

3. **Field-read tracing (Discipline B).** For every changed field/state, did I trace *field-read* consumers (sites that read `obj.field`), not only *call-chain* consumers (sites that call a changed function)? Field-read consumers compile and pass tests while silently reading the wrong location -- did I hunt them specifically?

4. **Variant coverage (Discipline C).** For every behavioral/state change that runs in multiple variants (CLI vs engine tab, root vs sub-agent, LAN vs relay, plain vs extension-hosted, macOS vs Linux), did I check which variant each cited test actually constructs? Did I label any green-but-blind test as false coverage rather than as coverage?

5. **The cardinal failure mode.** Concretely: did I verify that every feature gated on a relocated/derived/retyped field still fires for the variant whose value moved? If a feature reads `tab.<field>` and `<field>` moved to the instance for engine tabs, did I confirm the feature still works for engine tabs -- or flag it as a REGRESSION if it does not?

6. **State-shape completeness.** Did I produce the Changed State Shapes inventory (Step 1.5)? For every entry, did I run the full layered reader discovery (Discipline B, layers 1-5) and the compatibility-layer audit (Dimension 3.5 Step 3.5)?

7. **Ghost field / partial population.** For every state-contract change, did I explicitly check whether the old field still exists on the type but is now zero-value / stale / unpopulated for the affected variant(s)? Did I treat every ghost-field reader as a REGRESSION rather than assuming the field is still authoritative?

8. **Hot vs cold path + initialization.** For each changed reader, did I classify it as hot path (user-visible: auto-move, status, permission gating, badges, routing) or cold path (error recovery, first launch after install, extension reload, daemon restart)? Did I flag any state-contract change that affects initialization timing or population order, where an early reader sees a default before the real value arrives?

Only after all eight are satisfied do you proceed to Step 4.

---

Terminal-first inverted structure (user's cursor lands at the bottom).

Render sections in this exact order, top-to-bottom:

### 1. Header

```
Mode: local | branch
Branch: <name>
Range: main..HEAD (<N> commits)
Files changed: <N>
Scopes touched: <list>
Focus: <quoted instruction or "none">
Features in inventory: <N> (Discipline A)
Behavioral changes detected: <N>
State-contract changes detected: <N> (Dimension 3.5)
Compatibility shims found: <N> (of which incomplete: <M>)
Necessity challenges: <N changes challenged, N recommended for reversion>
Cascades traced: <N>
```

### 2. What was not analyzed

Be explicit: runtime behavior requiring execution, integration test results, iOS build verification, external consumer compatibility (unless the wire protocol changed).

### 2.5. Feature inventory (Discipline A)

A table of every user-facing feature or cross-cutting behavior whose files appear in the diff -- including the quiet, multi-site ones no commit was "about." This is the proof that you enumerated the whole surface, not just the loud themes. Any feature listed here that is not traced elsewhere in the report is an admission of an unanalyzed surface and must be resolved before emission.

```
| Feature / behavior | Files in diff it touches | Traced? (dimension) |
|--------------------|--------------------------|---------------------|
```

### 3. Behavioral changes inventory

A compact table of every behavioral change detected in Dimension 1:

```
| # | File | Old behavior | New behavior | Consumers | Verdict |
|---|------|-------------|-------------|-----------|---------|
```

### 4. Necessity assessments

Full necessity assessments from Dimension 2, ordered by verdict (REVERT first, then REVISE, then KEEP). Each assessment uses the format shown in Dimension 2.

This section answers: were the changes themselves correct, or did we introduce unnecessary behavioral shifts that could have been avoided? A change that required 3 downstream patches to restore working behavior is evidence the change itself was the wrong approach.

### 5. Cascade traces

Full cascade traces from Dimension 3, ordered by severity (REGRESSION first, then RISK, then OK). Each trace uses the format shown in Dimension 3. Only changes that survived the necessity challenge (verdict KEEP or REVISE) appear here.

### 5.5. State-relocation traces (Dimension 3.5)

Full relocation traces from Dimension 3.5, one per state-contract change, ordered by severity. Each uses the `STATE CHANGE / OLD CONTRACT / NEW CONTRACT / READERS FOUND / READERS STILL ON OLD CONTRACT / COMPATIBILITY SHIM / VARIANT GAP / BLAST RADIUS / USER-VISIBLE SYMPTOM / VERDICT` format shown in Dimension 3.5. This section is mandatory whenever the branch changed any state shape; if the branch changed state shape and this section is empty, the analysis is incomplete.

### 6. Wire-up gaps

Findings from Dimension 4, with the broken wire, the breaking commit, and the affected consumer.

### 7. Sequencing changes

Findings from Dimension 5.

### 8. Coverage gaps

Findings from Dimension 6 -- behavioral changes without test coverage, **including false coverage**: behavioral/state changes whose only "passing" test exercises a different variant than the one the change affects. For each, state the variant the test constructs and the variant that changed.

### 9. Configuration changes

Findings from Dimension 7.

### 10. Recommendations

Numbered list of concrete fixes, ordered by severity. Each recommendation maps to a specific finding and names the exact file and change needed. For changes with verdict REVERT: the recommendation is reversion, not downstream patching. For changes with verdict REVISE: the recommendation names a specific alternative implementation that achieves the same goal without the behavioral regression.

### 11. Critical Actions Summary

```
| # | Severity | What | Files | Cascade depth | Blast radius (sites/features, hot path) | One-line rationale |
|---|----------|------|-------|---------------|------------------------------------------|-------------------|
```

### 12. Verdict

Exactly one of:

- ✅ **CLEAN** -- {0 regressions, 0 risks}. No behavioral regressions detected.
- 💬 **CLEAN WITH RISKS** -- {0 regressions, N risks}. No confirmed regressions but N behavioral changes lack coverage or have unverified cascades.
- 🔶 **NEEDS INVESTIGATION** -- {N risks with unverified cascades}. Behavioral changes detected that could not be fully traced without runtime verification.
- 🛑 **REGRESSION DETECTED** -- {N confirmed regressions}. Behavioral changes that demonstrably break downstream consumers.

Include actual counts. The verdict is the final line on screen.

---

## Step 5: Enter planning mode and author the fix plan

After emitting the report, enter planning mode and author a fix plan that resolves every REGRESSION and RISK finding. Same rules as `/align` Mode B:

- Each finding maps to one or more plan steps
- Resolutions must be code changes, contract changes, code deletions, or tests -- never documentation-as-fix
- The fix plan does not include squash, rebase, push, or PR steps

**Verification hook (mandatory for every REGRESSION and every RISK with a variant gap or state-contract issue).** "Update the reader to the new location" is not, by itself, a complete plan step for a state-contract finding -- without a verification hook, the same class of regression recurs the next time state moves. Each such step MUST include at least one of:

- **A new or updated test that constructs the *affected variant*** (e.g. an engine/extension tab, not a CLI tab) and asserts the reader now reads the correct contract/location. This is the default and strongly preferred -- it is the repo's "testing is mandatory" rule made specific to the variant that broke.
- **Permanent structured logging at the read site** (via the repo's logging helpers) that records which contract/location was read and for which variant -- only when an automated test is genuinely infeasible at that seam. This must be *permanent* observability, not scaffolding: do NOT plan a "temporary assertion to remove later" or a TODO/follow-up (forbidden by the repo's anti-stopgap and "logging is permanent" rules).

A plan step that changes a reader's source without one of the above is incomplete and must be revised before the plan is presented.

If the verdict is CLEAN, still enter planning mode with a stub plan stating no regressions were found.

Print:

> Regression analysis complete -- {verdict} with {N regressions, N risks, N cosmetic}. Fix plan authored.

End with:

> Regression analysis complete and a fix plan has been authored in planning mode. I have not edited source, committed, squashed, pushed, or opened a PR. Review and approve the plan; once approved, I implement the fixes and commit them. If there was nothing to fix, the plan is empty.

Stop and wait for operator approval.

## Step 6: Implement the approved fix plan (post-approval only)

Same as `/align` Mode B, Step 6:

1. Implement every plan step (code changes, tests, contract changes).
2. Run scoped quality gates (not heavy PR-time gates).
3. Commit with conventional, correctly-scoped commits.
4. Never squash, rebase, push, or touch a PR.

Report what landed and stop.
