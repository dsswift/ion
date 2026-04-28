package extension

import (
	"fmt"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ExtensionGroup wraps multiple extension hosts and dispatches Fire* calls
// across all of them, composing results according to each hook's semantics.
type ExtensionGroup struct {
	hosts []*Host
}

// NewExtensionGroup creates an empty extension group.
func NewExtensionGroup() *ExtensionGroup {
	return &ExtensionGroup{}
}

// Add appends a host to the group.
func (g *ExtensionGroup) Add(h *Host) {
	g.hosts = append(g.hosts, h)
}

// Hosts returns the underlying host slice.
func (g *ExtensionGroup) Hosts() []*Host {
	return g.hosts
}

// IsEmpty returns true if no hosts have been added.
func (g *ExtensionGroup) IsEmpty() bool {
	return len(g.hosts) == 0
}

// Close calls Dispose on every host in the group.
func (g *ExtensionGroup) Close() {
	for _, h := range g.hosts {
		h.Dispose()
	}
}

// Tools merges tool definitions from all hosts.
func (g *ExtensionGroup) Tools() []ToolDefinition {
	var all []ToolDefinition
	for _, h := range g.hosts {
		all = append(all, h.Tools()...)
	}
	return all
}

// Commands merges command definitions from all hosts. Later hosts override
// earlier ones if command names collide.
func (g *ExtensionGroup) Commands() map[string]CommandDefinition {
	merged := make(map[string]CommandDefinition)
	for _, h := range g.hosts {
		for k, v := range h.Commands() {
			merged[k] = v
		}
	}
	return merged
}

// ---------------------------------------------------------------------------
// Void hooks: call each host sequentially, log errors, return first error.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireSessionStart(ctx *Context) error {
	return g.fireVoid(func(h *Host) error { return h.FireSessionStart(ctx) })
}

func (g *ExtensionGroup) FireSessionEnd(ctx *Context) error {
	return g.fireVoid(func(h *Host) error { return h.FireSessionEnd(ctx) })
}

func (g *ExtensionGroup) FireMessageStart(ctx *Context) error {
	return g.fireVoid(func(h *Host) error { return h.FireMessageStart(ctx) })
}

func (g *ExtensionGroup) FireMessageEnd(ctx *Context) error {
	return g.fireVoid(func(h *Host) error { return h.FireMessageEnd(ctx) })
}

func (g *ExtensionGroup) FireToolEnd(ctx *Context) error {
	return g.fireVoid(func(h *Host) error { return h.FireToolEnd(ctx) })
}

func (g *ExtensionGroup) FireOnError(ctx *Context, info ErrorInfo) error {
	return g.fireVoid(func(h *Host) error { return h.FireOnError(ctx, info) })
}

func (g *ExtensionGroup) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	var model string
	for _, h := range g.hosts {
		m, err := h.FireModelSelect(ctx, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireModelSelect error: %v", err))
			return model, err
		}
		if m != "" {
			model = m
		}
	}
	return model, nil
}

func (g *ExtensionGroup) FireToolStart(ctx *Context, info ToolStartInfo) error {
	return g.fireVoid(func(h *Host) error { return h.FireToolStart(ctx, info) })
}

func (g *ExtensionGroup) FireSessionFork(ctx *Context, info ForkInfo) error {
	return g.fireVoid(func(h *Host) error { return h.FireSessionFork(ctx, info) })
}

// FireElicitationResult fires the elicitation_result hook on every host.
// Observational only — extensions cannot block or modify the response.
func (g *ExtensionGroup) FireElicitationResult(ctx *Context, info ElicitationResultInfo) {
	for _, h := range g.hosts {
		h.SDK().FireElicitationResult(ctx, info)
	}
}

func (g *ExtensionGroup) fireVoid(fn func(h *Host) error) error {
	var firstErr error
	for _, h := range g.hosts {
		if err := fn(h); err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("hook error: %v", err))
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// ---------------------------------------------------------------------------
// Block hooks: short-circuit on first non-nil result.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireToolCall(ctx *Context, info ToolCallInfo) (*ToolCallResult, error) {
	for _, h := range g.hosts {
		result, err := h.FireToolCall(ctx, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireToolCall error: %v", err))
			return nil, err
		}
		if result != nil {
			return result, nil
		}
	}
	return nil, nil
}

func (g *ExtensionGroup) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	for _, h := range g.hosts {
		result, err := h.FirePerToolCall(ctx, toolName, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FirePerToolCall error: %v", err))
			return nil, err
		}
		if result != nil {
			return result, nil
		}
	}
	return nil, nil
}

// ---------------------------------------------------------------------------
// String mutation: chain output through hosts sequentially.
// ---------------------------------------------------------------------------

// FireBeforePrompt chains the prompt through each host. The system prompt
// uses last-non-empty semantics.
func (g *ExtensionGroup) FireBeforePrompt(ctx *Context, prompt string) (string, string, error) {
	var systemPrompt string
	for _, h := range g.hosts {
		newPrompt, sp, err := h.FireBeforePrompt(ctx, prompt)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireBeforePrompt error: %v", err))
			return prompt, systemPrompt, err
		}
		prompt = newPrompt
		if sp != "" {
			systemPrompt = sp
		}
	}
	return prompt, systemPrompt, nil
}

// FireInput chains the prompt string through each host.
func (g *ExtensionGroup) FireInput(ctx *Context, prompt string) (string, error) {
	for _, h := range g.hosts {
		newPrompt, err := h.FireInput(ctx, prompt)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireInput error: %v", err))
			return prompt, err
		}
		prompt = newPrompt
	}
	return prompt, nil
}

