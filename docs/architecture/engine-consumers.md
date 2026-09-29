---
title: Engine Consumers
description: Who consumes the Ion Engine, and how that shapes review of engine surface.
sidebar_position: 9
---

# Engine Consumers

> **The Ion Engine is the product. The desktop, iOS, and relay applications in this repo are reference implementations — opinionated demonstrations of how to consume the engine. They are not the canonical consumer set. The canonical consumer is every external developer building against the wire protocol and SDK.**

## Who the real consumers are

- **TypeScript SDK consumers** — extensions installed at `~/.ion/extensions/` and third-party extension authors.
- **Go SDK consumers** — third-party harnesses, custom backends, server-side integrations.
- **Wire-protocol consumers** — anyone building a custom client (CLI, web app, mobile app, IDE plugin, automation pipeline, shell script) directly against the NDJSON socket.
- **The desktop, iOS, and relay applications in this repo** — one reference implementation, not the only one. **Reference implementations consume the engine; they do not define its surface.**
- **Future consumers we have not met yet** — every public release of the engine ships with the expectation that someone we have never spoken to will build something on top of it tomorrow.

## Reframe 1 — "No in-repo caller" is the expected default for new engine surface, not evidence of accidental addition

When the engine ships a new hook, protocol field, SDK type, normalized event variant, tool, or config option, the expected steady state is that the in-repo reference implementations do **not** consume it. They consume *some* engine features to be useful as references; they do not consume *every* engine feature, and they should not.

When you find a piece of engine surface with no desktop/iOS caller, the questions to ask are:

- Is this surface useful to a plausible external consumer? (If yes → ship it.)
- Does it have tests pinning its behavior? (If yes → ship it.)
- Does it have documentation explaining how external consumers should use it? (If no → that's the gap to fix, not the engine surface itself.)

The question to **never** ask: *"Does desktop use this yet?"* That framing is forbidden. A reviewer who anchors a recommendation on it is reviewing the wrong codebase.

## Reframe 2 — Reference implementations carry a reputational quality bar, not a coverage bar

External developers learn how to consume the engine by looking at the desktop and iOS apps. So those apps must be exemplary — idiomatic, well-architected, well-tested, observable, free of anti-patterns. But "exemplary" is about *how* the references consume the engine, not *how much* they consume. A desktop that demonstrates 30% of engine features at the highest quality bar is a better reference than a desktop that demonstrates 100% of engine features sloppily. The desktop is not the SDK contract; it is one careful interpretation.

## The forbidden review question

**Do not ask "does desktop use this?" when reviewing engine changes.** That question presupposes the reference implementation is the canonical consumer. It is not. Ask instead: *would any plausible external consumer want this?* If yes, the engine should ship it. The absence of an in-repo caller is not a smell; it is the expected default for a healthy engine that ships ahead of its reference implementations.

## The external-consumer simulation (use this instead of in-repo caller search)

Before flagging an engine change as a contract violation, ask: *would this break a hypothetical external consumer who built against the previously-published surface?*

- If the answer is "they would have to ignore a new optional return value" or "they would have to add a new optional field" — that's **not** a break. It's good evolution.
- If the answer is "their existing struct decode would fail" or "their existing argument list would no longer match" — that **is** a break.

Use the external-consumer simulation, not the in-repo caller search, to decide.

## The typed-event corollary

When the engine has signal to communicate, it emits a typed `NormalizedEvent` variant. That emission is the engine's *complete* fulfillment of its signaling obligation for that signal. The engine does not also owe a parallel surface in stream content (no appending to `TaskCompleteEvent.Result`, no mutating `TextChunkEvent`, no synthetic system messages, no log-line-as-source-of-truth). Doing any of that would force every consumer through one specific UI-shaped interpretation and would corrupt headless pipelines that parse stream content as the LLM's verbatim output.

Consequence: when a reviewer asks *"but a headless user who isn't subscribed to event X wouldn't notice Y"* — that is the engine working as designed. The headless user receives the JSON event stream; the typed event is in it. Their orchestration may abort, retry, notify, ignore, or do anything else. The engine has no opinion. Reference implementations in this repo (desktop, iOS) choose their own opinionated rendering; that is **one consumer's policy**, not the engine's recommendation.

This applies equally to warnings (model fallback, deprecation notices), advisories (rate limits, retries, context compaction), and state transitions (agent lifecycle, plan-mode changes). Pick the right event shape, emit it once, and stop. Do not double-surface.

## Consequences (the operational rules that flow from the framing above)

- **Do not require an in-repo consumer before adding engine API surface.** If a hook, protocol field, or SDK method is useful to external consumers, it belongs in the engine — even if desktop and iOS don't use it yet. The absence of desktop/iOS usage is not evidence of premature code; it is evidence that the reference implementations haven't caught up.
- **Engine API surface should be generous.** Every configurable behavior should be exposed: as an `engine.json` config field, as a per-prompt `ClientCommand` override, and (where applicable) as an SDK context method. External consumers want every hook we can imagine.
- **Desktop and iOS are not gatekeepers.** They consume the engine; they do not define its surface. When reviewing engine changes, do not ask "does desktop use this?" — ask "would an external consumer want this?"
