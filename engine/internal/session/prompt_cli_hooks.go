package session

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// resetCliToolServer clears the session ToolServer's registrations at the
// start of a prompt's wiring, so the wire* helpers that follow register this
// prompt's tools onto an empty server. See ToolServer.ResetTools.
func (m *Manager) resetCliToolServer(s *engineSession, opts *types.RunOptions) {
	if _, ok := mcpCapableCli(m.resolvedBackend(opts.Model)); !ok {
		return
	}
	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()
	if ts != nil {
		ts.ResetTools()
	}
}

// buildToolAliasDirective renders a system-prompt directive that maps bare
// extension tool names to their MCP-prefixed forms.  The CLI backend bridges
// extension tools via an MCP server, so the model only sees them as
// "mcp__<mcpServerName>__<name>".  Extension prompts reference bare names
// (e.g. "dispatch_agent"), so without this directive the model never calls
// them.
//
// Returns an empty string when bareNames is empty so callers can skip the
// append entirely.
func buildToolAliasDirective(bareNames []string, mcpServerName string) string {
	if len(bareNames) == 0 {
		return ""
	}
	// The directive is part of the system prompt, which a provider caches as a
	// prefix. Names are listed in sorted order so the text depends on the set
	// of tools and not on the order their sources happened to report them in.
	names := append([]string(nil), bareNames...)
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("Tool name aliases: when your instructions reference a bare tool name, it is the same tool exposed under the MCP-prefixed name. Use the prefixed name when calling the tool.")
	for _, name := range names {
		fmt.Fprintf(&b, "\n- %s = mcp__%s__%s", name, mcpServerName, name)
	}
	return b.String()
}

// appendDirective appends a non-empty tool-alias directive to opts.AppendSystemPrompt,
// inserting the blank-line separator when a prior prompt is present, and logs the
// outcome with the contributing tool names. An empty directive is a no-op (logged
// as skipped). names is used only for the log line.
func appendDirective(opts *types.RunOptions, directive string, names []string) {
	if directive == "" {
		utils.Log("Session", "tool alias directive skipped (no tools)")
		return
	}
	if opts.AppendSystemPrompt != "" {
		opts.AppendSystemPrompt += "\n\n"
	}
	opts.AppendSystemPrompt += directive
	utils.LogWithFields(utils.LevelInfo, "session", "tool alias directive built ( tools: )", map[string]any{"count": len(names), "join": strings.Join(names, ", ")})
}

// mcpCapableCli / attachToolServerMcp are thin session-package aliases over the
// backend-package helpers of the same behavior, so the parent-run wiring here
// and the dispatched-child wiring in backend.BuildDelegatedChildToolServer stay
// in lockstep (one definition of "which CLI backend takes MCP how").
func mcpCapableCli(b backend.RunBackend) (kind string, ok bool) { return backend.McpCapableCli(b) }

func (m *Manager) attachToolServerMcp(opts *types.RunOptions, ts *backend.ToolServer, key, kind string) error {
	return backend.AttachToolServerToRunOptions(opts, ts, key, kind)
}

