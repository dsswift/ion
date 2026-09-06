package backend

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// claude_code_turn_seal.go — enforcement for the two engine-owned tools whose
// contract is "this turn is over".
//
// ExitPlanMode and the question tools (AskUserQuestion / AskUserQuestions) both
// hand control back to the operator: a plan awaits approval, or a question
// awaits an answer. Their MCP handlers acknowledge the call with prose telling
// the model to stop, and the engine latches the signal from the assistant
// stream (sawExitPlanMode / pendingQuestionDenials).
//
// Prose is not enforcement. A model that keeps going after presenting its plan
// runs headlong into the plan-mode tool revocation: Write, Edit, and Bash are
// stripped from a plan-mode spawn via --disallowedTools, so every subsequent
// call returns "No such tool available: <tool>. <tool> is disabled for this
// session". The CLI answers each one and lets the model try again, so the run
// burns turns and tokens on refusals until it exhausts its own limit — with a
// transcript full of failed tool calls the operator reads as a broken engine.
//
// The engine owns the turn boundary, so the engine enforces it: once a
// turn-ending tool is observed in the stream, the run is sealed and the
// subprocess is stopped. The already-captured plan or question rides out on the
// result event exactly as before, and no revoked-tool refusal is ever produced.
//
// Sealing is deliberately NOT "cancel the run": the plan and question payloads
// are captured from the assistant stream before this point, and the CLI's own
// result event still needs to arrive so cost, session id, and the retained
// denials land on it. Cancel() is the operator's abort path; this is a
// cooperative stop that lets the current message finish and blocks the next
// provider round trip.

// turnEndingToolObserved reports whether this run has seen a tool whose
// contract ends the turn. Both signals are latched by the stream scanners that
// run before this check: handlePlanModeAssistant sets sawExitPlanMode, and
// handleQuestionAssistant appends to pendingQuestionDenials.
func turnEndingToolObserved(run *claudeCodeRun) bool {
	if run == nil {
		return false
	}
	return run.sawExitPlanMode || len(run.pendingQuestionDenials) > 0
}

// sealTurnAfterTerminalTool stops a delegated claude-code subprocess once a
// turn-ending tool has been observed. It is idempotent: the stream scanners run
// per assistant message, so this may be reached several times for one run, and
// only the first call signals the process.
//
// The returned bool reports whether this call performed the seal, so the caller
// can log the transition exactly once.
func (b *ClaudeCodeBackend) sealTurnAfterTerminalTool(run *claudeCodeRun, reason string) bool {
	if !turnEndingToolObserved(run) {
		return false
	}
	if run.turnSealed {
		return false
	}
	run.turnSealed = true

	utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "turn-ending tool observed; sealing run so the model cannot call revoked tools", map[string]any{
		"run_id":           run.requestID,
		"reason":           reason,
		"saw_exit_plan":    run.sawExitPlanMode,
		"question_denials": len(run.pendingQuestionDenials),
		"plan_mode":        run.planMode,
	})

	// Close stdin so the CLI cannot be handed another turn. The process
	// finishes emitting its current message and its result event, which is
	// what carries the captured plan / question denials downstream.
	run.stdinMu.Lock()
	pipe := run.stdinPipe
	run.stdinPipe = nil
	run.stdinMu.Unlock()

	if pipe == nil {
		utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "turn seal: stdin already closed", map[string]any{
			"run_id": run.requestID,
		})
		return true
	}
	if err := pipe.Close(); err != nil {
		// Non-fatal: the process may already be tearing down on its own. The
		// seal flag still holds, so no further turn is fed to this run.
		utils.LogWithFields(utils.LevelInfo, "backend.claude_code", "turn seal: closing stdin failed (process likely exiting)", map[string]any{
			"run_id": run.requestID,
			"error":  utils.ErrStr(err),
		})
		return true
	}
	utils.LogWithFields(utils.LevelDebug, "backend.claude_code", "turn seal: stdin closed", map[string]any{
		"run_id": run.requestID,
	})
	return true
}
