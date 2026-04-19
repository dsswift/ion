package tools

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
)

// AgentSpawner is a function that spawns a child session with the given prompt.
// Wired by the session manager when an API backend is available.
type AgentSpawner func(prompt string, cwd string) (string, error)

var agentSpawner AgentSpawner

// SetAgentSpawner configures the function that the Agent tool uses to spawn
// child sessions.
func SetAgentSpawner(fn AgentSpawner) {
	agentSpawner = fn
}

// AgentTool returns a ToolDef that launches a new agent to handle complex,
// multi-step tasks autonomously.
func AgentTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Agent",
		Description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"prompt":      map[string]any{"type": "string", "description": "The task for the agent to perform"},
				"description": map[string]any{"type": "string", "description": "A short description of what the agent will do"},
			},
			"required": []string{"prompt"},
		},
		Execute: executeAgent,
	}
}

func executeAgent(_ context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	prompt, _ := input["prompt"].(string)
	if prompt == "" {
		return &types.ToolResult{Content: "Error: prompt is required", IsError: true}, nil
	}

	if agentSpawner == nil {
		return &types.ToolResult{
			Content: "Agent tool not available (no API backend configured)",
			IsError: true,
		}, nil
	}

	result, err := agentSpawner(prompt, cwd)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Agent error: %s", err), IsError: true}, nil
	}

	return &types.ToolResult{Content: result}, nil
}
