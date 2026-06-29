package extcontext

import (
	"fmt"
	"runtime/debug"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// recoverBackgroundDispatchPanic is the safety backstop for the
// background-dispatch goroutine in BuildDispatchAgentFunc. Called from
// a deferred recover() in the goroutine launched at the end of the
// background branch.
//
// Without this recovery, a panic inside runChild — or any of the
// child callbacks (OnNormalized, OnExit, OnError), the progress
// emitter goroutine, the UpdateAgentStateByID closure, or any
// downstream provider/tool code — would kill the goroutine silently.
// No `firing agent_end` log line would fire, the agent's state would
// remain in `running` forever (or revert to that on the next
// MergedSnapshot), the dispatch registry would retain the name
// indefinitely, and the parent session's `backgroundAgents` counter
// on engine_status would never decrement. The original incident in
// conversation 1780874102870-12aee36b1e8d is the textbook example of
// what happens when a background dispatch fails to reach a terminal
// state: from the engine log alone the two agents looked frozen in
// place, with their last activity timestamps preserved as if they
// were still about to make progress.
//
// This function synthesizes exactly the same observable transitions
// that runChild's normal error branch would produce: the agent's
// status is set to "error", a follow-up agent_state snapshot is
// emitted with the new status, agent_end fires on the parent
// extension group, and the dispatch registry deregisters the agent
// name. The panic message is preserved in metadata.lastWork so a
// postmortem operator can find it without trawling the engine log
// for the stack trace.
//
// Logging shape mirrors the normal dispatch-end log so log analysis
// can treat both paths uniformly:
//
//   - utils.Error with full stack trace (postmortem)
//   - utils.Log "firing agent_end (panic) …" so a grep for
//     "firing agent_end" finds the panic case too
//   - utils.Log "dispatch complete agent=… exitCode=1 …" so a grep
//     for "dispatch complete" sees a terminal record for every
//     dispatch the engine has ever started
func recoverBackgroundDispatchPanic(
	sa SessionAccessor,
	registry *DispatchRegistry,
	opts extension.DispatchAgentOpts,
	key, agentID, agentName string,
	r interface{},
	childDepth int,
	parentDispatchId string,
) {
	// Capture the stack as soon as possible so it reflects the panic
	// site rather than the recovery site.
	stack := debug.Stack()
	utils.Error("Dispatch", fmt.Sprintf(
		"background dispatch panic agent=%q session=%s panic=%v\n%s",
		opts.Name, key, r, stack,
	))

	// 1. Synthesize a terminal agent-state transition so consumers
	//    see "error" rather than a stuck "running" entry. The closure
	//    body mirrors the error branch in runChild's
	//    UpdateAgentStateByID call (the one keyed off childErr != nil).
	panicMsg := fmt.Sprintf("panic: %v", r)
	sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
		if state.Metadata == nil {
			state.Metadata = map[string]interface{}{}
		}
		state.Status = "error"
		state.Metadata["lastWork"] = panicMsg
		// Mirror runChild's structured dispatch-entry update so
		// MergedSnapshot consumers see the dispatch row transition to
		// a terminal status. Elapsed and conversationId are unknown at
		// this point (the panic may have happened before either was
		// recorded), so pass zero / empty — UpdateDispatchEntry is
		// nil-safe on these.
		agents.UpdateDispatchEntry(state.Metadata, agentID, state.Status, 0, "")
	})
	sa.EmitAgentSnapshot("dispatch_panic")

	// 2. Fire agent_end on the parent extension group so any harness
	//    extension listening for the terminal signal sees it. Matches
	//    runChild's normal-completion FireAgentEnd call exactly.
	if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
		utils.Log("Dispatch", fmt.Sprintf(
			"firing agent_end (panic) key=%s name=%s id=%s status=1",
			key, agentName, agentID,
		))
		endCtx := NewExtContext(sa)
		extGroup.FireAgentEnd(endCtx, extension.AgentInfo{
			Name: agentName,
			Task: opts.Task,
		})
	}

	// 3. Emit dispatch_end telemetry on the parent session so consumers
	//    that aggregate dispatch lifecycle (e.g. cost tracking, agent
	//    panel deregistration) get the same end-of-life signal they
	//    get for normal terminations.
	sa.Emit(types.EngineEvent{
		Type:             "engine_dispatch_end",
		DispatchAgent:    opts.Name,
		DispatchExitCode: 1,
		DispatchDepth:    childDepth,
		DispatchParentId: parentDispatchId,
		DispatchId:       agentID,
	})

	// 4. Deregister from the dispatch registry so future recall
	//    attempts don't try to cancel a goroutine that has already
	//    died. Idempotent against any later deregister attempt.
	if registry != nil {
		registry.Deregister(agentID)
	}

	// 5. Final "dispatch complete" log line so log analysis sees a
	//    terminal record for this dispatch even on the panic path.
	utils.Log("Dispatch", fmt.Sprintf(
		"dispatch complete agent=%q exitCode=1 elapsed=0.00s cost=0.000000 tools=0 session=%s (panic recovered)",
		opts.Name, key,
	))
}
