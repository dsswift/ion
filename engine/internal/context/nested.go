package context

import (
	"os"
	"path/filepath"
	"strings"
)

// WalkNestedContextDirs discovers instruction files in the directories that
// lie strictly *below* cwd on the path down to targetPath. This is the
// "progressive descent" half of context loading: the eager walk
// (WalkContextFiles) loads cwd → ancestors → home roots once at prompt build,
// and this function loads the per-subtree files (e.g. desktop/AGENTS.md,
// engine/AGENTS.md) that the agent touches as it works below cwd.
//
// Behavior:
//   - cwd and any directory at or above cwd are skipped — those are the eager
//     walk's responsibility, and re-loading them here would double-inject.
//   - targetPath may be a file (Read/Edit/Write/LSP) or a directory
//     (Grep/Glob with a directory path). file-vs-dir is resolved via os.Stat:
//     a directory target contributes itself; a file (or missing) target
//     contributes its containing directory.
//   - Each directory between cwd (exclusive) and the target directory
//     (inclusive) is probed non-recursively for the patterns the config
//     resolves (Ion-native always; Claude-compat only when cfg.ClaudeCompat),
//     honoring the same gate as the eager walk.
//   - Results are ordered cwd → target (shallowest first), matching Claude
//     Code's nested ordering so deeper, more-specific instructions land later
//     (higher attention).
//   - A target outside cwd yields no results: nested loading never ascends
//     above cwd. Ancestor and home-root files are the eager walk's job.
//   - The include directive (cfg.IncludeDirective) is honored per file.
//   - Discovered files carry Source "nested".
//
// The seen map dedups within a single call (the same directory reached by two
// targets in one drain). Cross-turn / conversation-lifetime dedup is the
// caller's responsibility (it tracks already-injected paths).
func WalkNestedContextDirs(cwd, targetPath string, cfg WalkerConfig) []DiscoveredContext {
	absCwd, err := filepath.Abs(cwd)
	if err != nil || absCwd == "" {
		return nil
	}
	absTarget, err := filepath.Abs(targetPath)
	if err != nil || absTarget == "" {
		return nil
	}

	// Resolve the directory the target lives in. A directory target uses
	// itself; a file (or a path that does not exist) uses its parent. We stat
	// once: ENOENT or any stat error falls back to "treat as file", which is
	// the safe default (its parent dir is still a legitimate nested dir).
	targetDir := absTarget
	if info, statErr := os.Stat(absTarget); statErr != nil || !info.IsDir() {
		targetDir = filepath.Dir(absTarget)
	}

	// Build the chain of directories from targetDir up to (but not including)
	// cwd, keeping only directories strictly under cwd. If targetDir is not
	// under cwd, the chain is empty and we return nothing.
	chain := dirChainUnderCwd(absCwd, targetDir)
	if len(chain) == 0 {
		return nil
	}

	patterns := cfg.resolvePatterns()
	seen := make(map[string]bool)
	var results []DiscoveredContext

	for _, dir := range chain {
		for _, pattern := range patterns {
			fp := filepath.Join(dir, pattern)
			if seen[fp] {
				continue
			}
			data, readErr := os.ReadFile(fp)
			if readErr != nil {
				continue
			}
			seen[fp] = true
			content := string(data)
			if cfg.IncludeDirective != "" {
				content = ProcessIncludes(content, filepath.Dir(fp), cfg.IncludeDirective, nil)
			}
			results = append(results, DiscoveredContext{
				Path:    fp,
				Content: content,
				Source:  "nested",
				Level:   0,
			})
		}
	}

	return results
}

// dirChainUnderCwd returns the directories from cwd (exclusive) down to
// targetDir (inclusive), ordered shallowest → deepest, but only when targetDir
// is strictly under cwd. If targetDir equals cwd, is above cwd, or is outside
// the cwd subtree entirely, the result is empty.
//
// Both paths are cleaned first, giving lexical containment (no symlink
// resolution). This mirrors the lexical traversal Claude Code uses (string
// containment under cwd) and avoids surprising escapes via "..".
func dirChainUnderCwd(cwd, targetDir string) []string {
	cwd = filepath.Clean(cwd)
	targetDir = filepath.Clean(targetDir)

	if targetDir == cwd {
		return nil
	}

	// targetDir must be within the cwd subtree. filepath.Rel + an escape check
	// rejects anything that climbs above cwd or sits on another volume.
	rel, err := filepath.Rel(cwd, targetDir)
	if err != nil || rel == "." || rel == "" {
		return nil
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return nil
	}

	// Walk up from targetDir to cwd, collecting each directory strictly under
	// cwd, then reverse to shallowest-first order.
	var chain []string
	dir := targetDir
	for dir != cwd {
		chain = append(chain, dir)
		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached filesystem root without hitting cwd — guarded against by
			// the Rel check above, but break defensively to avoid a loop.
			break
		}
		dir = parent
	}

	// Reverse to cwd → target order.
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain
}
