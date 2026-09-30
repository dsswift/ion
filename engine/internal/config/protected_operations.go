package config

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolveProtectedOperations reads the declared protected operations fresh
// from the global layer at call time, with no process-global side effects. A
// fresh read means an operator can add, change, or remove an operation without
// restarting the daemon. A nil or empty result means the surface is
// unavailable.
func ResolveProtectedOperations() map[string]types.ProtectedOperationConfig {
	ops := mergeConfigLayers("").ProtectedOperations
	names := make([]string, 0, len(ops))
	for name := range ops {
		names = append(names, name)
	}
	sort.Strings(names)
	utils.LogWithFields(utils.LevelDebug, "config", "resolved protected operations fresh", map[string]any{
		"count": len(ops), "names": names,
	})
	return ops
}

// dropProjectProtectedOperations removes a project layer's protected
// operations before the merge. The secret a protected operation injects is
// the operator's, so only the operator's own global config may say where it
// goes; a repository's .ion/engine.json must not.
func dropProjectProtectedOperations(project *types.EngineRuntimeConfig, projectDir string) {
	if project == nil || project.ProtectedOperations == nil {
		return
	}
	utils.LogWithFields(utils.LevelWarn, "config", "project protected operations ignored", map[string]any{
		"project_dir": projectDir, "count": len(project.ProtectedOperations),
	})
	project.ProtectedOperations = nil
}

// mergeProtectedOperations carries src's operations onto dst, replacing an
// operation of the same name whole.
func mergeProtectedOperations(dst, src *types.EngineRuntimeConfig) {
	if len(src.ProtectedOperations) == 0 {
		return
	}
	if dst.ProtectedOperations == nil {
		dst.ProtectedOperations = make(map[string]types.ProtectedOperationConfig, len(src.ProtectedOperations))
	}
	for name, op := range src.ProtectedOperations {
		dst.ProtectedOperations[name] = op
	}
}