// ensureCliToolServerAttached guarantees the run's RunOptions carry the
// session ToolServer's MCP wiring on EVERY turn, not only the turn that created
// the server.
//
// The ToolServer is created once and reused for the session's whole life (the
// wire* helpers above take the s.toolServer fast path with needsStart=false on
// every turn after the first). RunOptions, by contrast, are rebuilt per prompt.
// attachToolServerMcp — the only writer of opts.McpConfig (claude-code) and
// opts.CliMcpServers (ACP) — runs solely inside the needsStart branch, so a
// reused ToolServer left the second and later turns with an empty McpConfig.
// buildClaudeArgs keys both --mcp-config AND the mcp__<server>__* allowedTools
// wildcard off opts.McpConfig, so the CLI was spawned with no MCP config and no
// wildcard: the model saw none of the ion-extensions tools (ion_agent, both
// AskUserQuestion tools, plan-mode ExitPlanMode) and every call returned
// "No such tool available". This runs once after all wiring, and is idempotent:
// it re-attaches only when this turn's wiring did not already (McpConfig empty
// for claude-code, CliMcpServers empty for ACP), so the create-turn is a no-op.
func (m *Manager) ensureCliToolServerAttached(s *engineSession, key string, opts *types.RunOptions) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok {
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()
	if ts == nil {
		return
	}
	// Whichever wire* helper created the server, it enforces the session's
	// plan policy on every call.
	ts.SetPlanPolicySource(m.cliPlanPolicySource(s))

	// Already attached by this turn's create-branch wiring: claude-code sets
	// McpConfig, ACP appends to CliMcpServers. Both are keyed on the fresh
	// per-turn opts, so a non-empty value means "attached this turn".
	if kind == "acp" {
		if len(opts.CliMcpServers) > 0 {
			return
		}
	} else if opts.McpConfig != "" {
		return
	}

	if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
		utils.LogWithFields(utils.LevelError, "session", "toolserver mcp re-attach failed (reused server)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelInfo, "session", "reattached reused ToolServer MCP config to run options", map[string]any{"key": key, "kind": kind})
}

// wireToolServer starts a ToolServer for a delegated-CLI backend when
// extensions provide tools, exposing them to the subprocess over MCP.
//
// Under HybridBackend, this fires when the model resolves to an MCP-capable CLI
// backend — claude-code (via `--mcp-config`) or grok/cursor (via ACP
// `session/new` mcpServers). codex and API-routed runs are excluded (see
// mcpCapableCli); API runs expose extension tools via the in-process registry.
func (m *Manager) wireToolServer(s *engineSession, key string, opts *types.RunOptions, extGroup *extension.ExtensionGroup) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok {
		return
	}
	if extGroup == nil || extGroup.IsEmpty() {
		return
	}
	extTools := extGroup.Tools()
	if len(extTools) == 0 {
		return
	}
	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()
	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	// Every extension tool is registered in every mode. What a planning
	// session may call is decided when the tool is called, by the plan policy
	// the server consults (ToolServer.SetPlanPolicySource); a set of
	// registered tools that changed with the mode would change the tool list
	// the model's provider caches.
	registered := make([]string, 0, len(extTools))
	for _, tool := range extTools {
		capturedTool := tool
		// Extension tool Execute has no ctx parameter; the MCP request ctx is
		// accepted and ignored here (extension cancellation rides the host's
		// own RPC lifecycle).
		handler := func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
			ctx := m.newExtContext(s, key)
			return capturedTool.Execute(input, ctx)
		}
		ts.RegisterTool(capturedTool.Name, handler, capturedTool.Description, capturedTool.Parameters)
		registered = append(registered, capturedTool.Name)
	}
	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	directive := buildToolAliasDirective(registered, backend.McpServerName)
	appendDirective(opts, directive, registered)

	utils.LogWithFields(utils.LevelInfo, "session", "extension tools registered on ToolServer for cli backend", map[string]any{"count": len(registered), "kind": kind, "started": needsStart})
}

// wireAgentToolServer registers an ion_agent tool on the ToolServer for a
// delegated-CLI backend, so the model can dispatch subagents.
//
// Under HybridBackend, this fires when the model resolves to an MCP-capable CLI
// backend — claude-code or grok/cursor (ACP). codex and API-routed runs are
// excluded (see mcpCapableCli); API runs expose ion_agent via the in-process
// agent spawner path (wired in buildRunConfig).
func (m *Manager) wireAgentToolServer(s *engineSession, key string, opts *types.RunOptions) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok {
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	// Source the description + input schema from the canonical Agent
	// tool definition (engine/internal/tools/agent.go:AgentTool) rather
	// than duplicating them inline. The MCP tool is exposed under the
	// name "ion_agent" (per the CLI backend's MCP server prefix) but
	// its behavior, description, and parameter shape are identical to
	// the API-backend's Agent tool. Routing through tools.AgentTool()
	// keeps the two backends in sync: a future field added to the
	// canonical schema lands on both backends in one place. The
	// pin test prompt_cli_hooks_agent_schema_test.go guards against
	// the canonical schema accidentally dropping a property.
	agentDef := tools.AgentTool()
	ts.RegisterTool("ion_agent", m.buildAgentToolHandler(s, key, opts.Model),
		agentDef.Description,
		agentDef.InputSchema,
	)
	statusDef := tools.AgentStatusTool()
	ts.RegisterTool("ion_agent_status", buildAgentStatusToolHandler(s.dispatchRegistry),
		statusDef.Description,
		statusDef.InputSchema,
	)

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed (agent tool)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed (agent tool)", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	aliasNames := []string{"ion_agent", "ion_agent_status"}
	directive := buildToolAliasDirective(aliasNames, backend.McpServerName)
	appendDirective(opts, directive, aliasNames)

	utils.LogWithFields(utils.LevelInfo, "session", "ion agent tools registered on ToolServer for CLI backend", map[string]any{"kind": kind, "key": key, "count": len(aliasNames)})
}

