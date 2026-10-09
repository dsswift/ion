package extension

import (
	"github.com/dsswift/ion/engine/internal/utils"
)

// ExtensionGroup wraps multiple extension hosts and dispatches Fire* calls
// across all of them, composing results according to each hook's semantics.
type ExtensionGroup struct {
	hosts []*Host
	// spanStarter records hook.fanout spans (group_fanout.go); nil is off.
	spanStarter HookSpanStarter
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

// Tools merges tool definitions from all hosts. Last-registered wins when
// multiple hosts register the same tool name.
func (g *ExtensionGroup) Tools() []ToolDefinition {
	seen := make(map[string]int) // name -> index in all
	var all []ToolDefinition
	for _, h := range g.hosts {
		for _, t := range h.Tools() {
			if idx, ok := seen[t.Name]; ok {
				all[idx] = t
				utils.LogWithFields(utils.LevelDebug, "extension.group", "duplicate tool from host , last-registered wins", map[string]any{"tool_name": t.Name, "host_name": h.Name()})
			} else {
				seen[t.Name] = len(all)
				all = append(all, t)
			}
		}
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

func (g *ExtensionGroup) FireIdentityChanged(ctx *Context, info IdentityChangedInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "identity_changed")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireIdentityChanged(ctx, info) })
}

func (g *ExtensionGroup) FireSessionStart(ctx *Context) error {
	ctx, endFanout := g.beginFanout(ctx, "session_start")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireSessionStart(ctx) })
}

func (g *ExtensionGroup) FireSessionEnd(ctx *Context) error {
	ctx, endFanout := g.beginFanout(ctx, "session_end")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireSessionEnd(ctx) })
}

func (g *ExtensionGroup) FireMessageStart(ctx *Context) error {
	ctx, endFanout := g.beginFanout(ctx, "message_start")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireMessageStart(ctx) })
}

func (g *ExtensionGroup) FireMessageEnd(ctx *Context) error {
	ctx, endFanout := g.beginFanout(ctx, "message_end")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireMessageEnd(ctx) })
}

func (g *ExtensionGroup) FireMessageUpdate(ctx *Context, info MessageUpdateInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "message_update")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireMessageUpdate(ctx, info) })
}

func (g *ExtensionGroup) FireToolEnd(ctx *Context) error {
	ctx, endFanout := g.beginFanout(ctx, "tool_end")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireToolEnd(ctx) })
}
func (g *ExtensionGroup) FireTaskCreated(ctx *Context, info TaskLifecycleInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "task_created")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireTaskCreated(ctx, info) })
}
func (g *ExtensionGroup) FireTaskCompleted(ctx *Context, info TaskLifecycleInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "task_completed")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireTaskCompleted(ctx, info) })
}

func (g *ExtensionGroup) FireOnError(ctx *Context, info ErrorInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "on_error")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireOnError(ctx, info) })
}

func (g *ExtensionGroup) FireModelSelect(ctx *Context, info ModelSelectInfo) (string, error) {
	ctx, endFanout := g.beginFanout(ctx, "model_select")
	defer endFanout()
	var model string
	for _, h := range g.hosts {
		m, err := h.FireModelSelect(ctx, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firemodelselect error", map[string]any{"error": err})
			return model, err
		}
		if m != "" {
			model = m
		}
	}
	return model, nil
}

// FireSlashCommandResolved fires slash_command_resolved on every host. The last
// host that returns an override string wins (matching FireModelSelect's
// last-writer policy). Returns the override and true when any host overrode.
func (g *ExtensionGroup) FireSlashCommandResolved(ctx *Context, info SlashResolvedInfo) (string, bool) {
	ctx, endFanout := g.beginFanout(ctx, "slash_command_resolved")
	defer endFanout()
	var override string
	var overridden bool
	for _, h := range g.hosts {
		if o, ok := h.FireSlashCommandResolved(ctx, info); ok {
			override = o
			overridden = true
		}
	}
	return override, overridden
}

