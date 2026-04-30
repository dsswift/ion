package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
)

// WriteTool returns a ToolDef that writes content to a file, creating directories as needed.
func WriteTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Write",
		Description: "Write content to a file, creating directories as needed.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"file_path": map[string]any{"type": "string", "description": "Absolute path to file"},
				"content":   map[string]any{"type": "string", "description": "Content to write"},
			},
			"required": []string{"file_path", "content"},
		},
		Execute: executeWrite,
	}
}

func executeWrite(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	filePath, _ := input["file_path"].(string)
	if filePath == "" {
		return &types.ToolResult{Content: "Error: file_path is required", IsError: true}, nil
	}
	content, _ := input["content"].(string)

	filePath = resolvePath(cwd, filePath)

	if err := ctx.Err(); err != nil {
		return &types.ToolResult{Content: "Error: Write cancelled.", IsError: true}, nil
	}
	if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error writing file: %s", err), IsError: true}, nil
	}

	if err := os.WriteFile(filePath, []byte(content), 0o644); err != nil {
		return &types.ToolResult{Content: fmt.Sprintf("Error writing file: %s", err), IsError: true}, nil
	}

	return &types.ToolResult{Content: fmt.Sprintf("Successfully wrote to %s", filePath)}, nil
}
