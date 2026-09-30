package config

import (
	"sort"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolveProtectedOperations reads the declared protected operations fresh
// from the global and enterprise layers at call time, with no process-global side effects. A
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

// unionProtectedOperations returns base with overlay's operations laid over
// it by name. Neither input is mutated.
func unionProtectedOperations(base, overlay map[string]types.ProtectedOperationConfig) map[string]types.ProtectedOperationConfig {
	if len(overlay) == 0 {
		return base
	}
	out := make(map[string]types.ProtectedOperationConfig, len(base)+len(overlay))
	for name, op := range base {
		out[name] = op
	}
	for name, op := range overlay {
		out[name] = op
	}
	return out
}

// sealProtectedOperations applies the enterprise's operations over the
// merged config. An enterprise operation replaces a user operation of the
// same name whole, so the organization owns where its secrets go; user
// operations under other names remain.
func sealProtectedOperations(result *types.EngineRuntimeConfig, enterprise *types.EnterpriseConfig) {
	if len(enterprise.ProtectedOperations) == 0 {
		return
	}
	replaced := make([]string, 0)
	for name := range enterprise.ProtectedOperations {
		if _, ok := result.ProtectedOperations[name]; ok {
			replaced = append(replaced, name)
		}
	}
	sort.Strings(replaced)
	result.ProtectedOperations = unionProtectedOperations(result.ProtectedOperations, enterprise.ProtectedOperations)
	utils.LogWithFields(utils.LevelInfo, "config.merge", "enterprise: protected operations applied", map[string]any{
		"count": len(enterprise.ProtectedOperations), "replaced": replaced,
	})
}