// wirePlanToolServer registers the engine-owned plan tools on the per-session
// ToolServer for a delegated claude-code run: EnterPlanMode, ExitPlanMode, and
// the WritePlan/EditPlan pair.
//
// All four are registered in every mode, including on a run that is carrying
// out an approved plan. The set of tools a run registers is part of the prompt
// its provider caches, so it must not change with the mode. What a call does
// in the session's current mode is decided by its handler when it is called.
//
// Headless `claude -p` exposes no plan tools of its own that the engine can
// use, so the engine owns the mechanism end to end: the model asks to plan
// with EnterPlanMode, authors the plan with WritePlan/EditPlan (neither takes
// a path, so there is nothing to redirect), and signals that the plan is ready
// with ExitPlanMode.
//
// No-op for every backend but claude-code. The ACP backends (grok/cursor)
// carry their own plan handling.
func (m *Manager) wirePlanToolServer(s *engineSession, key string, opts *types.RunOptions) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok || kind != "claude-code" {
		utils.LogWithFields(utils.LevelDebug, "session", "plan tool wiring skipped (not claude-code)", map[string]any{"key": key, "kind": kind})
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	// The EnterPlanMode handler reads this when it is called: an
	// implementation run refuses a fresh plan-mode entry.
	s.cliImplementationPhase = opts.ImplementationPhase
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	enterDef := tools.EnterPlanModeToolWithDescription(opts.EnterPlanModeDescription)
	ts.RegisterTool(enterDef.Name, enterPlanModeToolHandler(m, key), enterDef.Description, enterDef.InputSchema)

	exitName, exitDesc, exitSchema := backend.CliExitPlanModeTool()
	ts.RegisterTool(exitName, planModeExitToolHandler(m, key), exitDesc, exitSchema)

	planToolNames := m.registerPlanFileTools(ts, key)

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed (plan tools)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed (plan tools)", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	toolNames := append([]string{enterDef.Name, exitName}, planToolNames...)
	directive := buildToolAliasDirective(toolNames, backend.McpServerName)
	appendDirective(opts, directive, toolNames)

	utils.LogWithFields(utils.LevelInfo, "session", "plan tools registered on ToolServer for claude-code", map[string]any{"key": key, "tools": toolNames, "plan_mode": opts.PlanMode, "implementation_phase": opts.ImplementationPhase})
}

// enterPlanModeToolHandler returns the handler for the EnterPlanMode MCP tool
// on a claude-code run. It performs the full decision itself: it calls
// m.RequestPlanModeEnter, which fires before_plan_mode_enter and, when
// allowed, flips session state and allocates or reuses the plan file path,
// exactly as the ApiBackend's interceptEnterPlanMode does through the
// OnPlanModeEnter hook. On allow it emits engine_plan_mode_changed directly, so
// consumers see the transition at once: the normal run pipeline never carries
// this event for a CLI run, because the decision is made here, in the MCP
// round trip.
//
// The tool is registered in every mode, so two calls change nothing: a run
// that is carrying out an approved plan is refused, and a session already
// planning is told so by RequestPlanModeEnter.
//
// No restart happens. The model keeps running in the same subprocess, and the
// read-only boundary applies from its next tool call, because the hook server
// and the ToolServer read the session's plan state on every call.
func enterPlanModeToolHandler(m *Manager, key string) backend.ToolHandler {
	return func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		utils.LogWithFields(utils.LevelInfo, "session", "EnterPlanMode invoked by claude-code model", map[string]any{"key": key})
		m.mu.RLock()
		s, ok := m.sessions[key]
		implementing := ok && s.cliImplementationPhase
		m.mu.RUnlock()
		if implementing {
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EnterPlanMode refused: implementation run", map[string]any{"key": key})
			return &types.ToolResult{Content: "Plan mode is not available: this run is carrying out a plan that was already approved. Continue the implementation."}, nil
		}
		allowed, reason, planFilePath := m.RequestPlanModeEnter(key)
		if !allowed {
			if reason == "" {
				reason = "Plan mode entry was declined."
			}
			utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EnterPlanMode denied for claude-code model", map[string]any{"key": key, "reason": reason})
			return &types.ToolResult{Content: reason, IsError: false}, nil
		}
		m.emit(key, translateToEngineEvent(types.NormalizedEvent{
			Data: &types.PlanModeChangedEvent{
				Enabled:      true,
				PlanFilePath: planFilePath,
				PlanSlug:     types.PlanSlugFromPath(planFilePath),
				Source:       backend.PlanModeSourceModelTool,
			},
		}, 0))
		utils.LogWithFields(utils.LevelInfo, "session.plan_mode", "EnterPlanMode allowed for claude-code model", map[string]any{"key": key, "plan_file_path": planFilePath})

		content := backend.CliPlanModeEnteredResult(planFilePath)
		// The result is what tells the model plan mode is active, so it is
		// also what the conversation records as the enter notice. Without the
		// record a later exit would have nothing to end.
		m.recordCliPlanNotice(key, types.InjectionKindPlanModeEnter, content, planFilePath)
		return &types.ToolResult{Content: content, IsError: false}, nil
	}
}

