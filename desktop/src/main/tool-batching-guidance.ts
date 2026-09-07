/**
 * System-prompt addendum injected into every LLM call from this desktop
 * harness. Tells the model to spend turns economically when it edits code.
 *
 * The problem it corrects
 * ──────────────────────
 * A model with no instruction on the subject defaults to one tool call per
 * assistant message. That default is invisible on a read-only task and
 * ruinous on an editing task: every call costs a full round trip, and the
 * round trip is priced by the whole conversation, not by the size of the
 * edit. Rewriting one file through a dozen three-line edits therefore costs
 * a dozen prefills over the entire context to produce a few dozen lines.
 * The same file rewritten as one region replacement, or as a dozen edits
 * issued together in one message, costs one.
 *
 * The addendum states two things the model cannot observe for itself: that
 * a turn is the unit of cost, and that re-reading a file it just edited
 * buys nothing, because the edit result already reports what was written.
 *
 * Layer
 * ─────
 * Harness, per `CLAUDE.md` → "Engine executes, harness decides." How to
 * write code is an opinion, and opinions are not the engine's to hold. The
 * engine knows nothing about this string; it rides the generic wire field
 * `ClientCommand.AppendSystemPrompt`, which exists for exactly this kind of
 * consumer-owned prose.
 *
 * Cacheability
 * ────────────
 * The string is a top-level `const` so it is byte-identical across sessions
 * and turns, which keeps it inside the prompt-cache prefix and free after
 * the first cache write. Do not turn it into a function or a template — any
 * per-turn variability would move it outside the prefix and bill it on
 * every call.
 */
export const TOOL_BATCHING_GUIDANCE = `Independent tool calls belong in one message. When the next calls do not depend on each other's results — reading several files, searching several patterns, editing several separate places — issue them together in a single response instead of one per turn. A turn is the unit of cost, and it is priced by the whole conversation rather than by the size of the call, so ten one-line edits sent one at a time cost ten times what the same ten edits cost sent together.

Edit at the altitude of the change. When a change spans several lines or several hunks of one file, replace the whole region in a single edit rather than walking it line by line, and send that file's remaining hunks in the same message. Re-read a file only when something other than your own edit could have changed it — an edit that reports success already tells you what the file now contains.`
