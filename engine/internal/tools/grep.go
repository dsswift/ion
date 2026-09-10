package tools

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// GrepTool returns a ToolDef that searches file contents. It prefers ripgrep
// (rg), falls back to grep -rn, and finally to an in-process Go search when
// neither binary is on PATH -- which is the case on a stock Windows machine,
// where the tool previously failed outright with
// `exec: "grep": executable file not found in %PATH%`.
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

func executeGrep(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	pattern, _ := input["pattern"].(string) //nolint:errcheck // best-effort; failure not actionable here
	if pattern == "" {
		return &types.ToolResult{Content: "Error: pattern is required", IsError: true}, nil
	}

	searchPath := stringFromInput(input, "path", "")
	glob := stringFromInput(input, "glob", "")
	outputMode := stringFromInput(input, "output_mode", "content")

	// Record the touched search target for read-triggered nested context
	// loading (no-op without an installed sink). An empty path means "search
	// cwd"; recording the resolved cwd yields no nested dirs (nothing is below
	// the root), which is the correct behavior. A relative path resolves
	// against cwd to the directory/file actually searched.
	if searchPath != "" {
		types.RecordTouchedPath(ctx, resolvePath(cwd, searchPath))
	}

	// Bound the search by wall clock so a pathological pattern can't wedge.
	// The user-cancel context still cancels before the deadline.
	cmdCtx, cancel := context.WithTimeout(ctx, globTimeout)
	defer cancel()

	// Prefer ripgrep, then grep, then the in-process search.
	//
	// The native path is last because rg is faster on a large tree and honours
	// .gitignore. It exists so the tool always answers: a machine with neither
	// binary installed is a supported machine, not a broken one.
	if rgPath, rgErr := exec.LookPath("rg"); rgErr == nil {
		return execRipgrep(cmdCtx, rgPath, pattern, searchPath, glob, outputMode, cwd)
	}
	if _, grepErr := exec.LookPath("grep"); grepErr == nil {
		return execGrepFallback(cmdCtx, pattern, searchPath, glob, outputMode, cwd)
	}
	utils.Debug("Grep", "no rg or grep on PATH; using the in-process search")
	return grepNative(cmdCtx, pattern, searchPath, glob, outputMode, cwd)
}

func execRipgrep(ctx context.Context, rgPath, pattern, searchPath, glob, outputMode, cwd string) (*types.ToolResult, error) {
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

	cmd := exec.CommandContext(ctx, rgPath, args...)
	cmd.Dir = cwd

	out, err := cmd.Output()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			if errors.Is(ctxErr, context.DeadlineExceeded) {
				return &types.ToolResult{Content: fmt.Sprintf("Error: Grep exceeded %s deadline.", globTimeout), IsError: true}, nil
			}
			return &types.ToolResult{Content: "Error: Grep cancelled.", IsError: true}, nil
		}
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

func execGrepFallback(ctx context.Context, pattern, searchPath, glob, outputMode, cwd string) (*types.ToolResult, error) {
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

	cmd := exec.CommandContext(ctx, "grep", args...)
	cmd.Dir = cwd

	out, err := cmd.Output()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			if errors.Is(ctxErr, context.DeadlineExceeded) {
				return &types.ToolResult{Content: fmt.Sprintf("Error: Grep exceeded %s deadline.", globTimeout), IsError: true}, nil
			}
			return &types.ToolResult{Content: "Error: Grep cancelled.", IsError: true}, nil
		}
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
