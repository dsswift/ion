package session

import (
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func enterprisePatternConfig(required bool, patterns ...types.DangerousPattern) *types.EngineRuntimeConfig {
	return &types.EngineRuntimeConfig{
		Enterprise: &types.EnterpriseConfig{
			Sandbox: &types.SandboxEnterpriseConfig{Required: required, AdditionalDangerousPatterns: patterns},
		},
	}
}

// TestWirePrincipalRun_CommandPatternsEnforcedWithSandboxOffAndOn pins that
// enterprise dangerous-command patterns reach a run whether or not the sandbox
// is enabled for it.
func TestWirePrincipalRun_CommandPatternsEnforcedWithSandboxOffAndOn(t *testing.T) {
	pattern := types.DangerousPattern{Pattern: `\bsecretcmd\b`, Reason: "secretcmd is forbidden by policy"}

	for name, required := range map[string]bool{"sandbox off": false, "sandbox on": true} {
		t.Run(name, func(t *testing.T) {
			mgr := NewManager(backend.NewApiBackend())
			defer mgr.Shutdown()
			mgr.SetConfig(enterprisePatternConfig(required, pattern))

			runCfg := &backend.RunConfig{}
			mgr.wirePrincipalRun(&engineSession{}, "key", nil, runCfg)

			if (runCfg.SandboxCfg != nil) != required {
				t.Fatalf("SandboxCfg set = %v, want %v", runCfg.SandboxCfg != nil, required)
			}
			matched, hit := sandbox.MatchPatterns("secretcmd --do-it", runCfg.CommandPatterns)
			if !hit {
				t.Fatal("expected the enterprise pattern to be wired onto the run")
			}
			if matched.Reason != pattern.Reason {
				t.Errorf("reason = %q, want %q", matched.Reason, pattern.Reason)
			}
			if runCfg.SandboxCfg != nil && len(runCfg.SandboxCfg.Patterns) != 0 {
				t.Errorf("enterprise patterns must not also ride the sandbox config, got %+v", runCfg.SandboxCfg.Patterns)
			}
		})
	}
}

// TestSetConfig_NoPatternsWiresNone pins the unchanged default: no configured
// patterns means no command check on the run.
func TestSetConfig_NoPatternsWiresNone(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(&types.EngineRuntimeConfig{})

	runCfg := &backend.RunConfig{}
	mgr.wirePrincipalRun(&engineSession{}, "key", nil, runCfg)
	if len(runCfg.CommandPatterns) != 0 || runCfg.SandboxCfg != nil {
		t.Errorf("expected no patterns and no sandbox, got %d patterns, sandbox=%v", len(runCfg.CommandPatterns), runCfg.SandboxCfg != nil)
	}
}

// TestSetConfig_InvalidPatternReportedAtLoad pins that a pattern that does not
// compile is logged at error level with the pattern and the compile error when
// the config is installed, and that the valid patterns beside it still apply.
func TestSetConfig_InvalidPatternReportedAtLoad(t *testing.T) {
	var mu sync.Mutex
	var reported []map[string]any
	utils.SetTestSink(func(level utils.LogLevel, _ string, msg string, fields map[string]any, _, _ string) {
		if level == utils.LevelError && strings.Contains(msg, "invalid enterprise dangerous command pattern") {
			mu.Lock()
			reported = append(reported, fields)
			mu.Unlock()
		}
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })

	mgr := NewManager(backend.NewApiBackend())
	defer mgr.Shutdown()
	mgr.SetConfig(enterprisePatternConfig(false,
		types.DangerousPattern{Pattern: `[invalid`, Reason: "broken"},
		types.DangerousPattern{Pattern: `\bsecretcmd\b`, Reason: "blocked"},
	))

	mu.Lock()
	defer mu.Unlock()
	if len(reported) != 1 {
		t.Fatalf("expected one invalid-pattern report, got %d", len(reported))
	}
	if reported[0]["pattern"] != `[invalid` {
		t.Errorf("reported pattern = %v, want [invalid", reported[0]["pattern"])
	}
	if errText, _ := reported[0]["error"].(string); errText == "" {
		t.Error("expected the compile error in the report")
	}
	if _, hit := sandbox.MatchPatterns("secretcmd", mgr.commandPatterns); !hit {
		t.Error("expected the valid pattern beside the invalid one to still be enforced")
	}
}
