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
	}

	// Apply in ascending priority so the highest level wins each field.
	apply(engineConfig)   // level 2
	apply(sessionDefault) // level 3
	apply(perDispatch)    // level 4

	return ResolvedPolicy{
		IncludeGlobalContext:  global,
		IncludeProjectContext: project,
		ClaudeCompat:          compat,
	}
}

// BuildContextPrompt runs WalkContextFiles with the given policy and formats
// the results as a `# Context from <path>` concatenation. Returns the
// formatted string and the list of discovered files (for logging). Returns
// ("", nil) when nothing is found. agentName and cwd are used only for logging.
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

	var sb strings.Builder
	for _, cf := range files {
		sb.WriteString("\n# Context from " + cf.Path + "\n")
		sb.WriteString(cf.Content)
		sb.WriteString("\n")
	}
	return sb.String(), files
}