// planModeExitToolHandler returns the handler for the ExitPlanMode MCP tool.
// The plan itself lives in the session's plan file, authored through
// WritePlan/EditPlan during the turn; when the model instead passes the legacy
// `plan` fallback argument, the backend captures it from the streamed tool_use
// (handlePlanModeAssistant). Either way this handler only acknowledges the call,
// completing the CLI's tool round-trip and telling the model to end its turn.
//
// The tool is registered in every mode. A call from a session that is not
// planning has no plan to present and is told so.
func planModeExitToolHandler(m *Manager, key string) backend.ToolHandler {
	return func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		plan, _ := input["plan"].(string) //nolint:errcheck // absent plan is the normal path; the plan file is the source (handlePlanModeResult)
		planning, _ := m.GetPlanModeState(key)
		utils.LogWithFields(utils.LevelInfo, "session", "ExitPlanMode invoked by claude-code model", map[string]any{"key": key, "planning": planning, "plan_bytes": len(plan), "used_fallback_argument": plan != ""})
		if !planning {
			return &types.ToolResult{
				Content: "Plan mode is not active, so there is no plan to present. Continue with the task.",
				IsError: false,
			}, nil
		}
		return &types.ToolResult{
			Content: "Plan presented for approval. Planning is complete — take no further action and call no more tools.",
			IsError: false,
		}, nil
	}
}

// questionAckToolHandler returns the handler for an engine-owned question tool
// (AskUserQuestion or AskUserQuestions) exposed on the claude-code MCP
// ToolServer. Mirrors planModeExitToolHandler: the question payload is captured
// from the streamed tool_use in the backend (handleQuestionAssistant), so this
// handler only acknowledges the call — completing the CLI's tool round-trip and
// ending the turn so the session idles on the question. It deliberately does NOT
// route through the client-tool router: a blocking wire round-trip would
// resurrect every lifecycle defect the retained-denial park removes.
func questionAckToolHandler(key, toolName string) backend.ToolHandler {
	return func(_ context.Context, _ map[string]interface{}) (*types.ToolResult, error) {
		utils.LogWithFields(utils.LevelInfo, "session", "question tool invoked by claude-code model", map[string]any{"key": key, "tool": toolName})
		return &types.ToolResult{
			Content: "Question sent to the user. The turn ends here — take no further action and call no more tools. The user's answer arrives as the next message.",
			IsError: false,
		}, nil
	}
}

