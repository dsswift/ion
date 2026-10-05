package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestEnforceEnterprise_SealsSkillShellExecutionOff(t *testing.T) {
	off := false
	on := true
	cfg := &types.EngineRuntimeConfig{Limits: types.LimitsConfig{DisableSkillShellExecution: &off}}
	got := EnforceEnterprise(cfg, &types.EnterpriseConfig{Limits: &types.EnterpriseLimits{DisableSkillShellExecution: &on}})
	if got.Limits.DisableSkillShellExecution == nil || !*got.Limits.DisableSkillShellExecution {
		t.Fatal("enterprise seal must force skill shell execution off over a lower-layer false")
	}

	free := EnforceEnterprise(cfg, &types.EnterpriseConfig{})
	if free.Limits.DisableSkillShellExecution == nil || *free.Limits.DisableSkillShellExecution {
		t.Fatal("without enterprise policy the lower-layer value stands")
	}
}
