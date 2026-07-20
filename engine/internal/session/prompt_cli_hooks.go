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
		utils.LogWithFields(utils.LevelInfo, "session", "permissionhookserver start failed", map[string]any{"error": err.Error()})
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
		utils.LogWithFields(utils.LevelInfo, "session", "failed to write hook settings", map[string]any{"error": err.Error()})
		hookServer.Close()
		return
	}
	opts.HookSettingsPath = tmpFile
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
	for _, tool := range extTools {
		capturedTool := tool
		handler := func(input map[string]interface{}) (*types.ToolResult, error) {
			ctx := m.newExtContext(s, key)
			return capturedTool.Execute(input, ctx)
		}
		ts.RegisterTool(capturedTool.Name, handler, capturedTool.Description, capturedTool.Parameters)
	}
	if err := ts.Start(); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "toolserver start failed", map[string]any{"error": err.Error()})
		return
	}
	if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
		utils.LogWithFields(utils.LevelInfo, "session", "toolserver mcp attach failed", map[string]any{"error": err.Error(), "kind": kind})
		ts.Stop()
		return
	}
	m.mu.Lock()
	s.toolServer = ts
	m.mu.Unlock()

	bareNames := make([]string, len(extTools))
	for i, t := range extTools {
		bareNames[i] = t.Name
	}
	directive := buildToolAliasDirective(bareNames, backend.McpServerName)
	appendDirective(opts, directive, bareNames)

	utils.LogWithFields(utils.LevelInfo, "session", "toolserver started for cli backend", map[string]any{"count": len(extTools), "kind": kind})
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

	if needsStart {
		if err := ts.Start(); err != nil {
			utils.LogWithFields(utils.LevelInfo, "session", "toolserver start failed (agent tool)", map[string]any{"error": err.Error()})
			return
		}
		if err := m.attachToolServerMcp(opts, ts, key, kind); err != nil {
			utils.LogWithFields(utils.LevelInfo, "session", "toolserver mcp attach failed (agent tool)", map[string]any{"error": err.Error(), "kind": kind})
			ts.Stop()
			return
		}
		m.mu.Lock()
		s.toolServer = ts
		m.mu.Unlock()
	}

	aliasNames := []string{"ion_agent"}
	directive := buildToolAliasDirective(aliasNames, backend.McpServerName)
	appendDirective(opts, directive, aliasNames)

	utils.LogWithFields(utils.LevelInfo, "session", "ion_agent tool registered on ToolServer for CLI backend", map[string]any{"kind": kind, "key": key})
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
	spawner := m.buildRootAgentSpawner(s, key, parentModel, s.extGroup)
	return func(input map[string]interface{}) (*types.ToolResult, error) {
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

		// The ToolHandler signature carries no context; the dispatch is
		// cancellable via the DispatchRegistry (session abort / recall), so a
		// background context here is correct.
		out, err := spawner(context.Background(), name, prompt, description, s.config.WorkingDirectory, model)
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
		utils.LogWithFields(utils.LevelInfo, "session.cli_dispatch", "ion_agent dispatch completed", map[string]any{
			"key": key, "agent": name, "result_bytes": len(out),
		})
		return &types.ToolResult{Content: out, IsError: false}, nil
	}
}
