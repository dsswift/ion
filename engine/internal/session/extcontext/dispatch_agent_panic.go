package extcontext

import (
	"fmt"
	"runtime/debug"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// recoverBackgroundDispatchPanic finalizes a failed asynchronous dispatch.
// Parent/root delivery happens before optional extension callbacks: callback
// code is observational and cannot strand the owning conversation.
func recoverBackgroundDispatchPanic(
	sa SessionAccessor,
	registry *DispatchRegistry,
	opts extension.DispatchAgentOpts,
	key, agentID, agentName string,
	r any,
	childDepth int,
	parentDispatchID string,
	toolServer *backend.ToolServer,
	onTerminal func(extension.DispatchAgentResult),
) {
	stack := debug.Stack()
	panicMessage := fmt.Sprintf("panic: %v", r)
	utils.LogWithFields(utils.LevelError, "server", "background dispatch panic", map[string]any{
		"model": opts.Name, "session_id": key, "error": panicMessage, "stack": string(stack),
	})
	if toolServer != nil {
		toolServer.Stop()
	}

	sa.UpdateAgentStateByID(agentID, func(state *types.AgentStateUpdate) {
		if state.Metadata == nil {
			state.Metadata = map[string]interface{}{}
		}
		state.Status = "error"
		state.Metadata["lastWork"] = panicMessage
		agents.UpdateDispatchEntry(state.Metadata, agentID, state.Status, 0, "")
	})
	sa.EmitAgentSnapshot("dispatch_panic")

	result := extension.DispatchAgentResult{
		Name:             opts.Name,
		DispatchID:       agentID,
		Output:           panicMessage,
		ExitCode:         1,
		Depth:            childDepth,
		ParentDispatchId: parentDispatchID,
	}

	if !opts.Detached && registry != nil && parentDispatchID != "" {
		if !registry.RecordChildResult(parentDispatchID, ChildResultRecord{
			ChildID: agentID, Name: opts.Name, Output: result.Output, ExitCode: result.ExitCode,
		}) {
			if root, ok := sa.(RootDispatchResultDelivery); ok {
				root.DeliverRootDispatchResult(result)
			}
		}
	}
	if registry != nil {
		registry.Deregister(agentID)
		sa.EmitDispatchCountStatus("dispatch_panic_deregister")
	}
	if extGroup := sa.ExtGroup(); extGroup != nil && !extGroup.IsEmpty() {
		utils.LogWithFields(utils.LevelInfo, "server", "firing agent_end after recovered dispatch panic", map[string]any{
			"session_id": key, "agent_name": agentName, "run_id": agentID,
		})
		extGroup.FireAgentEnd(NewExtContext(sa, registry), extension.AgentInfo{Name: agentName, Task: opts.Task})
	}
	sa.Emit(types.EngineEvent{
		Type:             "engine_dispatch_end",
		DispatchAgent:    opts.Name,
		DispatchExitCode: result.ExitCode,
		DispatchDepth:    childDepth,
		DispatchParentId: parentDispatchID,
		DispatchId:       agentID,
	})

	if !opts.Detached {
		if registry != nil && parentDispatchID != "" {
			registry.NotifyChildComplete(parentDispatchID, agentID)
		} else if root, ok := sa.(RootDispatchResultDelivery); ok {
			root.DeliverRootDispatchResult(result)
		}
	}
	invokePanicTerminalCallback(onTerminal, result, key, agentID)

	utils.LogWithFields(utils.LevelInfo, "server", "dispatch complete after recovered panic", map[string]any{
		"model": opts.Name, "session_id": key, "dispatch_id": agentID, "exit_code": result.ExitCode,
	})
}

// invokePanicTerminalCallback isolates optional extension callback failure from
// engine-owned parent/root delivery. A callback panic is logged, not allowed to
// re-panic the dispatch goroutine after recovery.
func invokePanicTerminalCallback(callback func(extension.DispatchAgentResult), result extension.DispatchAgentResult, sessionKey, dispatchID string) {
	if callback == nil {
		return
	}
	invokeDispatchCallback(func() { callback(result) }, sessionKey, dispatchID, "panic_terminal")
}

// invokeDispatchCallback contains observer failures. Engine delivery is
// complete before callback execution, so callbacks must never re-panic a
// dispatch goroutine or block a parked parent from revival.
func invokeDispatchCallback(callback func(), sessionKey, dispatchID, callbackName string) {
	if callback == nil {
		return
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			utils.LogWithFields(utils.LevelError, "server", "dispatch callback panicked", map[string]any{
				"session_id": sessionKey, "dispatch_id": dispatchID, "callback": callbackName, "error": fmt.Sprint(recovered), "stack": string(debug.Stack()),
			})
		}
	}()
	callback()
}