// FireBeforeAgentStart chains the system prompt through each host.
// Last non-empty value wins.
func (g *ExtensionGroup) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, error) {
	var systemPrompt string
	for _, h := range g.hosts {
		sp, err := h.FireBeforeAgentStart(ctx, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireBeforeAgentStart error: %v", err))
			return systemPrompt, err
		}
		if sp != "" {
			systemPrompt = sp
		}
	}
	return systemPrompt, nil
}

// FirePerToolResult chains the result string through each host.
func (g *ExtensionGroup) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	var result string
	for _, h := range g.hosts {
		r, err := h.FirePerToolResult(ctx, toolName, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FirePerToolResult error: %v", err))
			return result, err
		}
		result = r
	}
	return result, nil
}

// ---------------------------------------------------------------------------
// Bool cancel: any true = true.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireSessionBeforeCompact(ctx *Context, info CompactionInfo) (bool, error) {
	return g.fireBool(func(h *Host) (bool, error) { return h.FireSessionBeforeCompact(ctx, info) })
}

func (g *ExtensionGroup) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	return g.fireBool(func(h *Host) (bool, error) { return h.FireSessionBeforeFork(ctx, info) })
}

func (g *ExtensionGroup) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	return g.fireBool(func(h *Host) (bool, error) { return h.FireContextDiscover(ctx, info) })
}

func (g *ExtensionGroup) fireBool(fn func(h *Host) (bool, error)) (bool, error) {
	for _, h := range g.hosts {
		cancel, err := fn(h)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("bool hook error: %v", err))
			return false, err
		}
		if cancel {
			return true, nil
		}
	}
	return false, nil
}

// ---------------------------------------------------------------------------
// ContextLoad: any rejection wins; last non-empty content wins.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireContextLoad(ctx *Context, info ContextLoadInfo) (string, bool, error) {
	var content string
	for _, h := range g.hosts {
		c, rejected, err := h.FireContextLoad(ctx, info)
		if err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireContextLoad error: %v", err))
			return "", false, err
		}
		if rejected {
			return "", true, nil
		}
		if c != "" {
			content = c
		}
	}
	return content, false, nil
}

// ---------------------------------------------------------------------------
// PlanModePrompt: last non-empty prompt wins, merge allowedTools.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string) {
	var prompt string
	var allTools []string
	for _, h := range g.hosts {
		p, tools := h.FirePlanModePrompt(ctx, planFilePath)
		if p != "" {
			prompt = p
		}
		allTools = append(allTools, tools...)
	}
	return prompt, allTools
}

// ---------------------------------------------------------------------------
// Info merge: concatenate results from all hosts.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireContextInject(ctx *Context, info ContextInjectInfo) []ContextEntry {
	var all []ContextEntry
	for _, h := range g.hosts {
		all = append(all, h.FireContextInject(ctx, info)...)
	}
	return all
}

func (g *ExtensionGroup) FireCapabilityDiscover(ctx *Context) []Capability {
	var all []Capability
	for _, h := range g.hosts {
		all = append(all, h.FireCapabilityDiscover(ctx)...)
	}
	return all
}

// FireCapabilityMatch returns the first non-nil match across hosts.
func (g *ExtensionGroup) FireCapabilityMatch(ctx *Context, info CapabilityMatchInfo) *CapabilityMatchResult {
	for _, h := range g.hosts {
		if result := h.FireCapabilityMatch(ctx, info); result != nil {
			return result
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// SDK-level void hooks: delegate to each host's SDK directly.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FireTurnStart(ctx *Context, info TurnInfo) {
	for _, h := range g.hosts {
		if err := h.SDK().FireTurnStart(ctx, info); err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireTurnStart error: %v", err))
		}
	}
}

func (g *ExtensionGroup) FireTurnEnd(ctx *Context, info TurnInfo) {
	for _, h := range g.hosts {
		if err := h.SDK().FireTurnEnd(ctx, info); err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireTurnEnd error: %v", err))
		}
	}
}

func (g *ExtensionGroup) FireSessionCompact(ctx *Context, info CompactionInfo) {
	for _, h := range g.hosts {
		if err := h.SDK().FireSessionCompact(ctx, info); err != nil {
			utils.Log("ExtensionGroup", fmt.Sprintf("FireSessionCompact error: %v", err))
		}
	}
}

func (g *ExtensionGroup) FirePermissionRequest(ctx *Context, info PermissionRequestInfo) {
	for _, h := range g.hosts {
		h.SDK().FirePermissionRequest(ctx, info)
	}
}

// FirePermissionClassify fires the permission_classify hook on each host
// and returns the first non-empty tier label. Hosts run in registration
// order; if no host returns a label, the empty string is returned and
// callers fall back to the engine's built-in classifier.
func (g *ExtensionGroup) FirePermissionClassify(ctx *Context, info PermissionClassifyInfo) string {
	for _, h := range g.hosts {
		if tier := h.SDK().FirePermissionClassify(ctx, info); tier != "" {
			return tier
		}
	}
	return ""
}

func (g *ExtensionGroup) FirePermissionDenied(ctx *Context, info PermissionDeniedInfo) {
	for _, h := range g.hosts {
		h.SDK().FirePermissionDenied(ctx, info)
	}
}

func (g *ExtensionGroup) FireFileChanged(ctx *Context, info FileChangedInfo) {
	for _, h := range g.hosts {
		h.SDK().FireFileChanged(ctx, info)
	}
}
