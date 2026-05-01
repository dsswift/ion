---
title: File Organization
description: Architectural rules for file structure, sizing, and context-file scoping in an AI-primary codebase.
sidebar_position: 6
---

# File Organization

Ion is built primarily by AI coding agents. The architectural rules in this document are tuned for that constraint: minimize the work an agent must do to find the right code, and prevent both god files (which exceed retrieval limits) and over-fragmentation (which scatters the read-set across the tree).

## Primary principle: cohesion of change

**A change to feature X should touch files in one folder, not seven.** When deciding where code lives, ask: *what other files change together with this?* — that's the folder.

Every other rule on this page serves cohesion of change.

## Why this matters (research backing)

The rules below are grounded in 2024-2026 evaluation literature on AI coding agents:

- **SWE-Bench Mobile (22 agent/model configs):** task success drops from 18% on tasks touching 1-2 files to 2% on tasks touching 7+ files. Held across Cursor, Codex, Claude Code, OpenCode. Source: SWE-Bench Mobile evaluation.
- **Indexing cliff:** files larger than ~500 KB are dropped from semantic indexes entirely; god files become invisible to retrieval.
- **Lost in the middle (Liu 2023, refined Veseli 2025):** tokens at start/end favored, middle gets lost. Token count matters more than file count. Applies inside one long file *and* across many loaded files.
- **Modularity counterintuitive (Revisiting Modularity, 2024):** modular vs non-modular code, same functionality, gives small differences in LLM generation quality — sometimes non-modular wins. Modularity helps the *agent* mainly by shrinking the read-set per task.
- **Codebase-as-prompt (Karpathy, Oct 2025):** AI fails when code doesn't look like its training distribution. Idiomatic, conventional structure beats clever organization regardless of size.
- **Context-file failure modes (ETH Zurich, March 2026; Codified Context, March 2026):** monolithic root context files cost ~+20% steps regardless of quality; LLM-generated ones often hurt; specification staleness is the primary failure mode.

## Rules

### 1. File size budgets

Targets exist to prevent both god files (token rot, indexing cliff) and over-fragmentation. Hit them by splitting at concept boundaries, not arbitrary line counts.

| Language | Soft target | Hard cap (CI fails) |
|----------|------------:|--------------------:|
| TypeScript / TSX | 300 lines | 600 lines |
| Go (excl. `_test.go`) | 400 lines | 800 lines |
| Go (`_test.go`) | 800 lines | 1500 lines |
| Swift | 300 lines | 600 lines |

**Override:** `// @file-size-exception: <reason>` (or `# @file-size-exception:` for shell/yaml) on line 1. Use only when the file is intrinsically a single concept (table-driven switch, generated code, test fixture). The reason survives review.

**Why hard caps:** AI ignores soft guidance; AI does not ignore CI failures. A hard cap forces the architectural decision (where does the next concept go?) at PR time, not 6 months later.

**Caps are a smell test, not the goal.** A 250-line file that pulls a feature into one place beats five 50-line files an agent must traverse.

### 2. One concept per file (idiomatically)

A "concept" is a struct/class with its methods, OR a Zustand slice, OR an IPC feature module, OR a React component with its hook and tests in a folder. The filename announces the concept.

**Per language:**

- **Go:** same-package multi-file. `manager.go`, `agent_registry.go`, `prompt_dispatch.go` — type plus its methods plus small helpers in one file. NOT `types.go` with 30 unrelated types.
- **TypeScript / React:** feature folder containing component + hook + test + types. NOT a `types/` directory split from implementations.
- **Swift:** one type per file is idiomatic; iOS already follows. Don't fight it.

**Naming rule:** the filename names the concept. `agent_registry.go` not `extras.go`. `tab-slice.ts` not `helpers.ts`. If you can't name a file in 1-3 words, it's doing too much.

### 3. Co-locate by feature, not by kind

**Bad:** `types/`, `helpers/`, `constants/`, `__tests__/` directories that separate kinds.

**Good:** `session/agent_registry.go` with the type, methods, constants, helpers, and `_test.go` sibling.

**Exception:** cross-cutting types shared across many packages may live in a small dedicated package — `engine/internal/types/` already does this with one file per concept (preserve).

### 4. Tests next to source

