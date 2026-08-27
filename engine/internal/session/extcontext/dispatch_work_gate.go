package extcontext

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// The work gate: enforcement for DispatchAgentOpts.RequireToolUse.
//
// Split from dispatch_agent.go (same package) to keep that file under the
// 800-line cap, matching the rationale in dispatch_child_setup.go and
// dispatch_lifecycle_callbacks.go.
//
// ── The defect this closes ───────────────────────────────────────────────
//
// A dispatched child would read its task, write a paragraph describing the
// work it was about to do ("Got it. I will do exactly this... I'll do it
// now."), end its turn without calling a single tool, and be reported to its
// dispatcher as ExitCode:0 — success. The dispatcher believed the report and
// re-dispatched the same task, repeatedly. Observed in production: seven of
// fourteen recorded completions in one conversation finished in under 15
// seconds, and one agent was dispatched eleven times with a byte-identical
// task, each dispatch carrying a ~51-61 KB system prompt.
//
// Three properties of the engine combined to produce it:
//
//   1. The engine counted the child's tool calls (dispatch_agent.go's
//      toolCount) and discarded the number, so no consumer could tell a
//      working child from a promising one.
//   2. The early-stop continuation gate — the one mechanism that re-prompts a
//      model that stopped too early — is disabled for every dispatched child
//      (IsSubagent, set in dispatch_runopts.go), so nothing asked the child to
//      actually begin.
//   3. Even enabled, that gate ships no continuation text by design
//      (EarlyStopDefaults, types.go), so a consumer that merely flipped it on
//      would get "enabled but no ContinueMessage supplied" and stop anyway.
//
// ── Why this is a mechanism and not a heuristic ───────────────────────────
//
// Zero tool calls does NOT prove a child did no work: "summarize this text"
// and "edit these files" are indistinguishable to the engine, and a
// summarization dispatch that calls nothing has done exactly its job.
// Inferring intent from the task text would be precisely the heuristic that
// AGENTS.md § "Solution quality" forbids.
//
// So the engine does not infer. The DISPATCHER declares the expectation
// (RequireToolUse) because only the caller knows which kind of dispatch it
// issued, and the engine enforces that declaration exactly. Where no
// expectation is declared the engine reports ToolCount as a fact and passes
// no judgement at all.
//
// ── Why the engine supplies continuation text here ────────────────────────
//
// EarlyStopDefaults deliberately ships no message: a continuation spends the
// operator's tokens and pre-empts their choice to accept a stopped run, so the
// engine must never nudge on its own initiative. That reasoning does not apply
// here, and this gate does not change those defaults. The dispatcher asked for
// tool use in this specific dispatch; the nudge fulfils an explicit request
// rather than substituting the engine's opinion for the operator's.

// workGateContinuation is the text handed to a child that declared
// RequireToolUse and ended its first attempt without calling a tool.
//
// It is deliberately specific about the failure mode rather than a generic
// "keep working" nudge: the child does not know it stopped early, and a vague
// prod invites another paragraph of narration. Naming the mistake ("you
// described the work instead of doing it") and the remedy ("call tools now")
// is what converts the retry into work rather than more prose.
const workGateContinuation = "You ended your turn without calling any tools, but this dispatch requires " +
	"tool use to complete. You described the work instead of doing it. " +
	"Begin the work now: call the tools needed to make the actual changes, " +
	"then report what you did. If the task genuinely requires no tool calls, " +
	"say so explicitly and explain why."

// workGateDecision is the outcome of consulting the gate after a child run has
// ended. Exactly one of the three fields is meaningful; the zero value
// ("inert") means the gate has no opinion and the caller proceeds unchanged.
type workGateDecision int

const (
	// workGateInert means no expectation was declared, the child already used
	// tools, or the run did not end cleanly. The gate does nothing.
	workGateInert workGateDecision = iota
	// workGateRetry means the caller should inject the continuation and run
	// the child once more.
	workGateRetry
	// workGateDeclined means the child was already given its continuation and
	// still called no tools. The caller reports ExitCodeDeclined.
	workGateDeclined
)

// workGateState tracks the single retry across runChild's loop iterations.
// One retry, tracked by a bool — no counter, no budget arithmetic, nothing
// that could loop.
type workGateState struct {
	// required is the resolved declaration: true only when the dispatcher
	// explicitly passed RequireToolUse=true.
	required bool
	// continued records that the gate has already spent its one retry.
	continued bool
}

