package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// injectSystemMessage handles all engine-injected steering messages.
// It checks disable flags, fires the system_inject hook, and either
// adds a transient message (suppress mode) or persists it normally.
//
// kind selects the per-injection disable flag and is the value passed to the
// OnSystemInject hook. Recognized kinds: "plan_mode_reminder",
// "turn_limit_warning", "max_token_continue", "nested_context", and the
// early-stop continuation kind. An unrecognized kind is always injected
// (no disable gate) — callers own that contract.
func (b *ApiBackend) injectSystemMessage(
	run *activeRun,
	conv *conversation.Conversation,
	hooks RunHooks,
	opts types.RunOptions,
	kind, defaultText string,
	turn, maxTurns int,
) {
	// Check per-injection disable flag
	switch kind {
	case "plan_mode_reminder":
		if opts.DisablePlanModeReminder {
			return
		}
	case "turn_limit_warning":
		if opts.DisableTurnLimitWarning {
			return
		}
	case "max_token_continue":
		if opts.DisableMaxTokenContinue {
			return
		}
	case "nested_context":
		if opts.DisableNestedContext {
			return
		}
	case earlyStopContinueKind:
		if opts.DisableEarlyStopContinue {
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "earlyStop: injection suppressed by DisableEarlyStopContinue", map[string]any{
				"run_id": run.requestID,
				"turn":   turn,
			})
			return
		}
	}

	// Fire hook if registered
	text := defaultText
	if hooks.OnSystemInject != nil {
		hookText, suppress := hooks.OnSystemInject(kind, defaultText, turn, maxTurns)
		if suppress {
			return
		}
		if hookText != "" {
			text = hookText
		}
	}

	// Add message: transient (in-memory only) or persistent.
	//
	// plan_mode_reminder is ALWAYS transient regardless of SuppressSystemMessages:
	// a "plan mode still active" claim is only true for the turn it is injected
	// and becomes a lie the moment the mode changes. Persisting it (as the old
	// code did) causes the model to read stale mode-claims in later turns after
	// a mode transition, and bloats the conversation history with identical
	// copies. Other kinds (turn_limit_warning, max_token_continue, nested_context,
	// early-stop) are legitimately part of history and keep the existing
	// persist-on-default path.
	transient := opts.SuppressSystemMessages || kind == "plan_mode_reminder"
	if transient {
		conversation.AddTransientUserMessage(conv, text)
	} else {
		conversation.AddUserMessage(conv, text)
		if err := conversation.Save(conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after system inject", map[string]any{
				"error": utils.ErrStr(err),
			})
		}
	}
}