// FireBeforeSlashModelBoundary resolves the last explicit Apply decision across
// all extension hosts. Nil means every host abstained.
func (g *ExtensionGroup) FireBeforeSlashModelBoundary(ctx *Context, info SlashModelBoundaryInfo) *SlashModelBoundaryResult {
	ctx, endFanout := g.beginFanout(ctx, "before_slash_model_boundary")
	defer endFanout()
	var decision *SlashModelBoundaryResult
	for _, h := range g.hosts {
		if result := h.FireBeforeSlashModelBoundary(ctx, info); result != nil && result.Apply != nil {
			value := *result.Apply
			decision = &SlashModelBoundaryResult{Apply: &value}
		}
	}
	return decision
}

func (g *ExtensionGroup) FireToolStart(ctx *Context, info ToolStartInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "tool_start")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireToolStart(ctx, info) })
}

func (g *ExtensionGroup) FireSessionFork(ctx *Context, info ForkInfo) error {
	ctx, endFanout := g.beginFanout(ctx, "session_fork")
	defer endFanout()
	return g.fireVoid(func(h *Host) error { return h.FireSessionFork(ctx, info) })
}

// FireElicitationResult fires the elicitation_result hook on every host.
// Observational only — extensions cannot block or modify the response.
func (g *ExtensionGroup) FireElicitationResult(ctx *Context, info ElicitationResultInfo) {
	ctx, endFanout := g.beginFanout(ctx, "elicitation_result")
	defer endFanout()
	for _, h := range g.hosts {
		h.SDK().FireElicitationResult(ctx, info)
	}
}

func (g *ExtensionGroup) fireVoid(fn func(h *Host) error) error {
	var firstErr error
	for _, h := range g.hosts {
		if err := fn(h); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "hook error", map[string]any{"error": err})
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
	ctx, endFanout := g.beginFanout(ctx, "tool_call")
	defer endFanout()
	for _, h := range g.hosts {
		result, err := h.FireToolCall(ctx, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firetoolcall error", map[string]any{"error": err})
			return nil, err
		}
		if result != nil {
			return result, nil
		}
	}
	return nil, nil
}

func (g *ExtensionGroup) FirePerToolCall(ctx *Context, toolName string, info interface{}) (*PerToolCallResult, error) {
	ctx, endFanout := g.beginFanout(ctx, toolName+"_tool_call")
	defer endFanout()
	for _, h := range g.hosts {
		result, err := h.FirePerToolCall(ctx, toolName, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firepertoolcall error", map[string]any{"error": err})
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
	ctx, endFanout := g.beginFanout(ctx, "before_prompt")
	defer endFanout()
	var systemPrompt string
	for _, h := range g.hosts {
		newPrompt, sp, err := h.FireBeforePrompt(ctx, prompt)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firebeforeprompt error", map[string]any{"error": err})
			return prompt, systemPrompt, err
		}
		prompt = newPrompt
		if sp != "" {
			systemPrompt = sp
		}
	}
	return prompt, systemPrompt, nil
}

// FireBeforeConversationEvent chains the before_conversation_event hook
// through each host, merging every host's returned map key-by-key —
// last-writer-wins on a colliding key across hosts, matching the
// per-handler merge semantics inside SDK.FireBeforeConversationEvent.
func (g *ExtensionGroup) FireBeforeConversationEvent(ctx *Context, info BeforeConversationEventInfo) map[string]any {
	ctx, endFanout := g.beginFanout(ctx, "before_conversation_event")
	defer endFanout()
	var merged map[string]any
	for _, h := range g.hosts {
		m := h.FireBeforeConversationEvent(ctx, info)
		if m == nil {
			continue
		}
		if merged == nil {
			merged = make(map[string]any, len(m))
		}
		for k, v := range m {
			merged[k] = v
		}
	}
	return merged
}

// FireInput chains the prompt string through each host.
func (g *ExtensionGroup) FireInput(ctx *Context, prompt string) (string, error) {
	ctx, endFanout := g.beginFanout(ctx, "input")
	defer endFanout()
	for _, h := range g.hosts {
		newPrompt, err := h.FireInput(ctx, prompt)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "fireinput error", map[string]any{"error": err})
			return prompt, err
		}
		prompt = newPrompt
	}
	return prompt, nil
}

// FireBeforeAgentStart chains the system prompt and agent name through each
// host. Last non-empty value wins for each field independently.
func (g *ExtensionGroup) FireBeforeAgentStart(ctx *Context, info AgentInfo) (string, string, error) {
	ctx, endFanout := g.beginFanout(ctx, "before_agent_start")
	defer endFanout()
	var systemPrompt, agentName string
	for _, h := range g.hosts {
		sp, an, err := h.FireBeforeAgentStart(ctx, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firebeforeagentstart error", map[string]any{"error": err})
			return systemPrompt, agentName, err
		}
		if sp != "" {
			systemPrompt = sp
		}
		if an != "" {
			agentName = an
		}
	}
	return systemPrompt, agentName, nil
}

