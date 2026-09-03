package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/permissions"
	"github.com/dsswift/ion/engine/internal/session/extcontext"
	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// wirePermissionHookServer wires a Permission Hook server for the CLI backend
// so that hook-driven "ask" decisions surface as engine_permission_request
// events to consumers and block the subprocess until the user responds.
//
// Under HybridBackend, this only wires when the model resolves to the
// inner *ClaudeCodeBackend. API-routed hybrid runs use the in-process permission
// engine path (identical to plain "backend": "api").
func (m *Manager) wirePermissionHookServer(s *engineSession, key string, opts *types.RunOptions, permEng *permissions.Engine) {
	if _, isCli := m.resolvedBackend(opts.Model).(*backend.ClaudeCodeBackend); !isCli {
		return
	}
	if permEng == nil {
		return
	}

	hookServer, err := backend.NewPermissionHookServer(permEng)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "session", "permissionhookserver start failed", map[string]any{"key": key, "error": err.Error()})
		return
	}
	token := fmt.Sprintf("run-%d", time.Now().UnixMilli())
	hookServer.RegisterToken(token)

	// Install the human-wait configuration so an unanswered permission dialog
	// waits indefinitely by default (and applies the configured fail-action
	// only when an operator sets a finite human-wait). A nil config yields the
	// indefinite default (the server-side accessors are nil-safe).
	if m.config != nil {
		hookServer.SetTimeouts(m.config.Timeouts)
	}

	// When the hook server gets an "ask" decision, emit
	// engine_permission_request and block until the user responds with an
	// option ID. The same closure serves the codex backend's approvals
	// (see wireCodexPermissions).
	hookServer.SetOnAsk(m.permissionAskClosure(key))

	settingsJSON := hookServer.GenerateSettingsJSON(token)

	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("ion-settings-%s.json", token))
	if err := os.WriteFile(tmpFile, settingsJSON, 0600); err != nil {
		utils.LogWithFields(utils.LevelError, "session", "failed to write hook settings", map[string]any{"key": key, "error": err.Error()})
		hookServer.Close()
		return
	}
	opts.HookSettingsPath = tmpFile
	s.hookSettingsPath = tmpFile
	utils.LogWithFields(utils.LevelInfo, "session", "hook settings written to", map[string]any{"tmp_file": tmpFile})
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
	var b strings.Builder
	b.WriteString("Tool name aliases: when your instructions reference a bare tool name, it is the same tool exposed under the MCP-prefixed name. Use the prefixed name when calling the tool.")
	for _, name := range bareNames {
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
	ts := backend.NewToolServer(key)
	registered := make([]string, 0, len(extTools))
	for _, tool := range extTools {
		// Plan-mode read-only boundary: a delegated claude-code plan run must not
		// be able to call a state-mutating extension tool. The API backend filters
		// these out of its tool defs (buildToolDefs); the CLI equivalent is to NOT
		// register them on the MCP ToolServer at all — an unregistered tool is
		// never advertised over MCP, so this is a hard boundary, not the advisory
		// --allowedTools list (which bypassPermissions ignores). Only plan-safe or
		// explicitly-allowlisted extension tools survive into a plan-mode run.
		if opts.PlanMode {
			prefixed := "mcp__" + backend.McpServerName + "__" + tool.Name
			if !backend.PlanModeExtensionToolAllowed(prefixed, tool.PlanModeSafe, *opts) {
				utils.LogWithFields(utils.LevelInfo, "session", "extension tool withheld from plan-mode CLI ToolServer (not plan-safe)", map[string]any{
					"key": key, "tool": tool.Name,
				})
				continue
			}
		}
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
	if len(registered) == 0 {
		// Every extension tool was withheld (a plan-mode run whose extension
		// exposes only mutating tools). Do not start an empty ToolServer: the
		// plan-mode sentinels (ExitPlanMode, AskUserQuestion, ion_agent) are wired
		// by their own helpers, which create and start the server when it is nil.
		utils.LogWithFields(utils.LevelInfo, "session", "no extension tools registered on CLI ToolServer (all withheld in plan mode)", map[string]any{"key": key, "plan_mode": opts.PlanMode, "kind": kind})
		return
	}
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

	directive := buildToolAliasDirective(registered, backend.McpServerName)
	appendDirective(opts, directive, registered)

	utils.LogWithFields(utils.LevelInfo, "session", "toolserver started for cli backend", map[string]any{"count": len(registered), "kind": kind})
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

// wirePlanModeToolServer registers the engine-owned ExitPlanMode tool on the
// per-session ToolServer for a delegated claude-code plan-mode run, so the
// read-only model can signal that its plan is ready. The CLI's native plan mode
// exposes no ExitPlanMode headlessly, so the engine owns the mechanism end to
// end: buildClaudeArgs spawns read-only (bypassPermissions + --disallowedTools)
// and injects buildCliPlanModePrompt, and this tool carries the finished plan
// back (captured from the streamed tool_use argument in handlePlanModeAssistant).
//
// No-op outside claude-code plan mode. Scoped to claude-code specifically — the
// ACP backends (grok/cursor) carry their own plan handling. Runs AFTER
// wireAgentToolServer, which has already created, started, and attached the
// ToolServer for a CLI run, so the common path only registers one more tool.
func (m *Manager) wirePlanModeToolServer(s *engineSession, key string, opts *types.RunOptions) {
	if !opts.PlanMode {
		return
	}
	kind, ok := mcpCapableCli(m.resolvedBackend(opts.Model))
	if !ok || kind != "claude-code" {
		utils.LogWithFields(utils.LevelDebug, "session", "plan-mode ExitPlanMode wiring skipped (not claude-code)", map[string]any{"key": key, "kind": kind, "plan_mode": opts.PlanMode})
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

	name, desc, schema := backend.CliExitPlanModeTool()
	ts.RegisterTool(name, planModeExitToolHandler(key), desc, schema)

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver start failed (plan mode)", map[string]any{"key": key, "kind": kind, "error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelError, "session", "toolserver mcp attach failed (plan mode)", map[string]any{"key": key, "error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	directive := buildToolAliasDirective([]string{name}, backend.McpServerName)
	appendDirective(opts, directive, []string{name})

	utils.LogWithFields(utils.LevelInfo, "session", "ExitPlanMode registered on ToolServer for claude-code plan mode", map[string]any{"key": key})
}

// planModeExitToolHandler returns the handler for the injected ExitPlanMode MCP
// tool. The plan itself is captured from the streamed tool_use argument in the
// backend (handlePlanModeAssistant), so this handler only acknowledges the call
// — completing the CLI's tool round-trip and telling the model to end its turn.
func planModeExitToolHandler(key string) backend.ToolHandler {
	return func(_ context.Context, input map[string]interface{}) (*types.ToolResult, error) {
		plan, _ := input["plan"].(string) //nolint:errcheck // absent/empty plan handled by the backend capture fallback (handlePlanModeResult)
		utils.LogWithFields(utils.LevelInfo, "session", "ExitPlanMode invoked by claude-code plan-mode model", map[string]any{"key": key, "plan_bytes": len(plan)})
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
// the API spawner's capturedModel). The dispatch is foreground/synchronous: the
// spawner blocks until the child completes, matching the ion_agent tool's
// synchronous result contract.
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
