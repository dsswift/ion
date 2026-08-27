package backend

// Human-wait client-tool PARK — the runloop interception for tools declared
// with ClientToolDef.HumanWait (AskUserQuestions and any future structured
// human-wait tool). Extracted from runloop_tools.go for the file-size cap.

import (
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// parkHumanWaitClientTool parks the run on a human-wait client-tool call —
// the structured sibling of the AskUserQuestion sentinel, with identical
// semantics: record a PermissionDenial carrying the full input, inject a
// placeholder result, and terminate the run. The session reports idle, the
// engine retains the denial across heartbeats/reconciles/restarts, and the
// client's submitted answers arrive as the next prompt. Deliberately NOT a
// blocking wire round-trip: a live tool call cannot survive an engine
// restart or let the user answer at their own pace, and "stop" would kill
// the question — parking makes the wait stateless.
//
// Returns true when the block was a human-wait tool and the run parked; the
// caller returns immediately (the parkedHumanWait flag wraps the run up in
// runloop_stop_reason.go, under its own result text — never plan mode's).
func (b *ApiBackend) parkHumanWaitClientTool(
	run *activeRun,
	block types.LlmContentBlock,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if run.cfg == nil || !run.cfg.HumanWaitClientTools[block.Name] {
		return false
	}
	utils.LogWithFields(utils.LevelInfo, "backend.runloop", "human-wait client tool parked run", map[string]any{
		"run_id": run.requestID,
		"tool":   block.Name,
	})
	run.mu.Lock()
	run.parkedHumanWait = true
	run.permissionDenials = append(run.permissionDenials, types.PermissionDenial{
		ToolName:  block.Name,
		ToolUseID: block.ID,
		ToolInput: block.Input,
	})
	run.mu.Unlock()
	const parked = "Questions sent to user. The run ends here; the user's answers will arrive as the next message."
	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   parked,
		IsError:   false,
	}
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: parked,
		IsError: false,
	}})
	return true
}

// refuseSiblingsOfHumanWait enforces the terminal-handoff contract when a
// human-wait tool shares its turn with other tool calls.
//
// Returns true when it handled the turn: the question is parked, every
// sibling has a refusal result, and the caller must not start any tool
// goroutine. Returns false for the ordinary case (no human-wait call, or a
// human-wait call alone), leaving execution untouched.
func (b *ApiBackend) refuseSiblingsOfHumanWait(
	run *activeRun,
	toolUseBlocks []types.LlmContentBlock,
	results []conversation.ToolResultEntry,
) bool {
	// A human-wait tool ENDS the turn, so nothing else in that turn may run.
	//
	// The model calling AskUserQuestions is handing control to a person: the
	// run parks, the session goes idle, and the conversation resumes only
	// when the operator answers. Any sibling tool call in the same response
	// is therefore work the model scheduled for a turn that is already over —
	// and because tool calls execute in PARALLEL here, those siblings would
	// otherwise race the park, land real side effects (writes, commands,
	// dispatches) after the run is terminal, and have their results silently
	// discarded. Worse, a model that pairs the question with more work reads
	// its own turn as "still going" and does not re-issue the call, which is
	// how a requested continuation page went missing while the operator's
	// submitted answers sat waiting for it.
	//
	// This mirrors ExitPlanMode's contract — the call is a terminal handoff,
	// not one step among several — and enforces it in the engine rather than
	// trusting every model to observe it. The refusal is a tool RESULT, not
	// an error: the model sees exactly why the sibling did not run and can
	// re-issue it in the turn that follows the operator's answer.
	parkIdx := -1
	if run.cfg != nil && len(run.cfg.HumanWaitClientTools) > 0 {
		for i, block := range toolUseBlocks {
			if run.cfg.HumanWaitClientTools[block.Name] && clientToolCallIsValid(run, block) {
				parkIdx = i
				break
			}
		}
	}
	if parkIdx >= 0 && len(toolUseBlocks) > 1 {
		siblings := make([]string, 0, len(toolUseBlocks)-1)
		for i, block := range toolUseBlocks {
			if i == parkIdx {
				continue
			}
			// An invalid client-tool call keeps its own error result. It is not
			// converted into a sibling refusal merely because another valid
			// human-wait call parks this turn.
			if b.validateClientToolCall(run, block, results, i) {
				continue
			}
			siblings = append(siblings, block.Name)
			const refusal = "Not executed: this turn also called a tool that hands control to the user, " +
				"which ends the turn. Re-issue this call after the user answers."
			results[i] = conversation.ToolResultEntry{
				ToolUseID: block.ID,
				Content:   refusal,
				IsError:   false,
			}
			b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
				ToolID:  block.ID,
				Content: refusal,
				IsError: false,
			}})
		}
		utils.LogWithFields(utils.LevelWarn, "backend.runloop", "human-wait tool shares its turn; sibling tool calls refused", map[string]any{
			"run_id":   run.requestID,
			"tool":     toolUseBlocks[parkIdx].Name,
			"siblings": siblings,
		})
		// Park now and skip execution entirely: no sibling goroutine starts,
		// so no side effect can land after the run is terminal.
		b.parkHumanWaitClientTool(run, toolUseBlocks[parkIdx], results, parkIdx)
		return true
	}
	return false
}