- **Go:** already does this. Keep.
- **TypeScript:** prefer `Foo.test.ts` next to `Foo.ts`. Tests next to source make scope obvious to AI and humans alike. Centralized `__tests__/` directories are acceptable but lose locality.
- **Swift:** Xcode convention forces a separate test target. Keep `IonRemoteTests/`, but mirror the source folder structure inside.

### 5. Subfolder when a concept grows past ~5 files

A subfolder is an indicator that a concept has internal structure. Extract to a subfolder when the file count crosses ~5. Do NOT pre-create empty hierarchies.

### 6. Idiomatic structure beats clever structure

When in doubt, organize the way other projects in the same stack organize. AI fails when the code doesn't look like its training distribution. Idiomatic, conventional, "where you'd expect it" structure outperforms architecturally clever structures regardless of file size choices.

## Context files: AGENTS.md and CLAUDE.md

### Filename convention

**AGENTS.md is canonical and committed.** It's the cross-tool open standard (Cursor, Codex, OpenCode, and others).

**CLAUDE.md is a local-only gitignored symlink to the sibling AGENTS.md.** Claude Code auto-loads `CLAUDE.md` but not `AGENTS.md`; the symlink gives Claude Code the auto-load behavior without committing duplicate files.

Run `scripts/setup-claude-symlinks.sh` (or `make claude-symlinks`) after pulling new AGENTS.md files. The desktop `npm install` postinstall hook also runs it automatically.

### Scope

**Today: area-level only.** Each major top-level component carries one AGENTS.md:

- `AGENTS.md` (root) — principles + pointer here.
- `desktop/AGENTS.md` — desktop client conventions.
- `engine/AGENTS.md` — Go engine conventions.
- `ios/IonRemote/AGENTS.md` — iOS conventions.

**Today: NOT seeded per bounded context.** No `desktop/src/main/ipc/AGENTS.md`, no `engine/internal/session/AGENTS.md`, etc.

**Why defer per-bounded-context AGENTS.md?** This is a defensible inference, not a research finding:

- ETH Zurich (March 2026) tested ~one context file per repo and found it cost +20% steps regardless of quality, with developer-written files giving small accuracy gains. Per-bounded-context scoping is intuitive but unstudied — seeding scoped files now would bet on a model of where confusion *should* occur, validated against nothing.
- Codified Context (March 2026) flags specification staleness as the primary context-file failure mode. During god-file decomposition (the next several phases of work), conventions are actively changing; an AGENTS.md written today partially describes the legacy shape and partially the target.

**The bet:** post-decomposition, context-file content writes itself from the artifacts the work produces (decomposition ADRs, file-organization rules, characterization tests).

### Tripwire (instrumented evidence drives future seeding)

Once decomposition stabilizes, instrumented agent traces will identify subtrees with persistent navigation pain — those are the bounded contexts that earn a scoped AGENTS.md. Until then, none.

Concrete metrics to watch:

- **Files-read-per-task** scoped by directory.
- **Tool-calls-to-first-relevant-file** scoped by directory.

Subtrees consistently in the top-N → write a scoped AGENTS.md grounded in the actual confusion patterns. Re-measure after seeding; remove the file if the metric does not improve within ~2 weeks.

### Honest framing

When updating context files, distinguish what research shows from what is a defensible inference. Don't write "research shows we should seed per bounded context." Do write "we adopted area-level seeding now and deferred bounded-context seeding pending instrumented evidence, based on three findings: (1) context files cost steps, (2) staleness is the primary failure mode, (3) minimal beats verbose."

## Enforcement

- **CI:** `scripts/check-file-sizes.sh` runs on every PR. Fails if any file exceeds the language's hard cap, unless on `.file-size-allowlist.yml` or annotated with `@file-size-exception`.
- **Allowlist:** existing god files are temporarily allowed during decomposition. Allow-list shrinks per phase; new entries require explicit reviewer approval.
- **Pre-push:** the same check is wired into the existing pre-push hook for fast local feedback.
- **Lint (TypeScript):** ESLint's `max-lines` rule complements the bash gate.
- **Lint (Swift):** SwiftLint's `file_length` rule.

## Non-goals

- This document does NOT prescribe how to design APIs, package boundaries, or interfaces. Those concerns are addressed in `engine/AGENTS.md`, `desktop/AGENTS.md`, and per-component architecture docs.
- This document does NOT mandate a single style across all of Ion; it provides per-language defaults and lets each ecosystem follow its idioms.
