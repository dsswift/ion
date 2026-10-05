package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// engine.json limits.disableSkillShellExecution reaches every run's options,
// which is where the Skill tool and the slash path read it.
func TestApplyConfigDefaults_DisableSkillShellExecution(t *testing.T) {
	on := true
	m := NewManager(newMockBackend())
	m.SetConfig(&types.EngineRuntimeConfig{Limits: types.LimitsConfig{DisableSkillShellExecution: &on}})
	var opts types.RunOptions
	m.applyConfigDefaults(&opts)
	if !opts.DisableSkillShellExecution {
		t.Fatal("limits.disableSkillShellExecution did not reach the run")
	}

	m.SetConfig(&types.EngineRuntimeConfig{})
	opts = types.RunOptions{}
	m.applyConfigDefaults(&opts)
	if opts.DisableSkillShellExecution {
		t.Fatal("unset limit must leave shell execution on")
	}
}
