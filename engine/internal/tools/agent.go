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
// AgentSpawner starts a child session. The tool context carries whether this
// particular call explicitly waits for completion.
type AgentSpawner func(ctx context.Context, name, prompt, description, cwd, model string) (string, error)

var agentSpawner AgentSpawner

// SetAgentSpawner configures the global fallback spawner (used by tests).
func SetAgentSpawner(fn AgentSpawner) {
	agentSpawner = fn
}

type agentSpawnerKey struct{}
type agentWaitForCompletionKey struct{}
type dispatchIDKey struct{}

// WithDispatchIDHolder returns a context carrying a *string that the spawner
// populates with the raw dispatch ID for async calls. This lets executeAgent
// read the precise ID without parsing the spawner's display-oriented prose.
func WithDispatchIDHolder(ctx context.Context, holder *string) context.Context {
	return context.WithValue(ctx, dispatchIDKey{}, holder)
}

// SetDispatchID writes a dispatch ID into the holder carried by ctx, if any.
func SetDispatchID(ctx context.Context, id string) {
	if holder, ok := ctx.Value(dispatchIDKey{}).(*string); ok && holder != nil {
		*holder = id
	}
}

// WithAgentWaitForCompletion carries Agent's explicit foreground opt-in to the
// session-scoped spawner without widening the public spawner callback shape.
func WithAgentWaitForCompletion(ctx context.Context, wait bool) context.Context {
	return context.WithValue(ctx, agentWaitForCompletionKey{}, wait)
}

// AgentWaitForCompletion reports whether this Agent tool call requested the
// explicit synchronous result contract.
func AgentWaitForCompletion(ctx context.Context) bool {
	wait, _ := ctx.Value(agentWaitForCompletionKey{}).(bool) //nolint:errcheck // absent means async
	return wait
}

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
		Description: "Dispatch a new child agent asynchronously. Every call creates a new dispatch; use AgentStatus to inspect dispatches that already exist. The call returns its dispatch ID immediately, and the engine delivers the terminal result back to this conversation. Never use Poll to wait for an agent or dispatch. Set wait_for_completion only when this turn must block for the final output.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"prompt":              map[string]any{"type": "string", "description": "The task for the agent to perform"},
				"description":         map[string]any{"type": "string", "description": "A short description of what the agent will do"},
				"model":               map[string]any{"type": "string", "description": "Optional model request. Omit it to inherit the parent. Prefer a configured tier name over a raw model ID, and pick the fastest tier the task allows — mechanical work with clear instructions does not need a premium model. A direct model request is locked to the parent provider; only configured tiers can deliberately select another provider."},
				"wait_for_completion": map[string]any{"type": "boolean", "description": "Wait for terminal child output. Default false: dispatch asynchronously and receive automatic completion delivery."},
				"name":                map[string]any{"type": "string", "description": "Optional specialist agent name (e.g. 'code-reviewer'). If set, the engine resolves the spec from the session's agent registry; the capability_match hook fires when the name is not registered."},
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
	description, _ := input["description"].(string)             //nolint:errcheck // best-effort; failure not actionable here
	model, _ := input["model"].(string)                         //nolint:errcheck // best-effort; failure not actionable here
	name, _ := input["name"].(string)                           //nolint:errcheck // best-effort; failure not actionable here
	waitForCompletion, _ := input["wait_for_completion"].(bool) //nolint:errcheck // absent/non-bool means async
	ctx = WithAgentWaitForCompletion(ctx, waitForCompletion)

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

	// Plant a dispatch-ID holder so the spawner can pass the raw ID back
	// without encoding it into the display prose.
	var dispatchID string
	ctx = WithDispatchIDHolder(ctx, &dispatchID)

	result, err := spawner(ctx, name, prompt, description, cwd, model)
	if err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Agent error: %s", err), IsError: true}, nil
	}

	tr := &types.ToolResult{Content: result}
	if !waitForCompletion && dispatchID != "" {
		tr.BackgroundTaskID = dispatchID
	}
	return tr, nil
}
