package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// gitContextMessagePreamble introduces the git block so the model reads it as
// ambient repository state for the current turn rather than as user intent.
const gitContextMessagePreamble = "<system-reminder>Current repository state for this turn:\n\n"

const gitContextMessageSuffix = "\n</system-reminder>"

// AppendGitContextMessage returns msgs with the run's git context appended as a
// trailing ephemeral user message, or msgs unchanged when the run carries no
// git context.
//
// # Why this is appended instead of living in the system prompt
//
// Git context is the most volatile context the engine injects: branch, short
// status, and recent commits all change as the operator works. It used to be
// appended to the system prompt, which is where providers anchor the cacheable
// prefix. A prompt cache is a prefix match, so volatile bytes inside the prefix
// invalidate everything behind them — the entire system prompt AND the whole
// conversation history. In a long engine-development conversation that meant a
// ~100-token git block was forcing a re-write of hundreds of thousands of
// cached tokens on any turn that followed a commit, at cache-write rates rather
// than cache-read rates.
//
// Appending after the history inverts the arithmetic. Anthropic's cache
// breakpoints sit on the system prompt and on the last few user messages
// (see providers.formatMessages); everything the engine emits past the final
// breakpoint is outside the cached prefix, so a changed branch or a new commit
// re-sends only the git block. The model still receives the same facts on every
// turn, and recency works in its favour — trailing content carries more
// attention weight than a block buried at the end of a long system prompt.
//
// The message is provider-view only. It is never added to conv.Messages, never
// persisted to the tree, and never replayed on reload: the run loop rebuilds it
// from RunOptions on every turn, so history stays clean and no stale repository
// state can survive into a later turn.
func AppendGitContextMessage(msgs []types.LlmMessage, opts types.RunOptions, runID string, turn int) []types.LlmMessage {
	if opts.GitContextText == "" {
		utils.LogWithFields(utils.LevelDebug, "backend.runloop", "git context message skipped: none resolved for run", map[string]any{
			"run_id": runID,
			"turn":   turn,
		})
		return msgs
	}

	text := gitContextMessagePreamble + opts.GitContextText + gitContextMessageSuffix
	out := make([]types.LlmMessage, 0, len(msgs)+1)
	out = append(out, msgs...)
	out = append(out, types.LlmMessage{
		Role:      "user",
		Content:   []types.LlmContentBlock{{Type: "text", Text: text}},
		Transient: true,
	})

	utils.LogWithFields(utils.LevelDebug, "backend.runloop", "git context appended after cache breakpoints", map[string]any{
		"run_id": runID,
		"turn":   turn,
		"count":  len(text),
	})
	return out
}
