package backend

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// interceptAskUserQuestion handles the AskUserQuestion sentinel, available in
// all runs, not just plan mode. It records a PermissionDenial so consumers can
// surface the question, then terminates the run; the user's answer arrives as
// the next prompt in the same session. A dispatched child routes the question
// to its dispatcher instead and continues. It reports true when the call was
// AskUserQuestion and its result is recorded.
func (b *ApiBackend) interceptAskUserQuestion(run *activeRun, block types.LlmContentBlock, results []conversation.ToolResultEntry, i int) bool {
	if block.Name != tools.AskUserQuestionName {
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user", map[string]any{
		"run_id":   run.requestID,
		"question": block.Input["question"],
	})

	// If this run has a ChildElicitFn, it is a dispatched child.
	// Route the question to the dispatcher via elicitation (blocks
	// until answered). This is the "AskUserQuestion symmetrization":
	// dispatched children block-and-resume like elicitations instead
	// of terminating the run.
	if run.cfg != nil && run.cfg.ChildElicitFn != nil {
		question, _ := block.Input["question"].(string) //nolint:errcheck // missing arg -> empty string
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user routing to dispatcher via ChildElicitFn", map[string]any{
			"run_id": run.requestID,
		})
		answer, cancelled, err := run.cfg.ChildElicitFn(question)
		if err != nil || cancelled {
			// Dispatcher couldn't answer (session torn down or
			// cancelled). Terminate the child run via the standard
			// PermissionDenial path so consumers see a uniform
			// outcome.
			utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user dispatcher unavailable ; terminating", map[string]any{
				"run_id":    run.requestID,
				"cancelled": cancelled,
				"error":     utils.ErrStr(err),
			})
			run.mu.Lock()
			run.exitPlanMode = true
			run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
				ToolName:  block.Name,
				ToolUseID: block.ID,
				ToolInput: block.Input,
			})
			run.mu.Unlock()
			results[i] = conversation.ToolResultEntry{
				ToolUseID: block.ID,
				Content:   "Question could not be answered (dispatcher unavailable). Proceeding with best judgment.",
				IsError:   false,
			}
			b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: "Question could not be answered (dispatcher unavailable). Proceeding with best judgment.",
				IsError: false,
			}})
			return true
		}
		// Dispatcher answered. Inject the answer as the tool result.
		// The child run CONTINUES (no PermissionDenial, no terminate).
		content := answer
		if content == "" {
			content = "(no answer provided — proceed with best judgment)"
		}
		utils.LogWithFields(utils.LevelInfo, "backend.runloop", "ask_user dispatcher answered; injecting result and continuing", map[string]any{
			"run_id": run.requestID,
		})
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   content,
			IsError:   false,
		}
		b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
			ToolID:  block.ID,
			Content: content,
			IsError: false,
		}})
		return true
	}

	// Standard path: record a PermissionDenial so consumers can
	// surface the question, then terminate the run. The user's
	// answer arrives as the next prompt in the same session.
	run.mu.Lock()
	run.exitPlanMode = true
	run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
		ToolName:  block.Name,
		ToolUseID: block.ID,
		ToolInput: block.Input,
	})
	run.mu.Unlock()
	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   "Question sent to user. Awaiting response.",
		IsError:   false,
	}
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: "Question sent to user. Awaiting response.",
		IsError: false,
	}})
	return true
}
