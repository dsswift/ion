package config

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// config_thinking_policy_test.go — the config-layer half of the engine-wide
// operator thinking kill switch. The providers package owns the enforcement
// tests (projection scrub, request-path refusal, default polarity); this file
// owns the layered-config behavior: the JSON round-trip, layer precedence, and
// the one-way enterprise seal.

// TestThinkingPolicyDefaultPermitsThinking pins the out-of-the-box path at the
// config layer: a merged config with no thinkingPolicy block anywhere leaves ThinkingPolicy
// nil, which cmd_serve resolves to "permitted".
//
// This is the config-layer companion to
// TestThinkingPolicyZeroValuePermitsThinking in internal/providers. It fails if
// DefaultConfig ever starts shipping a disabling block, or if the field's
// polarity is inverted such that an absent block must be read as "off".
func TestThinkingPolicyDefaultPermitsThinking(t *testing.T) {
	merged := MergeConfigs(nil, DefaultConfig())

	if merged.ThinkingPolicy != nil {
		t.Fatalf("DefaultConfig must ship NO thinking policy block (got %+v); an engine with no operator opinion must permit thinking", merged.ThinkingPolicy)
	}

	// The exact expression cmd_serve.go uses to install the policy. Pinned here
	// so a change to the field's meaning has to break this line explicitly.
	disabled := merged.ThinkingPolicy != nil && merged.ThinkingPolicy.Disabled
	if disabled {
		t.Fatal("a merged config with no thinkingPolicy block must resolve to thinking PERMITTED")
	}
}

// TestThinkingPolicyFromRawJSON pins the engine.json round-trip through fromMap.
// The struct-based merge test does not cover the JSON-tag path, so a mis-named
// tag would slip past it and an operator's `"thinkingPolicy": {"disabled": true}`
// would be silently ignored — a kill switch that does not kill.
func TestThinkingPolicyFromRawJSON(t *testing.T) {
	tests := []struct {
		name         string
		raw          map[string]any
		wantBlock    bool
		wantDisabled bool
	}{
		{
			name:         "disabled true",
			raw:          map[string]any{"thinkingPolicy": map[string]any{"disabled": true}},
			wantBlock:    true,
			wantDisabled: true,
		},
		{
			// An operator who writes the block but leaves it false has expressed
			// no restriction. Must behave identically to omitting the block.
			name:         "disabled false",
			raw:          map[string]any{"thinkingPolicy": map[string]any{"disabled": false}},
			wantBlock:    true,
			wantDisabled: false,
		},
		{
			name:         "empty block",
			raw:          map[string]any{"thinkingPolicy": map[string]any{}},
			wantBlock:    true,
			wantDisabled: false,
		},
		{
			name:      "block absent",
			raw:       map[string]any{},
			wantBlock: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			layer := fromMap(tc.raw)
			merged := MergeConfigs(nil, DefaultConfig(), layer)

			if !tc.wantBlock {
				if merged.ThinkingPolicy != nil {
					t.Fatalf("ThinkingPolicy = %+v, want nil when engine.json carries no thinkingPolicy block", merged.ThinkingPolicy)
				}
				return
			}
			if merged.ThinkingPolicy == nil {
				t.Fatal("ThinkingPolicy block dropped on the raw-JSON path: an operator's engine.json thinking policy would be silently ignored")
			}
			if merged.ThinkingPolicy.Disabled != tc.wantDisabled {
				t.Errorf("ThinkingPolicy.Disabled = %v, want %v", merged.ThinkingPolicy.Disabled, tc.wantDisabled)
			}
		})
	}
}

// TestThinkingPolicyLayerPrecedence pins that a later (more specific) layer
// decides, in both directions. The project layer being able to disable thinking
// for one repo without touching the user's global default is the point of
// carrying this through the normal merge rather than reading it once globally.
func TestThinkingPolicyLayerPrecedence(t *testing.T) {
	on := &types.EngineRuntimeConfig{ThinkingPolicy: &types.ThinkingPolicyConfig{Disabled: false}}
	off := &types.EngineRuntimeConfig{ThinkingPolicy: &types.ThinkingPolicyConfig{Disabled: true}}
	silent := &types.EngineRuntimeConfig{}

	// Project disables over a permissive global.
	if got := MergeConfigs(nil, DefaultConfig(), on, off); got.ThinkingPolicy == nil || !got.ThinkingPolicy.Disabled {
		t.Errorf("project layer must be able to disable thinking over a permissive global; got %+v", got.ThinkingPolicy)
	}
	// Project re-enables over a restrictive global. There is no policy to
	// circumvent absent an enterprise seal — an unmanaged machine configuring
	// its own tool is the point of the project layer.
	if got := MergeConfigs(nil, DefaultConfig(), off, on); got.ThinkingPolicy == nil || got.ThinkingPolicy.Disabled {
		t.Errorf("project layer must be able to re-enable thinking over a restrictive global; got %+v", got.ThinkingPolicy)
	}
	// A silent later layer leaves the earlier value alone.
	if got := MergeConfigs(nil, DefaultConfig(), off, silent); got.ThinkingPolicy == nil || !got.ThinkingPolicy.Disabled {
		t.Errorf("a layer with no thinkingPolicy block must not clear an earlier layer's policy; got %+v", got.ThinkingPolicy)
	}
}

