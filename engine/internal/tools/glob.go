package tools

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/dsswift/ion/engine/internal/types"
)

// GlobTool returns a ToolDef that finds files matching a glob pattern.
// Uses doublestar for ** support.
func GlobTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Glob",
		Description: "Find files matching a glob pattern.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern": map[string]any{"type": "string", "description": "Glob pattern to match (e.g. \"**/*.ts\")"},
				"path":    map[string]any{"type": "string", "description": "Directory to search in"},
			},
			"required": []string{"pattern"},
		},
		Execute: executeGlob,
	}
}

func executeGlob(_ context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	pattern, _ := input["pattern"].(string)
	if pattern == "" {
		return &types.ToolResult{Content: "Error: pattern is required", IsError: true}, nil
	}

	searchDir := stringFromInput(input, "path", cwd)
	if searchDir == "" {
		searchDir = cwd
	}
	if !filepath.IsAbs(searchDir) {
		searchDir = filepath.Join(cwd, searchDir)
	}

	// Combine search dir with pattern for doublestar.
	fullPattern := filepath.Join(searchDir, pattern)

	fsys := os.DirFS("/")
	// doublestar.Glob needs a relative pattern against the fsys root.
	// Since fsys is rooted at "/", strip the leading slash.
	relPattern := strings.TrimPrefix(fullPattern, "/")

	matches, err := doublestar.Glob(fsys, relPattern)
	if err != nil {
		return &types.ToolResult{Content: "Error: " + err.Error(), IsError: true}, nil
	}

	// Filter out node_modules and .git, add leading slash back, cap at 500.
	filtered := make([]string, 0, len(matches))
	for _, m := range matches {
		if strings.Contains(m, "/node_modules/") || strings.Contains(m, "/.git/") {
			continue
		}
		filtered = append(filtered, "/"+m)
	}

	sort.Strings(filtered)
	if len(filtered) > 500 {
		filtered = filtered[:500]
	}

	if len(filtered) == 0 {
		return &types.ToolResult{Content: "(no matches)"}, nil
	}

	return &types.ToolResult{Content: strings.Join(filtered, "\n")}, nil
}
