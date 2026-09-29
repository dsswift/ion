---
title: "ADR-036: Thin clients render the server's transcript"
description: The server store's rows are the one transcript; a thin client applies revisioned patches to them and builds no rows of its own.
---

# ADR-036: Thin clients render the server's transcript

## Status

Accepted. Refines [ADR-035](035-one-wire.md), which gave the phone a thin view of the Studio wire in which the server "builds transcript rows out of engine tool events" and "batches text deltas". That derivation is replaced by the one below.

## Context

Studio and iOS both talked to the same server and did not show the same conversation.

- **Studio** asked `studio_body_request` and got the server store's own rows. It kept them live by running the server's own reducer over `ion:normalized-event`. Same code, same input: it could not disagree with the server.
- **iOS** asked the same `studio_body_request` and got a different answer: the engine's history re-mapped for the phone. That mapping folded harness and thinking rows into system rows and cut tool output with an in-band `... [truncated]` string. The phone then rebuilt the live transcript with its own Swift reducer over relabeled `desktop_*` events, merged history pages into it by id, and compared a fingerprint of its last ten rows against the server's to guess when it had drifted.

Two builders fed from two sources will drift, and nothing proves when they have. A sentence dropped between two streamed deltas left the phone's row short with nothing to say so; the fingerprint only saw the tail, only on a poll tick, and only healed by reloading the whole conversation. Every phone history bug of the preceding months sat on a seam between the two builders. Dispatched agents had the same split a second time: Studio's agent panel merged the conversation file with the dispatch's live activity, and the phone kept its own activity cache with a 12-second poll.

## Decision

**The server store's rows are the one transcript.** A conversation instance's `messages` in the server store are what Studio renders. A thin client renders the same rows, projected once for the wire as `TranscriptRow`s (`packages/shared/src/transcript/transcript-row.ts`). The projection drops owner-only reducer state and flags cut tool output (`contentTruncated`, `contentBytes`); it derives, renames, and reorders nothing. A field added to `Message` fails the typecheck until it is classified as wire or owner-only.

**A transcript is a stream: a snapshot, then revisioned patches.** A thin `studio_body` reply carries the rows plus `streamId`, `epoch`, `rev`, `total`, and `startIndex`. Every later change is one `desktop_transcript_patch` (`packages/shared/src/transcript/transcript-patch.ts`): an `append` of a streamed suffix to one row, a minimal `splice`, or a `reset` when the change is too large for one frame. Each patch names the revision it applies to. A client that holds a different revision missed something, knows it, and fetches the newest page again. There is no fingerprint and no merge: a missing revision is the proof, and the fix is always the same reload. The publisher (`server/src/transcript/transcript-publisher.ts`) coalesces a burst of store changes into one patch per flush window.

**Dispatched agents use the same stream.** The server computes exactly the rows Studio's agent panel shows, `projectTranscript(mergeDispatchTranscript(mapConversationMessages(file), activity))`, with the same shared functions (`server/src/transcript/dispatch-transcript-publisher.ts`). It reads the conversation file again when a tool finishes, when the dispatch stops, and on a backstop while it runs. Every earlier dispatch and every nesting level stays reviewable: each is a stream keyed `dispatch:<conversationId>:<dispatchId>`. A tab may read only the dispatches it owns.

**The phone builds nothing.** Its only local row is the pending bubble of a prompt it sent. The server stamps that prompt's `clientMsgId` on the row it makes, and sends the row's patch before the prompt's result, so the bubble is replaced by the real row rather than guessed against it.

**What the phone no longer receives.** Every engine event whose only effect on a client is a row is kept off the thin wire (`TRANSCRIPT_ONLY_ENGINE_EVENTS` in `server/src/engine/event-wiring-mobile-filter.ts`). The phone-only history page, the user-turn echo to the phone, the text-delta batcher, the tail fingerprint, the `clientMsgId` side map, and the per-dispatch activity and history events were deleted, with the Swift code that consumed them.

**Studio is unchanged.** Its body sync, its live reducer, and its agent panel work as before. The one Studio-side change is that the dispatch mapper moved to `packages/shared/src/transcript/` so the server can run the same code.

## Consequences

The phone matches Studio by construction, not by review. The same functions run on the same rows, and a golden replay fixture pins it across languages: the server test drives the real store through a recorded event sequence and writes the snapshot, every patch, and the final rows to `packages/shared/src/transcript/__fixtures__/transcript-replay.json`. The iOS test replays that file and asserts its rows equal the server's field by field.

A lost patch costs one page reload, logged with its reason, instead of a silently wrong transcript.

`streamThinkingToRemote` now applies to the transcript itself: with it off, a thinking row ships with its summary and without its text, and changing the setting re-publishes every open stream.

## References

- [Studio wire protocol](../../protocol/studio-wire.md) § "Transcript streams"
- [ADR-035: One wire](035-one-wire.md)
- [ADR-033: Ion Studio Server and Environments](033-ion-studio-server-and-environments.md)
- [Cross-Platform Parity](../cross-platform-parity.md)
