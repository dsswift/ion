package context

import (
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolvedPolicy is the effective context policy after cascade merge. All
// fields are concrete (non-pointer): resolution always produces a definite
// true/false from the tri-state inputs.
type ResolvedPolicy struct {
	IncludeGlobalContext  bool
	IncludeProjectContext bool
	ClaudeCompat          bool
	// MaxContextBytes caps the total content bytes injected. Zero or negative
	// means unlimited. See types.DispatchContextConfig.MaxContextBytes.
	MaxContextBytes int
}

// ResolvePolicy merges the four cascade levels into a concrete policy.
// Priority: perDispatch > sessionDefault > engineConfig > built-in (all on).
// The engineDefaultCompat is the engine's session-level ClaudeCompat setting;
// it seeds the compat field before any explicit override is applied.
//
// Each level is a *types.DispatchContextConfig with tri-state pointer fields:
// a nil pointer field means "inherit from the level below" (i.e. leave the
// running value untouched). A non-nil field overrides.
func ResolvePolicy(
	perDispatch *types.DispatchContextConfig, // level 4 (may be nil)
	sessionDefault *types.DispatchContextConfig, // level 3 (may be nil)
	engineConfig *types.DispatchContextConfig, // level 2 (may be nil)
	engineDefaultCompat bool, // engine session-level ClaudeCompat
) ResolvedPolicy {
	// Built-in defaults (level 1): everything on. Compat seeds from the engine.
	global := true
	project := true
	compat := engineDefaultCompat
	maxBytes := 0

	apply := func(cfg *types.DispatchContextConfig) {
		if cfg == nil {
			return
		}
		if cfg.IncludeGlobalContext != nil {
			global = *cfg.IncludeGlobalContext
		}
		if cfg.IncludeProjectContext != nil {
			project = *cfg.IncludeProjectContext
		}
		if cfg.ClaudeCompat != nil {
			compat = *cfg.ClaudeCompat
		}
		// MaxContextBytes is a plain int rather than a pointer, so "not set"
		// and "explicitly zero" are the same value — and both mean unlimited.
		// Only a positive value overrides, which keeps a lower level's budget
		// from being silently erased by a higher level that never mentioned it.
		if cfg.MaxContextBytes > 0 {
			maxBytes = cfg.MaxContextBytes
		}
	}

	// Apply in ascending priority so the highest level wins each field.
	apply(engineConfig)   // level 2
	apply(sessionDefault) // level 3
	apply(perDispatch)    // level 4

	return ResolvedPolicy{
		IncludeGlobalContext:  global,
		IncludeProjectContext: project,
		ClaudeCompat:          compat,
		MaxContextBytes:       maxBytes,
	}
}

// BuildContextPrompt runs WalkContextFiles with the given policy and formats
// the results as a `# Context from <path>` concatenation. Returns the
// formatted string and the list of files actually included (for logging).
// Returns ("", nil) when nothing is found. agentName and cwd are used only for
// logging.
//
// When policy.MaxContextBytes is positive, files are included WHOLE, in walk
// order (nearest-first: cwd, then ancestors, then home roots), until the next
// file would exceed the budget. Remaining files are skipped and each is logged
// by name. A file is never cut mid-content: a partial instruction file is worse
// than an absent one, because the agent cannot tell which rules it is missing
// and proceeds with confident partial knowledge. The returned file list
// reflects what was included, so the caller's byte accounting stays truthful.
func BuildContextPrompt(cwd, agentName string, policy ResolvedPolicy) (string, []DiscoveredContext) {
	if cwd == "" {
		utils.LogWithFields(utils.LevelInfo, "context.policy", "build context prompt skipped empty cwd", map[string]any{"model": agentName})
		return "", nil
	}

	cfg := IonPreset()
	cfg.ClaudeCompat = policy.ClaudeCompat
	cfg.IncludeHomeRoots = policy.IncludeGlobalContext

	if !policy.IncludeProjectContext {
		// Suppress the project walk: no ancestor recursion and no project root
		// (including the implicit cwd fallback). Only the home roots (when
		// enabled) are probed.
		cfg.RecurseParents = false
		cfg.SuppressProjectRoots = true
	}

	files := WalkContextFiles(cwd, cfg)
	if len(files) == 0 {
		return "", nil
	}

	files = applyContextBudget(files, policy.MaxContextBytes, cwd, agentName)
	if len(files) == 0 {
		return "", nil
	}

	var sb strings.Builder
	for _, cf := range files {
		sb.WriteString("\n# Context from " + cf.Path + "\n")
		sb.WriteString(cf.Content)
		sb.WriteString("\n")
	}
	return sb.String(), files
}

// applyContextBudget trims a discovered-file list to fit maxBytes, including
// whole files in walk order. Returns files unchanged when maxBytes <= 0.
//
// Every skip is logged by name and size. A silently dropped instruction file is
// the kind of invisible behavior change that makes an agent's later mistake
// impossible to explain, so the log has to name what was withheld and why.
func applyContextBudget(files []DiscoveredContext, maxBytes int, cwd, agentName string) []DiscoveredContext {
	if maxBytes <= 0 {
		return files
	}

	total := 0
	for _, cf := range files {
		total += len(cf.Content)
	}
	if total <= maxBytes {
		utils.LogWithFields(utils.LevelDebug, "context.policy", "context budget within limit", map[string]any{
			"model": agentName, "path": cwd, "total_bytes": total, "max_bytes": maxBytes, "count": len(files),
		})
		return files
	}

	kept := make([]DiscoveredContext, 0, len(files))
	skipped := make([]string, 0, len(files))
	used := 0
	skippedBytes := 0
	for _, cf := range files {
		size := len(cf.Content)
		// Strictly whole-file: a file that does not fit is skipped entirely,
		// and later (outer, less specific) files are still considered — a small
		// nearby file should not be lost because one large global file came
		// first in the remaining budget.
		if used+size > maxBytes {
			skipped = append(skipped, cf.Path)
			skippedBytes += size
			continue
		}
		kept = append(kept, cf)
		used += size
	}

	utils.LogWithFields(utils.LevelWarn, "context.policy", "context budget exceeded; whole files skipped", map[string]any{
		"model": agentName, "path": cwd,
		"max_bytes": maxBytes, "original_bytes": total, "kept_bytes": used,
		"skipped_bytes": skippedBytes, "kept_count": len(kept),
		"skipped_count": len(skipped), "skipped_paths": skipped,
	})
	return kept
}
