package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// ExitPlanModeName is the tool name used to identify the exit-plan-mode sentinel.
const ExitPlanModeName = "ExitPlanMode"

// ExitPlanModeTool is a sentinel tool injected during plan mode that lets the LLM
// signal "I'm ready to present my plan." The engine intercepts calls to this tool
// before execution (see api_backend.go), records a PermissionDenial, and terminates
// the run gracefully so the desktop can surface the plan for user approval.
func ExitPlanModeTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        ExitPlanModeName,
		Description: "Signal that you have finished planning and are ready to present your plan for approval. Call this tool only when your plan is complete.",
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
			"required":   []string{},
		},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			// This should never be called directly — api_backend intercepts ExitPlanMode
			// before executeTools reaches this point.
			return &types.ToolResult{
				Content: "Plan mode exit intercepted.",
				IsError: false,
			}, nil
		},
	}
}