// wireQuestionToolServer registers the engine-owned AskUserQuestion sentinel on
// the per-session ToolServer for a delegated claude-code run, in ALL modes.
// Headless `claude -p` exposes no tool for pausing to ask the operator, so the
// engine owns the mechanism exactly as it owns ExitPlanMode: the model calls the
// MCP-exposed tool, the backend captures the tool_use and records a
// PermissionDenial (handleQuestionAssistant / injectQuestionDenials), and the
// session idles on the question. The multi-question sibling AskUserQuestions is
// a harness-declared client tool, registered through wireClientToolServer with
// the same acknowledging handler.
//
// Scoped to claude-code — the ACP backends (grok/cursor) have no equivalent
// tool_use detection wired yet, so registering the tool there would round-trip
// without ever surfacing the question. Runs AFTER wireAgentToolServer, which has
// already created, started, and attached the ToolServer for a CLI run, so the
// common path only registers one more tool.
func (m *Manager) wireQuestionToolServer(s *engineSession, key string, opts *types.RunOptions) {
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok || kind != "claude-code" {
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	ask := tools.AskUserQuestionTool()
	ts.RegisterTool(ask.Name, questionAckToolHandler(key, ask.Name), ask.Description, ask.InputSchema)

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed (question sentinel)", map[string]any{"key": key, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed (question sentinel)", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	directive := buildToolAliasDirective([]string{ask.Name}, backend.McpServerName)
	appendDirective(opts, directive, []string{ask.Name})

	utils.LogWithFields(utils.LevelInfo, "session", "AskUserQuestion registered on ToolServer for claude-code", map[string]any{"key": key})
}

func buildAgentStatusToolHandler(registry *extcontext.DispatchRegistry) backend.ToolHandler {
	getter := extcontext.AgentStatusGetter(registry)
	return func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		return tools.ExecuteTool(tools.WithAgentStatusGetter(ctx, getter), tools.AgentStatusToolName, input, "")
	}
}

// wireClientToolServer registers the run's client-tool runtime
// (opts.ClientTools / opts.ClientToolRouter, built by buildClientToolRuntime)
// on the per-session ToolServer for MCP-capable delegated-CLI backends, so a
// claude-code or ACP run serves the same client tools an API run gets through
// its RunConfig. codex is excluded here — it consumes opts.ClientTools as
// thread/start dynamicTools inside the codex backend itself.
//
// Runs AFTER wireToolServer / wireAgentToolServer so the extension tools and
// ion_agent hold registration priority: a client tool whose name collides
// with an already-registered tool is skipped (never shadows), matching the
// API adapter's collision rule in wireClientTools.
func (m *Manager) wireClientToolServer(s *engineSession, key string, opts *types.RunOptions) {
	if len(opts.ClientTools) == 0 || opts.ClientToolRouter == nil {
		return
	}
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok {
		return
	}

	m.mu.Lock()
	ts := s.toolServer
	m.mu.Unlock()

	needsStart := false
	if ts == nil {
		ts = backend.NewToolServer(key)
		needsStart = true
	}

	router := opts.ClientToolRouter
	registered := make([]string, 0, len(opts.ClientTools))
	for _, ct := range opts.ClientTools {
		// Human-wait tools (AskUserQuestions and any future structured
		// human-wait tool) END the turn and hand off to the operator. On
		// claude-code the engine owns this exactly as it owns the
		// AskUserQuestion sentinel: register an acknowledging handler and
		// capture the tool_use in the backend to record the retained denial
		// (handleQuestionAssistant / injectQuestionDenials). The blocking
		// client-tool router is NOT used — that would resurrect the wire
		// round-trip the retained-denial park removes.
		if ct.HumanWait {
			if kind == "claude-code" {
				name := ct.Name
				ts.RegisterTool(name, questionAckToolHandler(key, name), ct.Description, ct.InputSchema)
				registered = append(registered, name)
				continue
			}
			// ACP backends (grok/cursor) have no tool_use detection for
			// human-wait tools wired yet, so registering one would round-trip
			// without surfacing the question. Skip until that detection lands.
			utils.LogWithFields(utils.LevelInfo, "session.toolgate", "human-wait client tool skipped on ACP backend (no tool_use detection wired)", map[string]any{
				"key": key, "tool": ct.Name, "kind": kind,
			})
			continue
		}
		if ts.HasTool(ct.Name) {
			utils.LogWithFields(utils.LevelWarn, "session.toolgate", "client tool shadows a ToolServer tool; skipped", map[string]any{
				"key": key, "tool": ct.Name, "kind": kind,
			})
			continue
		}
		name := ct.Name
		ts.RegisterTool(name, func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
			// The router never returns nil and encodes failures as tool
			// errors; the MCP ctx makes teardown cancel a blocked human wait.
			return router(ctx, name, input), nil
		}, ct.Description, ct.InputSchema)
		registered = append(registered, name)
	}
	if len(registered) == 0 {
		if needsStart {
			return // nothing registered on a fresh server: nothing to start
		}
		return
	}

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session.toolgate", "toolserver start failed (client tools)", map[string]any{"key": key, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session.toolgate", "toolserver mcp attach failed (client tools)", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	directive := buildToolAliasDirective(registered, backend.McpServerName)
	appendDirective(opts, directive, registered)

	utils.LogWithFields(utils.LevelInfo, "session.toolgate", "client tools registered on ToolServer for CLI backend", map[string]any{
		"key": key, "kind": kind, "count": len(registered),
	})
}

