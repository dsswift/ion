package backend

import (
	"fmt"

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
			utils.Debug("ApiBackend", fmt.Sprintf(
				"earlyStop: injection suppressed by DisableEarlyStopContinue: runID=%s turn=%d",
				run.requestID, turn,
			))
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

	// Add message: transient (in-memory only) or persistent
	if opts.SuppressSystemMessages {
		conversation.AddTransientUserMessage(conv, text)
	} else {
		conversation.AddUserMessage(conv, text)
		if err := conversation.Save(conv, ""); err != nil {
			utils.Log("ApiBackend", "failed to save conversation after system inject: "+err.Error())
		}
	}
}
