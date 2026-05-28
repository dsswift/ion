---
title: "ADR-006: Deterministic Seams and Probabilistic Judgment"
description: Within an Ion harness, invariants belong in deterministic hook code; decisions that benefit from context belong in the LLM. The engine's defining property is letting you mix the two cleanly at well-defined seams.
sidebar_position: 6
---

# ADR-006: Deterministic Seams and Probabilistic Judgment

## Status

Accepted

## Date

2026-05-28

## Context

Ion is, structurally, a stdio binary that streams JSON-RPC frames and fires
named hooks at well-defined seams. A harness — whatever language, whatever
shape — decides what each seam means. The engine itself ships no policy
(ADR-001). The harness composes engine mechanics with LLM judgment to
produce the user-visible product.

There is a recurring authoring question across every harness we have built
(ion-meta, chief-of-staff, ion-canary, the desktop, Chris's mixed Python/TS
Jarvis harness, the routines-daemon, the geek-tech-live agentHarness): for
any given behavior, **should this be code or should this be the LLM?**

Naively, more LLM = more flexible. In practice, the harnesses that work
well treat that question as the central design decision and answer it
deliberately for each seam. The harnesses that drift treat the LLM as the
default and end up with invariants enforced by persona prose — which is
strong, but not deterministic, and degrades the moment a model is swapped,
a prompt is rephrased, or context is compressed.

ADR-001 framed *who* owns a concern (engine vs harness). ADR-006 frames
*how* the harness should resolve concerns internally: which rules want
deterministic code at hook-time, which rules want LLM judgment, and where
the two compose.

## Decision

**Within a harness, invariants belong in deterministic code; decisions that
benefit from context belong in the LLM. The engine's hook system is the
seam where the two compose.**

The harness author's job is to identify, for every behavior they want, which
column it belongs in:

| Belongs in deterministic code (a hook handler) | Belongs in the LLM |
|---|---|
| Safety invariants — "never let X happen" | "What should I write here?" |
| Irreversibility constraints — "never delete without confirmation" | "Which agent should handle this?" |
| Policy / compliance — "never call this provider on weekends" | "How should I phrase this?" |
| Format / shape — "every emit must include sessionKey" | "Which file is the user referring to?" |
| Gating — "only edit files inside a git working tree" | "Is this edit a good idea?" |
| Routing primitives — "messages of type X go to handler Y" | "Is this message a question, a build request, or a tutoring ask?" |
| Cost guards — "no model dispatch over $0.20/turn without approval" | "Does the user want more depth or a quick answer?" |

The seam is the hook. The harness registers a deterministic handler at
the relevant hook (`tool_call`, `before_prompt`, `permission_classify`,
`before_plan_mode_enter`, `*_tool_call`, …). The handler runs *before* the
LLM produces output downstream, can block or rewrite, and is non-bypassable
by any subsequent LLM behavior.

The LLM then makes the probabilistic decisions that benefit from context
within the space the deterministic gates allow.

### Worked examples

**Example 1 — ion-meta's git-gate.** The `extension-improver` and
`extension-builder` agents have `Edit` and `Write` tools. The user may
ask them to "edit my file at /tmp/foo.ts." Should the harness allow this?

- Deterministic part: the harness registers a `tool_call` hook that walks
  up from `file_path` looking for `.git/`. If none is found, the call is
  blocked with `{ block: true, reason: "..." }`. The reason explains
  exactly why and offers three remediations.
- Probabilistic part: the LLM decides *what* edit to make, *which* file
  to target, and *how* to phrase the refusal back to the user when the
  gate fires.

The persona could ask the LLM to enforce this rule. It would mostly work.
It would not survive a model swap, a context compression, or a
sufficiently insistent user. The hook does survive all three.

**Example 2 — `permission_classify`.** Permission tiering is a classic
deterministic-seam case. The harness maps tool-name + argument-shape to
one of `auto-approve`, `prompt`, `deny`. The mapping is deterministic
because a user must be able to trust that *the same call always gets the
same tier*. The LLM does not get to argue the tier. But the *reason text
shown to the user when the prompt appears* is LLM-formatted, because
phrasing benefits from context. Determinism at the wire, LLM-formatted
at the consumer.

