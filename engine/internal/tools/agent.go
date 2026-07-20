package tools

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
)

// AgentToolName is the tool name used to identify the Agent tool. Other
// packages use this to special-case Agent execution (e.g. exempting it from
// the standard tool timeout).
const AgentToolName = "Agent"

// AgentSpawner is a function that spawns a child session with the given prompt.
// Wired by the session manager when an API backend is available.
// The ctx parameter carries the parent's cancellation so child agents stop
// when the parent run is interrupted.
//
// `name` is the optional specialist agent name from the LLM's call (e.g.
// "travel-planner"). When non-empty, the spawner resolves it against the
// session's agent spec registry — populated at session start from disk and
// extended at runtime via Context.RegisterAgentSpec — and fires the
// `capability_match` hook before failing if the name is not registered.
type AgentSpawner func(ctx context.Context, name, prompt, description, cwd, model string) (string, error)

var agentSpawner AgentSpawner

// SetAgentSpawner configures the global fallback spawner (used by tests).
func SetAgentSpawner(fn AgentSpawner) {
	agentSpawner = fn
}

type agentSpawnerKey struct{}

// WithAgentSpawner returns a context carrying a session-scoped AgentSpawner.
func WithAgentSpawner(ctx context.Context, fn AgentSpawner) context.Context {
	return context.WithValue(ctx, agentSpawnerKey{}, fn)
}

// AgentSpawnerFromContext extracts a session-scoped spawner, or nil.
func AgentSpawnerFromContext(ctx context.Context) AgentSpawner {
	fn, _ := ctx.Value(agentSpawnerKey{}).(AgentSpawner) //nolint:errcheck // best-effort; failure not actionable here
	return fn
}

// AgentTool returns a ToolDef that launches a new agent to handle complex,
// multi-step tasks autonomously.
func AgentTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        AgentToolName,
		Description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"prompt":      map[string]any{"type": "string", "description": "The task for the agent to perform"},
				"description": map[string]any{"type": "string", "description": "A short description of what the agent will do"},
				"model":       map[string]any{"type": "string", "description": "Optional model override for this agent (e.g. claude-opus-4-6)"},
				"name":        map[string]any{"type": "string", "description": "Optional specialist agent name (e.g. 'code-reviewer'). If set, the engine resolves the spec from the session's agent registry; the capability_match hook fires when the name is not registered."},
			},
			"required": []string{"prompt"},
		},
		Execute: executeAgent,
	}
}

func executeAgent(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	prompt, _ := input["prompt"].(string) //nolint:errcheck // best-effort; failure not actionable here
	if prompt == "" {
		return &types.ToolResult{Content: "Error: prompt is required", IsError: true}, nil
	}
	description, _ := input["description"].(string) //nolint:errcheck // best-effort; failure not actionable here
	model, _ := input["model"].(string)             //nolint:errcheck // best-effort; failure not actionable here
	name, _ := input["name"].(string)               //nolint:errcheck // best-effort; failure not actionable here

	// Prefer session-scoped spawner from context, fall back to global (tests).
	spawner := AgentSpawnerFromContext(ctx)
	if spawner == nil {
		spawner = agentSpawner
	}
	if spawner == nil {
		return &types.ToolResult{
			Content: "Agent tool not available (no API backend configured)",
			IsError: true,
		}, nil
	}

	result, err := spawner(ctx, name, prompt, description, cwd, model)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Agent error: %s", err), IsError: true}, nil
	}

	return &types.ToolResult{Content: result}, nil
}
