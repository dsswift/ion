package tools

import (
	"context"
	"fmt"
	"os/exec"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// GrepTool returns a ToolDef that searches file contents using ripgrep (rg),
// falling back to grep -rn if rg is not available.
func GrepTool() *types.ToolDef {
	return &types.ToolDef{
		Name:        "Grep",
		Description: "Search file contents using ripgrep.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"pattern":     map[string]any{"type": "string", "description": "Regex pattern to search for"},
				"path":        map[string]any{"type": "string", "description": "Directory or file to search in"},
				"glob":        map[string]any{"type": "string", "description": "Glob pattern to filter files (e.g. \"*.ts\")"},
				"output_mode": map[string]any{"type": "string", "enum": []string{"content", "files_with_matches", "count"}, "description": "Output mode"},
			},
			"required": []string{"pattern"},
		},
		Execute: executeGrep,
	}
}

func executeGrep(_ context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	pattern, _ := input["pattern"].(string)
	if pattern == "" {
		return &types.ToolResult{Content: "Error: pattern is required", IsError: true}, nil
	}

	searchPath := stringFromInput(input, "path", "")
	glob := stringFromInput(input, "glob", "")
	outputMode := stringFromInput(input, "output_mode", "content")

	// Try ripgrep first, fall back to grep.
	rgPath, rgErr := exec.LookPath("rg")
	if rgErr == nil {
		return execRipgrep(rgPath, pattern, searchPath, glob, outputMode, cwd)
	}
	return execGrepFallback(pattern, searchPath, glob, outputMode, cwd)
}

func execRipgrep(rgPath, pattern, searchPath, glob, outputMode, cwd string) (*types.ToolResult, error) {
	args := []string{"--no-heading"}

	switch outputMode {
	case "files_with_matches":
		args = append(args, "-l")
	case "count":
		args = append(args, "-c")
	default:
		args = append(args, "-n")
	}

	if glob != "" {
		args = append(args, "--glob", glob)
	}

	args = append(args, "--", pattern)
	if searchPath != "" {
		args = append(args, searchPath)
	}

	cmd := exec.Command(rgPath, args...)
	cmd.Dir = cwd

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			// rg returns exit code 1 for "no matches"
			if exitErr.ExitCode() == 1 {
				return &types.ToolResult{Content: "(no matches)"}, nil
			}
		}
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	result := strings.TrimSpace(string(out))
	if result == "" {
		result = "(no matches)"
	}
	return &types.ToolResult{Content: result}, nil
}

func execGrepFallback(pattern, searchPath, glob, outputMode, cwd string) (*types.ToolResult, error) {
	// -E enables extended regex so patterns like foo[0-9]+bar work the same
	// way they do under ripgrep.
	args := []string{"-rEn"}

	switch outputMode {
	case "files_with_matches":
		args = []string{"-rEl"}
	case "count":
		args = []string{"-rEc"}
	}

	if glob != "" {
		args = append(args, "--include="+glob)
	}

	args = append(args, "--", pattern)
	if searchPath != "" {
		args = append(args, searchPath)
	} else {
		args = append(args, ".")
	}

	cmd := exec.Command("grep", args...)
	cmd.Dir = cwd

	out, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok && exitErr.ExitCode() == 1 {
			return &types.ToolResult{Content: "(no matches)"}, nil
		}
		return &types.ToolResult{Content: fmt.Sprintf("Error: %s", err), IsError: true}, nil
	}

	result := strings.TrimSpace(string(out))
	if result == "" {
		result = "(no matches)"
	}
	return &types.ToolResult{Content: result}, nil
}
