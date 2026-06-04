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
 * The single injection site is
 * `desktop/src/main/prompt-pipeline.ts::submitAsPrompt`, the lone
 * converging dispatch point for every prompt origin (desktop
 * renderer + iOS CLI/engine, slash + non-slash). Do not add a second
 * injection site — the helper handles idempotency by `endsWith()`,
 * but the right architectural answer is "one append, one place."
 */
export const TURN_GROUPING_GUIDANCE = `Tool calls are not rendered inline to the user. Do not use colons as line endings to present tool calls — the user will not see them appear "below" the text. End sentences with normal punctuation unless prefacing a list that is genuinely written out in the text.`
