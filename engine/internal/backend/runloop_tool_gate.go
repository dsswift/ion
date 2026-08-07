package backend

// Client tool-gate enforcement in the tool loop.
//
// The gate is the client-owned counterpart to the permission engine and the
// workspace checker (see types/tool_gate.go for the full framing). This file
// owns the loop-side half: invoke the session-wired callback, and when the
// verdict is deny, record a tool result the model can act on. The wait,
// timeout, and wire round-trip all live behind RunHooks.OnToolGate — the loop
// only sees a synchronous (decision, reason) answer.

import (
	"context"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// siblingToolNames returns the names of every tool call in the turn other
// than the one at index i. Turn-mates run concurrently, so a gate policy
// that requires an operation to run alone needs this list.
func siblingToolNames(blocks []types.LlmContentBlock, i int) []string {
	if len(blocks) <= 1 {
		return nil
	}
	names := make([]string, 0, len(blocks)-1)
	for j, b := range blocks {
		if j != i {
			names = append(names, b.Name)
		}
	}
	return names
}

// checkToolGate consults the client gate for one tool call. Returns true when
// the call was denied and its result recorded — the caller stops processing
// that tool. A nil callback (session did not opt in) passes everything.
//
// siblings names the OTHER tool calls in the same model turn, so a policy
// that requires an operation to run alone can evaluate turn isolation.
//
// Runs after the permission engine and workspace containment (their refusals
// preempt the client round-trip) and before sandbox wrapping and extension
// tool_call hooks (the session owner's refusal preempts extension processing).
func (b *ApiBackend) checkToolGate(
	gCtx context.Context,
	run *activeRun,
	gateFn func(string, map[string]interface{}, string, []string) (string, string),
	block types.LlmContentBlock,
	cwd string,
	siblings []string,
	permDenyFn func(runID string, info interface{}),
	telem TelemetryCollector,
	results []conversation.ToolResultEntry,
	i int,
) bool {
	if gateFn == nil {
		return false
	}

	type gateRet struct {
		decision string
		reason   string
	}
	ret, hookErr := runHookCtx(gCtx, func() gateRet {
		d, r := gateFn(block.Name, block.Input, cwd, siblings)
		return gateRet{d, r}
	})
	if hookErr != nil {
		// The run context is gone; the errgroup surfaces it. Nothing to
		// record — the whole run is being torn down.
		utils.LogWithFields(utils.LevelInfo, "backend.toolgate", "tool gate abandoned: run context done", map[string]any{
			"tool":   block.Name,
			"run_id": run.requestID,
		})
		return false
	}
	if ret.decision != types.GateDecisionDeny {
		return false
	}

	reason := ret.reason
	if reason == "" {
		reason = "denied by the session's client tool gate"
	}
	utils.LogWithFields(utils.LevelInfo, "backend.toolgate", "tool call denied by client gate", map[string]any{
		"tool":   block.Name,
		"cwd":    cwd,
		"run_id": run.requestID,
		"reason": reason,
	})

	// Same observability contract as a permission deny and a workspace
	// refusal: the permission_denied hook fires so extensions and telemetry
	// see the denial without a new hook surface, and the tool result carries
	// the client's reason verbatim so the model can act on it.
	if permDenyFn != nil {
		if _, denyErr := runHookCtx(gCtx, func() struct{} {
			permDenyFn(run.requestID, map[string]interface{}{
				"tool_name": block.Name,
				"input":     block.Input,
				"reason":    reason,
			})
			return struct{}{}
		}); denyErr != nil {
			utils.LogWithFields(utils.LevelInfo, "backend.toolgate", "permission_denied hook abandoned: run context done", map[string]any{
				"tool":   block.Name,
				"run_id": run.requestID,
			})
		}
	}

	results[i] = conversation.ToolResultEntry{
		ToolUseID: block.ID,
		Content:   "Blocked: " + reason,
		IsError:   true,
	}
	emitToolFailure(telem, run, toolFailureBlock{Name: block.Name, ID: block.ID}, "client_gate_denied", reason)
	b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{
		ToolID:  block.ID,
		Content: results[i].Content,
		IsError: true,
	}})
	return true
}
