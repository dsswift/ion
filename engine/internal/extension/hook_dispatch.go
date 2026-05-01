package extension

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"

	"github.com/dsswift/ion/engine/internal/utils"
)

// --- Delegated fire methods ---

func (h *Host) FireSessionStart(ctx *Context) error         { return h.sdk.FireSessionStart(ctx) }
func (h *Host) FireSessionEnd(ctx *Context) error           { return h.sdk.FireSessionEnd(ctx) }
func (h *Host) FireMessageStart(ctx *Context) error         { return h.sdk.FireMessageStart(ctx) }
func (h *Host) FireMessageEnd(ctx *Context) error           { return h.sdk.FireMessageEnd(ctx) }
func (h *Host) FireToolEnd(ctx *Context) error              { return h.sdk.FireToolEnd(ctx) }
func (h *Host) FireOnError(ctx *Context, info ErrorInfo) error {
	return h.sdk.FireOnError(ctx, info)
}

func (h *Host) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, error) {
	return h.sdk.FireBeforeAgentStart(ctx, info)
}

func (h *Host) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	return h.sdk.FireBeforePrompt(ctx, prompt)
}

func (h *Host) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string) {
	return h.sdk.FirePlanModePrompt(ctx, planFilePath)
}

func (h *Host) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	return h.sdk.FireContextInject(ctx, info)
}

func (h *Host) FireCapabilityDiscover(ctx *Context) []Capability {
	return h.sdk.FireCapabilityDiscover(ctx)
}

func (h *Host) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	return h.sdk.FireCapabilityMatch(ctx, info)
}

func (h *Host) FireToolCall(ctx *Context, info ToolCallInfo) (*ToolCallResult, error) {
	return h.sdk.FireToolCall(ctx, info)
}

func (h *Host) FireToolStart(ctx *Context, info ToolStartInfo) error {
	return h.sdk.FireToolStart(ctx, info)
}

func (h *Host) FireSessionBeforeCompact(ctx *Context, info CompactionInfo) (bool, error) {
	return h.sdk.FireSessionBeforeCompact(ctx, info)
}

func (h *Host) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	return h.sdk.FireSessionBeforeFork(ctx, info)
}

func (h *Host) FireSessionFork(ctx *Context, info ForkInfo) error {
	return h.sdk.FireSessionFork(ctx, info)
}

func (h *Host) FireInput(ctx *Context, prompt string) (string, error) {
	return h.sdk.FireInput(ctx, prompt)
}

func (h *Host) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	return h.sdk.FirePerToolCall(ctx, toolName, info)
}

func (h *Host) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	return h.sdk.FirePerToolResult(ctx, toolName, info)
}

func (h *Host) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	return h.sdk.FireContextDiscover(ctx, info)
}

func (h *Host) FireContextLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	return h.sdk.FireContextLoad(ctx, info)
}
func (h *Host) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	return h.sdk.FireModelSelect(ctx, info)
}

// RegisterRequiredHooks prepends enterprise-mandated hooks. Each HookDef
// maps an event name to a shell command handler. The handler receives the
// hook payload as JSON on stdin and returns an optional result on stdout.
// Required hooks run before any extension-registered hooks.
func (h *Host) RegisterRequiredHooks(hooks []struct{ Event, Handler string }) {
	for _, hk := range hooks {
		handler := hk.Handler // capture for closure
		h.sdk.PrependHook(hk.Event, func(ctx *Context, payload interface{}) (interface{}, error) {
			payloadBytes, _ := json.Marshal(payload)
			cmd := exec.Command("sh", "-c", handler)
			cmd.Stdin = bytes.NewReader(payloadBytes)
			out, err := cmd.Output()
			if err != nil {
				utils.Log("RequiredHook", fmt.Sprintf("hook %q failed: %v", handler, err))
				return nil, fmt.Errorf("required hook failed: %w", err)
			}
			if len(bytes.TrimSpace(out)) == 0 {
				return nil, nil
			}
			var result interface{}
			if jsonErr := json.Unmarshal(out, &result); jsonErr != nil {
				return string(out), nil
			}
			return result, nil
		})
	}
}
