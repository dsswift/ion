package extcontext

// dispatch_terminal_outcome.go — assembles the asynchronous terminal callback
// payloads (DispatchError, RecallInfo) from the one terminal
// DispatchAgentResult, so every outcome type for a dispatch carries the same
// identity fields, including the child conversation ID.

import "github.com/dsswift/ion/engine/internal/extension"

// terminalDispatchError builds the OnError payload from a terminal result.
func terminalDispatchError(result extension.DispatchAgentResult) extension.DispatchError {
	return extension.DispatchError{
		Name:                result.Name,
		DispatchID:          result.DispatchID,
		Message:             result.Output,
		ExitCode:            result.ExitCode,
		Elapsed:             result.Elapsed,
		ChildConversationID: result.ChildConversationID,
	}
}

// terminalRecallInfo builds the OnRecall payload from a terminal result.
// reason is the recall reason; the result's Output is the parent-facing
// "recalled: <reason>" summary, not the reason itself.
func terminalRecallInfo(result extension.DispatchAgentResult, reason string) extension.RecallInfo {
	return extension.RecallInfo{
		Name:                result.Name,
		DispatchID:          result.DispatchID,
		Reason:              reason,
		Elapsed:             result.Elapsed,
		ToolCount:           result.ToolCount,
		ChildConversationID: result.ChildConversationID,
	}
}
