package backend

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/tools"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// McpCapableCli reports whether a resolved delegated-CLI backend can consume
// the engine's per-session ToolServer MCP bridge, and under which attach kind:
//
//   - claude-code: per-run `--mcp-config` file (attach kind "claude-code").
//   - grok/cursor (ACP): per-session `session/new` mcpServers (attach kind "acp").
//   - codex: excluded — its shared app-server takes MCP only at process-spawn
//     time, not per session.
//   - ApiBackend: excluded — it exposes tools in-process via RunConfig.
//
// For a HybridBackend, pass the model-resolved inner backend
// (HybridBackend.ResolveFor(model)); the type switch below only recognizes the
// concrete delegated-CLI backends.
func McpCapableCli(b RunBackend) (kind string, ok bool) {
	switch b.(type) {
	case *ClaudeCodeBackend:
		return "claude-code", true
	case *AcpBackend:
		return "acp", true
	default:
		return "", false
	}
}

// AttachToolServerToRunOptions points a delegated-CLI run at a freshly-started
// ToolServer. claude-code reads an MCP config file path (opts.McpConfig); the
// ACP backends take an inline mcpServers spec on session/new
// (opts.CliMcpServers). Must be called exactly once per ToolServer so the ACP
// list never accumulates duplicate entries. kind comes from McpCapableCli.
func AttachToolServerToRunOptions(opts *types.RunOptions, ts *ToolServer, sessionID, kind string) error {
	if kind == "acp" {
		opts.CliMcpServers = append(opts.CliMcpServers, ts.McpServerSpec())
		return nil
	}
	mcpPath, err := ts.McpConfigPath(sessionID)
	if err != nil {
		return err
	}
	opts.McpConfig = mcpPath
	return nil
}

// resolveChildRoute returns the concrete backend a child run will be served by
// for the given model. A child backend produced by NewChild is a HybridBackend
// for hybrid parents; its per-model route decides whether the run lands on a
// delegated CLI. Non-hybrid children are their own route.
func resolveChildRoute(child RunBackend, model string) RunBackend {
	if h, ok := child.(*HybridBackend); ok {
		return h.ResolveFor(model)
	}
	return child
}

// BuildDelegatedChildToolServer wires a per-child ToolServer for a dispatched
// child that will be served by a delegated-CLI backend, so the CLI child gets
// the same ion tools an API child receives through its RunConfig — the
// extension tools (emit_briefing and the rest) and ion_agent (so the child can
// dispatch grandchildren). This closes the gap where a CLI-routed child dropped
// the RunConfig and was left tool-orphaned: unable to dispatch or emit.
//
// The child's tools are sourced from its already-built RunConfig rather than
// re-derived: each cfg.ExternalTools entry routes through cfg.McpToolRouter, and
// ion_agent routes through cfg.AgentSpawner (which BuildChildAgentSpawner wired
// at the child's depth, so a grandchild spawns at depth+1). opts is mutated in
// place with the MCP attach; the returned *ToolServer must be Stopped when the
// child run exits (the caller owns that lifecycle).
//
// Returns (nil, nil) when the child routes to an engine-owned (API) backend —
// that path consumes the RunConfig directly and needs no tool server.
func BuildDelegatedChildToolServer(child RunBackend, sessionID string, cfg *RunConfig, opts *types.RunOptions) (*ToolServer, error) {
	if cfg == nil {
		return nil, nil
	}
	kind, ok := McpCapableCli(resolveChildRoute(child, opts.Model))
	if !ok {
		return nil, nil // API-routed child: RunConfig is consumed directly.
	}

	ts := NewToolServer(sessionID)

	// Extension tools → route through the child's McpToolRouter.
	for _, td := range cfg.ExternalTools {
		name := td.Name
		router := cfg.McpToolRouter
		ts.RegisterTool(name, func(input map[string]interface{}) (*types.ToolResult, error) {
			if router == nil {
				return &types.ToolResult{Content: "tool router unavailable for dispatched CLI child", IsError: true}, nil
			}
			return router(context.Background(), name, input)
		}, td.Description, td.InputSchema)
	}

	// ion_agent → route through the child's AgentSpawner so the child can
	// dispatch grandchildren. Omitted when no spawner is wired (should not
	// happen on the dispatch path, but keep the tool absent rather than broken).
	if cfg.AgentSpawner != nil {
		agentDef := tools.AgentTool()
		spawner := cfg.AgentSpawner
		cwd := opts.ProjectPath
		ts.RegisterTool("ion_agent", func(input map[string]interface{}) (*types.ToolResult, error) {
			prompt, _ := input["prompt"].(string)           //nolint:errcheck // missing arg -> empty string, validated below
			name, _ := input["name"].(string)               //nolint:errcheck // missing arg -> empty string
			description, _ := input["description"].(string) //nolint:errcheck // missing arg -> empty string
			model, _ := input["model"].(string)             //nolint:errcheck // missing arg -> empty string
			if prompt == "" {
				return &types.ToolResult{Content: "error: prompt is required", IsError: true}, nil
			}
			out, err := spawner(context.Background(), name, prompt, description, cwd, model)
			if err != nil {
				return &types.ToolResult{Content: fmt.Sprintf("agent dispatch failed: %s", err.Error()), IsError: true}, nil
			}
			return &types.ToolResult{Content: out}, nil
		}, agentDef.Description, agentDef.InputSchema)
	}

	if err := ts.Start(); err != nil {
		return nil, err
	}
	if err := AttachToolServerToRunOptions(opts, ts, sessionID, kind); err != nil {
		ts.Stop()
		return nil, err
	}

	utils.LogWithFields(utils.LevelInfo, "backend.cli_child_tools", "wired tool server for delegated-CLI child", map[string]any{
		"session_id": sessionID, "kind": kind, "ext_tools": len(cfg.ExternalTools), "ion_agent": cfg.AgentSpawner != nil,
	})
	return ts, nil
}