// FirePerToolResult chains the result string through each host.
func (g *ExtensionGroup) FirePerToolResult(ctx *Context, toolName string, info interface{}) (string, error) {
	ctx, endFanout := g.beginFanout(ctx, toolName+"_tool_result")
	defer endFanout()
	var result string
	for _, h := range g.hosts {
		r, err := h.FirePerToolResult(ctx, toolName, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firepertoolresult error", map[string]any{"error": err})
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
	ctx, endFanout := g.beginFanout(ctx, "session_before_compact")
	defer endFanout()
	return g.fireBool(func(h *Host) (bool, error) { return h.FireSessionBeforeCompact(ctx, info) })
}

func (g *ExtensionGroup) FireSessionBeforeFork(ctx *Context, info ForkInfo) (bool, error) {
	ctx, endFanout := g.beginFanout(ctx, "session_before_fork")
	defer endFanout()
	return g.fireBool(func(h *Host) (bool, error) { return h.FireSessionBeforeFork(ctx, info) })
}

func (g *ExtensionGroup) FireSessionBeforeRelease(ctx *Context, info SessionReleaseInfo) (bool, error) {
	ctx, endFanout := g.beginFanout(ctx, "session_before_release")
	defer endFanout()
	return g.fireBool(func(h *Host) (bool, error) { return h.FireSessionBeforeRelease(ctx, info) })
}

func (g *ExtensionGroup) FireContextDiscover(ctx *Context, info ContextDiscoverInfo) (bool, error) {
	ctx, endFanout := g.beginFanout(ctx, "context_discover")
	defer endFanout()
	return g.fireBool(func(h *Host) (bool, error) { return h.FireContextDiscover(ctx, info) })
}

func (g *ExtensionGroup) fireBool(fn func(h *Host) (bool, error)) (bool, error) {
	for _, h := range g.hosts {
		cancel, err := fn(h)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "bool hook error", map[string]any{"error": err})
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
	ctx, endFanout := g.beginFanout(ctx, "context_load")
	defer endFanout()
	var content string
	for _, h := range g.hosts {
		c, rejected, err := h.FireContextLoad(ctx, info)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension.group", "firecontextload error", map[string]any{"error": err})
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
// PlanModePrompt: last non-empty prompt wins, merge allowedTools, last non-empty sparseReminder wins.
// ---------------------------------------------------------------------------

func (g *ExtensionGroup) FirePlanModePrompt(ctx *Context, planFilePath string) (string, []string, string) {
	ctx, endFanout := g.beginFanout(ctx, "plan_mode_prompt")
	defer endFanout()
	var prompt string
	var allTools []string
	var sparseReminder string
	for _, h := range g.hosts {
		p, tools, sr := h.FirePlanModePrompt(ctx, planFilePath)
		if p != "" {
			prompt = p
		}
		allTools = append(allTools, tools...)
		if sr != "" {
			sparseReminder = sr
		}
	}
	return prompt, allTools, sparseReminder
}

// FireBeforePlanModeExit fans the before_plan_mode_exit hook out to every host
// and folds per-host results into a single allow/deny decision. Last non-nil
// Allow across all hosts wins. Returns (true, "") when no handler has an opinion.
func (g *ExtensionGroup) FireBeforePlanModeExit(ctx *Context, info BeforePlanModeExitInfo) (allowed bool, reason string) {
	ctx, endFanout := g.beginFanout(ctx, "before_plan_mode_exit")
	defer endFanout()
	allowed = true
	utils.LogWithFields(utils.LevelInfo, "extension_group", "firebeforeplanmodeexit: dispatching to host(s)", map[string]any{"count": len(g.hosts), "plan_file_path": info.PlanFilePath})
	for _, h := range g.hosts {
		a, r := h.FireBeforePlanModeExit(ctx, info)
		if !a {
			allowed = false
			if r != "" {
				reason = r
			}
		} else if !allowed {
			// Later host re-allows after an earlier denial — last wins.
			allowed = true
			reason = ""
		}
	}
	return allowed, reason
}