// newWorkGateState resolves the tri-state RequireToolUse into the gate's
// internal form and logs the resolution, so a dispatch that was expected to
// produce work but did not is diagnosable from the log alone — including the
// case where the harness never declared the expectation in the first place.
func newWorkGateState(requireToolUse *bool, agentName, dispatchID, sessionKey string) *workGateState {
	st := &workGateState{}
	declared := "absent"
	switch {
	case requireToolUse == nil:
		// No declaration: the engine reports ToolCount and judges nothing.
	case *requireToolUse:
		st.required = true
		declared = "true"
	default:
		declared = "false"
	}
	utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch work gate resolved", map[string]any{
		"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
		"require_tool_use": declared, "enforced": st.required,
	})
	return st
}

// evaluate decides what the gate does now that a child run has ended.
//
// Both non-inert branches log, and so does every inert branch that had an
// expectation to check, because "the gate declined to act" is exactly as
// important to an operator reading the log as "the gate fired".
func (s *workGateState) evaluate(toolCount int, exitCode int, recalled bool, agentName, dispatchID, sessionKey string) workGateDecision {
	if !s.required {
		return workGateInert
	}

	// A recalled or failed run is not a declined one. The child may have been
	// cancelled mid-thought or crashed before it could call anything, and
	// overwriting that outcome would hide the real reason the dispatch ended.
	if recalled || exitCode != 0 {
		utils.LogWithFields(utils.LevelDebug, "session.extcontext", "dispatch work gate skipped: run did not end cleanly", map[string]any{
			"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
			"tool_count": toolCount, "exit_code": exitCode, "recalled": recalled,
		})
		return workGateInert
	}

	if toolCount > 0 {
		utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch work gate satisfied", map[string]any{
			"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
			"tool_count": toolCount, "continued": s.continued,
		})
		return workGateInert
	}

	if s.continued {
		utils.LogWithFields(utils.LevelWarn, "session.extcontext", "dispatch work gate: declined after continuation", map[string]any{
			"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
			"tool_count": toolCount,
		})
		return workGateDeclined
	}

	utils.LogWithFields(utils.LevelWarn, "session.extcontext", "dispatch work gate: zero tool calls, injecting one continuation", map[string]any{
		"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
		"tool_count": toolCount,
	})
	return workGateRetry
}

// armContinuation mutates runOpts into the gate's retry shape and marks the
// single retry as spent.
//
// The mutations mirror the suspend/revive resume path in dispatch_agent.go for
// the same reason it does: the retry must RESUME the child's own conversation,
// never replay the task from the top. Pinning ConversationID is what makes the
// child see the turn where it promised to work — which is the whole point of
// the continuation, since a replayed task would just produce the same promise
// again. BackgroundWork is cleared because no child result is being delivered.
func (s *workGateState) armContinuation(runOpts *types.RunOptions, childSessionID, agentName, dispatchID, sessionKey string) {
	if childSessionID != "" {
		runOpts.ConversationID = childSessionID
	}
	runOpts.Prompt = workGateContinuation
	runOpts.InjectionKind = string(types.InjectionKindSystemSteer)
	runOpts.BackgroundWork = nil
	s.continued = true

	utils.LogWithFields(utils.LevelInfo, "session.extcontext", "dispatch work gate continuation armed", map[string]any{
		"model": agentName, "run_id": dispatchID, "session_id": sessionKey,
		"conversation_id": runOpts.ConversationID, "prompt_len": len(runOpts.Prompt),
	})
}

// declinedOutput composes the output text for a declined dispatch.
//
// The child's own final text is preserved verbatim after the engine's verdict:
// the dispatcher needs to see WHAT the child said it would do in order to
// decide whether to re-dispatch with a sharper task, hand the work elsewhere,
// or do it directly. Discarding it would leave the orchestrator with a bare
// refusal and no material to act on.
func declinedOutput(agentName, childText string) string {
	msg := fmt.Sprintf("Agent %q declared required tool use but completed without calling any tools, "+
		"both on its first attempt and after one explicit continuation. "+
		"No work was performed by this dispatch.", agentName)
	if childText != "" {
		return msg + "\n\nThe agent's final response was:\n" + childText
	}
	return msg
}
