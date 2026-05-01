package extension

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type hookError struct {
	Code    int
	Message string
	Stack   string
}

func (e *hookError) Error() string {
	return fmt.Sprintf("jsonrpc error %d: %s", e.Code, e.Message)
}

// emitHookError emits an engine_error for a failed hook invocation.
// errExtensionDeadSilent is suppressed so a dead subprocess produces only the
// single engine_error emitted from callHook on first death.
func emitHookError(ctx *Context, hook string, err error, stack string) {
	if errors.Is(err, errExtensionDeadSilent) {
		return
	}
	if ctx != nil && ctx.Emit != nil {
		msg := fmt.Sprintf("extension hook %s failed: %v", hook, err)
		if stack != "" {
			msg += "\n\n" + stack
		}
		ctx.Emit(types.EngineEvent{
			Type:         "engine_error",
			EventMessage: msg,
			ErrorCode:    "hook_failed",
		})
	}
}

// logHookErr writes a hook failure to engine.log. It silently drops the
// dead-subprocess sentinel so a crashed extension does not flood the log
// with one entry per hook fire (turn_start/turn_end/etc fire many times
// per second).
func logHookErr(hook string, err error) {
	if errors.Is(err, errExtensionDeadSilent) {
		return
	}
	utils.Warn("extension", fmt.Sprintf("hook %s error: %v", hook, err))
}

// emitHookEvents checks a hook response for an "events" array and emits
// each EngineEvent via ctx.Emit. Extensions can return side-effect events
// alongside their primary hook result.
func emitHookEvents(ctx *Context, raw json.RawMessage) {
	if len(raw) == 0 || ctx == nil || ctx.Emit == nil {
		return
	}
	var wrapper struct {
		Events []types.EngineEvent `json:"events"`
	}
	if err := json.Unmarshal(raw, &wrapper); err != nil {
		return
	}
	if len(wrapper.Events) > 0 {
		utils.Log("extension", fmt.Sprintf("emitHookEvents: %d events to emit", len(wrapper.Events)))
	}
	for _, ev := range wrapper.Events {
		if ev.Type != "" {
			utils.Log("extension", fmt.Sprintf("emitHookEvents: emitting %s", ev.Type))
			ctx.Emit(ev)
		}
	}
}
