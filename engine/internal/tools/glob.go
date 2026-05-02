package tools

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/dsswift/ion/engine/internal/types"
)

const (
	maxGlobMatches = 10000
	globTimeout    = 60 * time.Second
)

// GlobTool returns a ToolDef that finds files matching a glob pattern.
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

// executeGlob walks files matching the pattern. The walk is anchored to
// searchDir, honors the run's context (kills the ripgrep subprocess on
// cancel), enforces a 60s wall-clock deadline, and caps results at
// maxGlobMatches. If ripgrep is not on PATH, falls back to a context-aware
// doublestar walk.
func executeGlob(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
	pattern, _ := input["pattern"].(string)
	if pattern == "" {
		return &types.ToolResult{Content: "Error: pattern is required", IsError: true}, nil
	}

	searchDir := resolveSearchDir(input, cwd)

	// If pattern is absolute, split into static base + relative pattern so the
	// walk is anchored as tightly as possible. (Mirrors Claude Code's
	// extractGlobBaseDirectory.)
	if filepath.IsAbs(pattern) {
		baseDir, relPattern := extractGlobBase(pattern)
		if baseDir != "" {
			searchDir = filepath.Clean(baseDir)
			pattern = relPattern
		}
	}

	// Bound the walk by wall clock, regardless of caller ctx.
	walkCtx, cancel := context.WithTimeout(ctx, globTimeout)
	defer cancel()

	matches, truncated, err := globWithRipgrep(walkCtx, searchDir, pattern)
	if err != nil && errors.Is(err, errRipgrepUnavailable) {
		matches, truncated, err = globWithDoublestar(walkCtx, searchDir, pattern)
	}
	if err != nil {
		// Surface ctx errors as a normal tool result so the LLM sees the
		// timeout/cancel rather than crashing the run loop.
		if errors.Is(err, context.DeadlineExceeded) {
			return &types.ToolResult{
				Content: fmt.Sprintf("Error: Glob exceeded %s deadline (pattern=%q under %q). Narrow the pattern or path.", globTimeout, pattern, searchDir),
				IsError: true,
			}, nil
		}
		if errors.Is(err, context.Canceled) {
			return &types.ToolResult{Content: "Error: Glob cancelled.", IsError: true}, nil
		}
		return &types.ToolResult{Content: "Error: " + err.Error(), IsError: true}, nil
	}

	sort.Strings(matches)

	if len(matches) == 0 {
		return &types.ToolResult{Content: "(no matches)"}, nil
	}

	out := strings.Join(matches, "\n")
	if truncated {
		out += fmt.Sprintf("\n(truncated at %d results; use a more specific path or pattern)", maxGlobMatches)
	}
	return &types.ToolResult{Content: out}, nil
}

// resolveSearchDir resolves the input "path" argument to an absolute directory.
// Relative paths are resolved against cwd.
func resolveSearchDir(input map[string]any, cwd string) string {
	searchDir := stringFromInput(input, "path", cwd)
	if searchDir == "" {
		searchDir = cwd
	}
	if !filepath.IsAbs(searchDir) {
		searchDir = filepath.Join(cwd, searchDir)
	}
	return filepath.Clean(searchDir)
}

// extractGlobBase splits an absolute pattern into the longest static prefix
// (used as the walk root) and the remaining pattern. Mirrors Claude Code's
// utility of the same intent.
func extractGlobBase(pattern string) (baseDir, relPattern string) {
	idx := strings.IndexAny(pattern, "*?[{")
	if idx < 0 {
		return filepath.Dir(pattern), filepath.Base(pattern)
	}
	staticPrefix := pattern[:idx]
	lastSep := strings.LastIndex(staticPrefix, string(filepath.Separator))
	if lastSep < 0 {
		return "", pattern
	}
	baseDir = staticPrefix[:lastSep]
	if baseDir == "" {
		baseDir = string(filepath.Separator)
	}
	relPattern = pattern[lastSep+1:]
	return baseDir, relPattern
}

var errRipgrepUnavailable = errors.New("ripgrep not available")

// globWithRipgrep runs `rg --files --glob <pattern>` rooted at searchDir.
// Streams stdout, kills the subprocess at maxGlobMatches. Honors ctx.
func globWithRipgrep(ctx context.Context, searchDir, pattern string) ([]string, bool, error) {
	rgPath, err := exec.LookPath("rg")
	if err != nil {
		return nil, false, errRipgrepUnavailable
	}

	args := []string{
		"--files",
		"--glob", pattern,
		"--hidden",      // include dotfiles
		"--color=never", // never emit ANSI codes
		// .gitignore/.ignore honored by default. node_modules and other
		// vendor dirs are typically gitignored, so this is the natural way
		// to prune them.
	}

	cmd := exec.CommandContext(ctx, rgPath, args...)
	cmd.Dir = searchDir

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, false, fmt.Errorf("ripgrep stdout pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, false, fmt.Errorf("ripgrep start: %w", err)
	}

	matches := make([]string, 0, 128)
	truncated := false
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		// ripgrep returns paths relative to searchDir; promote to absolute so
		// downstream consumers (LLM / desktop) see canonical paths.
		matches = append(matches, filepath.Join(searchDir, line))
		if len(matches) >= maxGlobMatches {
			truncated = true
			// Kill the subprocess promptly to avoid wasting work.
			_ = cmd.Process.Kill()
			break
		}
	}
	// Drain any remaining output to allow the subprocess to exit cleanly.
	_ = scanner.Err()
	waitErr := cmd.Wait()

	if ctxErr := ctx.Err(); ctxErr != nil {
		return matches, truncated, ctxErr
	}
	if waitErr != nil && !truncated {
		// Exit code 1 from ripgrep with --files just means no files; treat as
		// empty rather than error.
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) && exitErr.ExitCode() == 1 {
			return matches, truncated, nil
		}
		// If we killed the process for truncation, ignore the resulting error.
		if !truncated {
			return matches, truncated, fmt.Errorf("ripgrep: %w", waitErr)
		}
	}
	return matches, truncated, nil
}

// globWithDoublestar is the fallback walker for systems without ripgrep. It
// honors ctx by checking ctx.Err() on every directory entry.
func globWithDoublestar(ctx context.Context, searchDir, pattern string) ([]string, bool, error) {
	matches := make([]string, 0, 128)
	truncated := false
	fsys := os.DirFS(searchDir)
	walkErr := doublestar.GlobWalk(fsys, pattern, func(path string, d fs.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Skip the noisiest dirs explicitly since fallback can't read .gitignore.
		if strings.Contains(path, "/node_modules/") || strings.Contains(path, "/.git/") || strings.HasPrefix(path, "node_modules/") || strings.HasPrefix(path, ".git/") {
			return nil
		}
		matches = append(matches, filepath.Join(searchDir, path))
		if len(matches) >= maxGlobMatches {
			truncated = true
			return errStopWalk
		}
		return nil
	})
	if walkErr != nil && !errors.Is(walkErr, errStopWalk) {
		if errors.Is(walkErr, context.Canceled) || errors.Is(walkErr, context.DeadlineExceeded) {
			return matches, truncated, walkErr
		}
		return nil, false, walkErr
	}
	return matches, truncated, nil
}

// errStopWalk is a sentinel returned from the GlobWalk callback to stop the
// walk early once we hit the result cap.
var errStopWalk = errors.New("stop walk")
