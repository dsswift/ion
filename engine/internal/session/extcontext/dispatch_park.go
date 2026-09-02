package extcontext

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// buildReviveResumePrompt composes the user-turn prompt a parked dispatch is
// revived with. The revived run RESUMES the dispatch's own conversation (the
// original task and all pre-park work are already in history), so the prompt
// carries only what is new: the awaited children's terminal results. Without
// this, a revived parent was restarted with its original task in a fresh
// conversation and replayed the whole job from the top (root cause K, the
// 1785418884327 incident).
//
// Zero drained results still produces a meaningful wake message — the parent
// may have been revived by a bare-suspend sendPrompt or a race where its
// child's result was consumed elsewhere; it should reassess rather than
// replay.
// reviveInjectionKind classifies a parked-dispatch wake at source so the
// backend persists the same provenance across live and historical paths.
func reviveInjectionKind(results []ChildResultRecord) string {
	if len(results) == 0 {
		return string(types.InjectionKindRevive)
	}
	return string(types.InjectionKindAgentCompletion)
}

func buildReviveResumePrompt(results []ChildResultRecord) string {
	if len(results) == 0 {
		return "[SYSTEM] You have been revived from a parked state. The work you were waiting on has settled, but no child results were recorded — check your dispatch state (or the conversation above) and continue from where you left off. Do NOT restart the task from the beginning; your earlier work is in this conversation."
	}

	var b strings.Builder
	if len(results) == 1 {
		b.WriteString("[SYSTEM] Your dispatched agent has completed. Its result is below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n")
	} else {
		fmt.Fprintf(&b, "[SYSTEM] All %d dispatched agents you were waiting on have completed. Their results are below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n", len(results))
	}
	for _, r := range results {
		var status string
		switch r.ExitCode {
		case 0:
			status = "completed"
		case ExitCodeRecalled:
			status = "recalled (cancelled)"
		default:
			status = fmt.Sprintf("FAILED (exit %d)", r.ExitCode)
		}
		fmt.Fprintf(&b, "\n--- [%s] %s (dispatch %s) ---\n%s\n", r.Name, status, r.ChildID, r.Output)
	}
	return b.String()
}

// buildPollReviveResumePrompt renders the poll verdicts a dispatch was parked
// on, so the revived agent is told what its poll decided.
//
// Without this the poll path signalled revive and carried nothing: the agent
// resumed, drained an empty child-result set, and received the generic "no
// child results were recorded" prompt. It then reported that no terminal
// verdict ever arrived -- correctly -- while the engine's delivery log line
// said "delivered". The verdict has to travel with the wake, not just cause it.
func buildPollReviveResumePrompt(results []PollResultRecord) string {
	var b strings.Builder
	if len(results) == 1 {
		b.WriteString("[SYSTEM] The Poll you were waiting on has returned its terminal verdict, below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n")
	} else {
		fmt.Fprintf(&b, "[SYSTEM] All %d Polls you were waiting on have returned terminal verdicts, below. Continue your task from where you parked — your earlier work is in this conversation; do NOT restart from the beginning.\n", len(results))
	}
	for _, r := range results {
		fmt.Fprintf(&b, "\n--- Poll %s: %s ---\n%s\n", r.PollID, r.Verdict, r.Evidence)
	}
	return b.String()
}
