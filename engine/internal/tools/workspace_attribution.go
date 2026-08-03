package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
	"github.com/dsswift/ion/engine/internal/workspaces"
)

const WorkspaceAttributionName = "WorkspaceAttribution"

// WorkspaceAttributionTool returns the read-only bench provenance tool. It is
// safe in plan mode because attribution runs only git queries and registry reads.
func WorkspaceAttributionTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        WorkspaceAttributionName,
		Description: "Attribute a file or inclusive line range in the current integration bench to its source branch, enabled member worktree(s), or recorded merge resolution. Returns every candidate and warning; never edits files.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file":    map[string]any{"type": "string", "description": "Absolute or bench-relative file path"},
				"line":    map[string]any{"type": "integer", "minimum": 1, "description": "Optional 1-based starting line"},
				"endLine": map[string]any{"type": "integer", "minimum": 1, "description": "Optional inclusive ending line; requires line"},
			},
			"required": []string{"file"},
		},
		PlanModeSafe: true,
		Execute:      executeWorkspaceAttribution,
	}
}

func executeWorkspaceAttribution(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	file, ok := input["file"].(string)
	if !ok || file == "" {
		return workspaceAttributionError("file is required"), nil
	}
	line, err := optionalPositiveInt(input, "line")
	if err != nil {
		return workspaceAttributionError(err.Error()), nil
	}
	endLine, err := optionalPositiveInt(input, "endLine")
	if err != nil {
		return workspaceAttributionError(err.Error()), nil
	}
	if endLine > 0 && line == 0 {
		return workspaceAttributionError("endLine requires line"), nil
	}
	if endLine > 0 && endLine < line {
		return workspaceAttributionError("endLine must be greater than or equal to line"), nil
	}

	utils.LogWithFields(utils.LevelInfo, "tools.workspace_attribution", "workspace attribution started", map[string]any{
		"cwd": cwd, "file": file, "line": line, "end_line": endLine,
	})
	result := workspaces.SharedChecker().Attribute(ctx, workspaces.AttributionRequest{
		BenchPath: cwd,
		Path:      file,
		StartLine: line,
		EndLine:   endLine,
	})
	raw, marshalErr := json.Marshal(result)
	if marshalErr != nil {
		utils.LogWithFields(utils.LevelError, "tools.workspace_attribution", "workspace attribution result serialization failed", map[string]any{
			"cwd": cwd, "file": file, "error": marshalErr.Error(),
		})
		return nil, fmt.Errorf("marshal workspace attribution result: %w", marshalErr)
	}
	if result.Rejection != "" {
		utils.LogWithFields(utils.LevelWarn, "tools.workspace_attribution", "workspace attribution rejected", map[string]any{
			"cwd": cwd, "file": file, "reason": result.Rejection,
		})
		return &types.ToolResult{Content: string(raw), IsError: true}, nil
	}
	utils.LogWithFields(utils.LevelInfo, "tools.workspace_attribution", "workspace attribution completed", map[string]any{
		"cwd": cwd, "file": file, "outcome": string(result.Outcome), "candidate_count": len(result.Candidates), "warning_count": len(result.Warnings), "error_count": len(result.Errors),
	})
	return &types.ToolResult{Content: string(raw)}, nil
}

func optionalPositiveInt(input map[string]any, key string) (int, error) {
	value, exists := input[key]
	if !exists || value == nil {
		return 0, nil
	}
	var n int
	switch typed := value.(type) {
	case int:
		n = typed
	case float64:
		if typed != float64(int(typed)) {
			return 0, fmt.Errorf("%s must be an integer", key)
		}
		n = int(typed)
	default:
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if n < 1 {
		return 0, fmt.Errorf("%s must be 1 or greater", key)
	}
	return n, nil
}

func workspaceAttributionError(message string) *types.ToolResult {
	utils.LogWithFields(utils.LevelWarn, "tools.workspace_attribution", "workspace attribution input rejected", map[string]any{"reason": message})
	return &types.ToolResult{Content: "Error: " + message, IsError: true}
}