**Example 3 — `engine_agent_state` snapshot contract.** The contract
itself is deterministic (`docs/architecture/agent-state.md`): every
emission is a complete snapshot; consumers replace local state. This is
not a judgment call — it is a wire-level invariant. The LLM never decides
"should I emit a delta this time?" The harness code emits the full
snapshot every time. *Which* agents appear in the snapshot and *what*
their `lastWork` strings say is LLM-driven.

**Example 4 — scheduling.** A harness that wants a routine to run daily
at 7am should register a deterministic schedule (`registerSchedule(id,
cron, handler)`); the engine emits `engine_schedule_fired` at the right
time. The cron is deterministic. The *body* of the routine — what the
LLM should think about, what message to send — is probabilistic and
contextual. Implementing scheduling with `setInterval` + LLM-evaluated
"is it time to run?" prompts is the anti-pattern: the LLM is making a
clock decision, which is exactly the kind of thing a clock should make.

### Counter-examples: don't gate the wrong thing

The gate must be on the *invariant*, not on the *content*. Concretely:

- **Do** gate "is this edit permitted at all" (path inside a repo, file
  not in a forbidden list, target not the engine's own source). That's
  an invariant.
- **Don't** gate "is this edit a good idea, does it match the user's
  intent, would they want it?" That's a judgment call. The LLM is the
  right tool.
- **Do** gate "every dispatch must include a non-empty task description."
  Invariant.
- **Don't** gate "the task description must be at least 50 words and
  mention three pieces of context." That's an attempt to enforce
  judgment with code, and it always fails (the LLM pads the string to
  pass the check; the invariant is illusory).

A useful test: if the rule is "X is forbidden regardless of context," it
wants deterministic code. If the rule is "X is good when Y, bad when Z,"
it wants the LLM with hooks for the bright-line cases at the edges.

## Consequences

- **Harness authors learn to think in seams.** "Where do I want a
  deterministic refusal?" becomes a design step alongside "what should
  the persona say?" Both are part of authoring a harness.

- **Personas shrink for invariant rules.** When a rule is enforced by a
  hook, the persona doesn't need to repeat it (and shouldn't — repeating
  it wastes tokens and lets the model think it can negotiate). The
  persona references the hook ("when you are blocked by the git-gate,
  surface the reason verbatim and offer the three remediations") rather
  than re-stating the rule.

- **Engine remains policy-free.** The engine fires the hook; the harness
  decides what to do. The same engine binary powers a code assistant
  with strict write gates, a research workflow with lenient ones, and
  a wedding planner that doesn't need them at all. ADR-001's
  engine-vs-harness boundary holds because the harness is the one
  authoring the deterministic seams.

- **LLM remains free where freedom helps.** The LLM is not asked to
  enforce rules it can't reliably enforce; the deterministic layer
  catches the bright lines, and the LLM does what it does well —
  context, nuance, language, judgment under uncertainty.

- **Cross-link with ADR-001.** ADR-001 answers "engine or harness?";
  ADR-006 answers "within the harness, code or LLM?". Most harness
  design questions resolve to one of these two framings. When a user
  asks ion-meta "how should I structure this?", the right teaching move
  is to identify which framing applies and cite the relevant ADR.

## Implementation notes

- The canonical example landed first in ion-meta itself: the git-gate
  in `engine/extensions/ion-meta/git-gate.ts` and its `tool_call` hook
  wiring in `engine/extensions/ion-meta/index.ts`. The agents
  (`extension-improver`, `extension-builder`) make probabilistic
  decisions; the gate makes the deterministic ruling about whether the
  target is safe to edit at all.

- ion-meta's `ion-tutor` agent persona references this ADR explicitly:
  when users ask "where should this logic live?" questions, the tutor
  cites ADR-001 (engine vs harness) and/or ADR-006 (deterministic code
  vs LLM) rather than answering the surface question.

- The principle is also embedded in ion-meta's persona generator
  (`engine/extensions/ion-meta/persona.ts`, `sectionDeterministicSeams()`)
  so every dispatched ion-meta agent carries the framing without having
  to re-derive it.

## References

- [ADR-001: Engine vs Harness Delegation](./001-engine-vs-harness.md)
- [Agent state snapshot contract](../agent-state.md)
- [Hook reference](../../hooks/reference.md)
- ion-meta git-gate: `engine/extensions/ion-meta/git-gate.ts`
- ion-meta persona generator: `engine/extensions/ion-meta/persona.ts`