// buildAgentToolHandler returns the ToolHandler for the delegated-CLI
// ion_agent MCP tool. When the CLI parent's model calls ion_agent, this routes
// through the SAME depth-0 dispatch as the ApiBackend Agent tool
// (buildRootAgentSpawner → extcontext.BuildDispatchAgentFunc), so the
// dispatched agent gets full parity: DispatchRegistry registration,
// engine_agent_state (it appears in the agent panel), dispatch telemetry, its
// own tool server (extension tools + a grandchild-capable ion_agent via
// BuildDelegatedChildToolServer), and spec/persona resolution. Previously this
// path ran a bare synchronous child that surfaced no agent and was
// tool-orphaned — the root-model-called gap this closes.
//
// parentModel is the CLI run's model, used as the child model fallback (matches
// the API spawner's capturedModel). The dispatch honours the call's
// wait_for_completion input: set, the spawner blocks until the child completes
// and returns its output; omitted, the dispatch runs in the background and the
// spawner returns its canonical announcement immediately. The engine delivers
// the terminal result by waking the session, so the turn is free to end.
func (m *Manager) buildAgentToolHandler(s *engineSession, key, parentModel string) backend.ToolHandler {
	spawner := m.buildRootAgentSpawner(s, key, parentModel, s.extGroup, nil, nil)
	return func(ctx context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		prompt, _ := input["prompt"].(string)           //nolint:errcheck // best-effort; failure not actionable here
		name, _ := input["name"].(string)               //nolint:errcheck // best-effort; failure not actionable here
		description, _ := input["description"].(string) //nolint:errcheck // best-effort; failure not actionable here
		model, _ := input["model"].(string)             //nolint:errcheck // best-effort; failure not actionable here

		// Trace entry: the model (inside a delegated-CLI subprocess) invoked the
		// ion_agent MCP tool. If this line is absent for a CLI run, the model
		// never called the tool; the dispatch path (dispatch_agent.go) logs the
		// rest of the lifecycle.
		utils.LogWithFields(utils.LevelInfo, "session.cli_dispatch", "ion_agent tool invoked by CLI model, routing through dispatch", map[string]any{
			"key": key, "agent": name, "has_prompt": prompt != "", "model": model,
		})

		if prompt == "" {
			utils.LogWithFields(utils.LevelWarn, "session.cli_dispatch", "ion_agent invoked with empty prompt, rejecting", map[string]any{"key": key, "agent": name})
			return &types.ToolResult{Content: "error: prompt is required", IsError: true}, nil
		}

		// ctx is the MCP request context (session/server teardown cancels
		// it); the dispatch additionally remains cancellable via the
		// DispatchRegistry (session abort / recall).
		waitForCompletion, _ := input["wait_for_completion"].(bool) //nolint:errcheck // omitted means async
		callCtx := tools.WithAgentWaitForCompletion(ctx, waitForCompletion)
		out, err := spawner(callCtx, name, prompt, description, s.config.WorkingDirectory, model)
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "session.cli_dispatch", "ion_agent dispatch failed", map[string]any{
				"key": key, "agent": name, "error": err.Error(),
			})
			label := "agent"
			if name != "" {
				label = "agent " + name
			}
			return &types.ToolResult{Content: fmt.Sprintf("%s failed: %s", label, err.Error()), IsError: true}, nil
		}
		utils.LogWithFields(utils.LevelInfo, "session.cli_dispatch", "ion_agent dispatch returned", map[string]any{
			"key": key, "agent": name, "result_bytes": len(out), "wait_for_completion": waitForCompletion,
		})
		return &types.ToolResult{Content: out, IsError: false}, nil
	}
}
