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
// OnSystemInject hook. Recognized kinds: "turn_limit_warning",
// "max_token_continue", "nested_context", and the early-stop continuation
// kind. An unrecognized kind is always injected (no disable gate) — callers
// own that contract. Plan-mode notices do not come through here; see
// reconcilePlanMode.
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
	transient := opts.SuppressSystemMessages
	if transient {
		conversation.AddTransientUserMessage(conv, text)
	} else {
		// Classify as InjectionKindSystemSteer, not plain AddUserMessage: this
		// is exactly the "engine- or harness-authored steering message ...
		// a turn-limit warning, a max-token continuation" the kind's doc
		// comment describes (injection_kind.go). AddUserMessage leaves the
		// persisted entry with no InjectionKind/MachineAuthored classification,
		// so desktop's and iOS's suppression policies (which both key off that
		// flag) cannot tell this turn apart from one the operator typed — it
		// reappears as an ordinary user bubble on every history reload even
		// though the live event path is unaffected by the operator.
		conversation.AddUserMessageWithKind(conv, text, string(types.InjectionKindSystemSteer))
		if err := conversation.Save(conv, ""); err != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "failed to save conversation after system inject", map[string]any{
				"error": utils.ErrStr(err),
			})
		}
	}
}
