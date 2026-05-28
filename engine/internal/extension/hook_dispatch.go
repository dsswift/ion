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
func (h *Host) FireMessageUpdate(ctx *Context, info MessageUpdateInfo) error {
	return h.sdk.FireMessageUpdate(ctx, info)
}
func (h *Host) FireOnError(ctx *Context, info ErrorInfo) error {
	return h.sdk.FireOnError(ctx, info)
}

func (h *Host) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, string, error) {
	return h.sdk.FireBeforeAgentStart(ctx, info)
}

func (h *Host) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	return h.sdk.FireBeforePrompt(ctx, prompt)
}

// FireBeforeProviderRequest fires the before_provider_request hook on this
// host's SDK. Observe-only: errors from the SDK are logged by the SDK layer
// and do not propagate (the agent loop must never stall on a telemetry hook).
func (h *Host) FireBeforeProviderRequest(ctx *Context, info BeforeProviderRequestInfo) error {
	return h.sdk.FireBeforeProviderRequest(ctx, info)
}

func (h *Host) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string, string) {
	return h.sdk.FirePlanModePrompt(ctx, planFilePath)
}

// FireBeforePlanModeEnter fires the before_plan_mode_enter hook on this host.
func (h *Host) FireBeforePlanModeEnter(ctx *Context, info PlanModeEnterInfo) (allowed bool, reason string) {
	return h.sdk.FireBeforePlanModeEnter(ctx, info)
}

// FireBeforePlanModeExit fires the before_plan_mode_exit hook on this host.
func (h *Host) FireBeforePlanModeExit(ctx *Context, info BeforePlanModeExitInfo) (allowed bool, reason string) {
	return h.sdk.FireBeforePlanModeExit(ctx, info)
}

func (h *Host) FireSystemInject(ctx *Context, info SystemInjectInfo) (string, bool) {
	return h.sdk.FireSystemInject(ctx, info)
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

// FireCompactSummaryRequest delegates to the SDK. Returns (summary, ok)
// with ok=true when any handler produced a non-empty summary, else
// ("", false). The engine reads ok=false as "fall back to the regex
// fact extractor"; see RunHooks.OnRequestCompactSummary.
func (h *Host) FireCompactSummaryRequest(ctx *Context, info CompactSummaryRequestInfo) (string, bool) {
	return h.sdk.FireCompactSummaryRequest(ctx, info)
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
