/**
 * System-prompt addendum injected into every LLM call from this desktop
 * harness. Compensates for the fact that desktop and iOS render tool
 * calls separately from the surrounding assistant text:
 *
 *   - Unified turn view (`unifiedTurnView=true`, default on) groups all
 *     tool calls *above* the assistant message text within a turn.
 *   - Flat view (`unifiedTurnView=false`) interleaves tool calls and
 *     text chronologically — but a colon at the end of a sentence still
 *     doesn't reliably "point at the next thing" because the next
 *     visible element might be more text, a system message, a
 *     permission card, or a different tool call.
 *
 * In neither mode is the model's trailing-colon "look at what comes
 * next" framing correct. The guidance below tells the model the truth
 * about how its output is rendered, so it writes sentences that hold
 * up regardless of visual placement.
 *
 * Layer
 * ─────
 * Harness, per `CLAUDE.md` → "Engine executes, harness decides." The
 * engine knows nothing about this string; it arrives via the wire
 * field `ClientCommand.AppendSystemPrompt` and is appended to the
 * system block of each LLM call. No engine change is needed for this
 * feature — the plumbing has been in place since the protocol shipped.
 *
 * Cacheability
 * ────────────
 * The string is a top-level `const` so it is byte-identical across
 * sessions and turns. That means it sits inside the prompt-cache
 * prefix and adds ~zero per-turn token cost after the first cache
 * write. Do not turn this into a function or templated string — any
 * variability would break the cache invariant and turn a free
 * addendum into a per-turn billed addendum.
 *
 * Source-of-truth
 * ───────────────
 * This constant is injected from exactly one place: the prompt pipeline's
 * addenda list, applied at its converging dispatch point so every prompt
 * origin (desktop renderer + iOS CLI/engine, slash + non-slash) receives
 * it once. Do not add a second injection site. The pipeline's append is
 * idempotent, so a duplicate site would not visibly break anything — it
 * would just make "where does this text come from" unanswerable.
 */
export const TURN_GROUPING_GUIDANCE = `Tool calls are rendered below your response text, not above it. Write your reply as a complete thought. Do not end sentences with colons to introduce tool output — the tool cluster appears after your words, so lead-in phrases like "here's what I did:" are misleading. End sentences with normal punctuation unless prefacing a list that is genuinely written out in the text.`
