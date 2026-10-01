package session

import (
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetConfig installs the engine runtime config and compiles the enterprise
// dangerous-command patterns it carries, so an invalid pattern is reported
// once, when the config is loaded, and every run reuses the compiled set.
func (m *Manager) SetConfig(cfg *types.EngineRuntimeConfig) {
	patterns := compileCommandPatterns(cfg)
	m.mu.Lock()
	defer m.mu.Unlock()
	m.config = cfg
	m.commandPatterns = patterns
}

// compileCommandPatterns compiles the enterprise
// SandboxEnterpriseConfig.AdditionalDangerousPatterns. They are enforced on
// every run under the policy, independent of whether the sandbox is on, so
// they are resolved here rather than in buildSandboxConfig. A pattern that
// does not compile cannot be enforced; it is logged with its expression and
// the compile error and left out.
func compileCommandPatterns(cfg *types.EngineRuntimeConfig) []sandbox.CompiledPattern {
	if cfg == nil || cfg.Enterprise == nil || cfg.Enterprise.Sandbox == nil {
		return nil
	}
	configured := cfg.Enterprise.Sandbox.AdditionalDangerousPatterns
	if len(configured) == 0 {
		return nil
	}
	patterns := make([]sandbox.DangerousPattern, 0, len(configured))
	for _, p := range configured {
		patterns = append(patterns, sandbox.DangerousPattern{Pattern: p.Pattern, Reason: p.Reason})
	}
	compiled, errs := sandbox.CompilePatterns(patterns)
	for _, e := range errs {
		utils.LogWithFields(utils.LevelError, "config.enterprise", "invalid enterprise dangerous command pattern: not enforced", map[string]any{
			"index":   e.Index,
			"pattern": e.Pattern,
			"error":   e.Err.Error(),
		})
	}
	utils.LogWithFields(utils.LevelInfo, "config.enterprise", "enterprise dangerous command patterns loaded", map[string]any{
		"configured": len(configured),
		"enforced":   len(compiled),
		"invalid":    len(errs),
	})
	return compiled
}