// TestEnforceEnterpriseSealsThinkingOff pins the one-way seal: an enterprise
// Disabled=true forces thinking off no matter what the user/project layers say.
func TestEnforceEnterpriseSealsThinkingOff(t *testing.T) {
	ent := &types.EnterpriseConfig{Thinking: &types.ThinkingPolicyConfig{Disabled: true}}

	for _, name := range []string{"user permitted explicitly", "user silent"} {
		t.Run(name, func(t *testing.T) {
			cfg := DefaultConfig()
			if name == "user permitted explicitly" {
				cfg.ThinkingPolicy = &types.ThinkingPolicyConfig{Disabled: false}
			}
			got := EnforceEnterprise(cfg, ent)
			if got.ThinkingPolicy == nil || !got.ThinkingPolicy.Disabled {
				t.Fatalf("enterprise thinking disable must seal off: got %+v", got.ThinkingPolicy)
			}
		})
	}
}

// TestEnforceEnterpriseThinkingSealDoesNotMutateInput guards the copy-on-write
// discipline. EnforceEnterprise re-runs on every config resolution; a version
// that mutated the caller's block would let one enforcement pass leak into a
// config another caller still holds.
func TestEnforceEnterpriseThinkingSealDoesNotMutateInput(t *testing.T) {
	cfg := DefaultConfig()
	userBlock := &types.ThinkingPolicyConfig{Disabled: false}
	cfg.ThinkingPolicy = userBlock

	EnforceEnterprise(cfg, &types.EnterpriseConfig{Thinking: &types.ThinkingPolicyConfig{Disabled: true}})

	if userBlock.Disabled {
		t.Error("EnforceEnterprise mutated the caller's ThinkingPolicy block instead of copying it")
	}
}

// TestEnforceEnterpriseThinkingIsCeilingNotMandate pins the OTHER direction of
// the seal, which is the part most likely to be implemented wrong. An
// enterprise block with Disabled=false is not an order to think: it must leave a
// locally-disabled install disabled. Enterprise policy is a ceiling, matching
// ResourceLimits and the plan-mode Bash allowlist — never a mandate that
// overrides a more restrictive lower layer.
func TestEnforceEnterpriseThinkingIsCeilingNotMandate(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ThinkingPolicy = &types.ThinkingPolicyConfig{Disabled: true}

	got := EnforceEnterprise(cfg, &types.EnterpriseConfig{Thinking: &types.ThinkingPolicyConfig{Disabled: false}})

	if got.ThinkingPolicy == nil || !got.ThinkingPolicy.Disabled {
		t.Fatalf("an enterprise thinkingPolicy block with disabled=false must NOT force thinking on over a locally-disabled install; got %+v", got.ThinkingPolicy)
	}
}

// TestEnforceEnterpriseNoThinkingPolicyLeavesMergedValue pins that an
// enterprise config silent on thinking does not touch the merged value in
// either direction.
func TestEnforceEnterpriseNoThinkingPolicyLeavesMergedValue(t *testing.T) {
	cfg := DefaultConfig()
	cfg.ThinkingPolicy = &types.ThinkingPolicyConfig{Disabled: true}
	if got := EnforceEnterprise(cfg, &types.EnterpriseConfig{}); got.ThinkingPolicy == nil || !got.ThinkingPolicy.Disabled {
		t.Errorf("enterprise silent on thinking must leave a disabled merged value disabled; got %+v", got.ThinkingPolicy)
	}

	clean := DefaultConfig()
	if got := EnforceEnterprise(clean, &types.EnterpriseConfig{}); got.ThinkingPolicy != nil {
		t.Errorf("enterprise silent on thinking must leave an absent block absent; got %+v", got.ThinkingPolicy)
	}
}
