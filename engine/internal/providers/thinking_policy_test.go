package providers

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// thinking_policy_test.go — tests for the engine-wide operator thinking kill
// switch (thinking_policy.go).
//
// The property these tests exist to protect is the DEFAULT POLARITY: the zero
// value must mean "thinking permitted". Every install that predates this switch
// has no policy block, so a flipped default would silently disable reasoning
// everywhere while the field still looked additive and safe. That is the
// regression most likely to be introduced later by someone renaming Disabled to
// Enabled "for readability".

// restoreThinkingPolicy resets the package-global policy after a test mutates
// it. The policy is process-global (an atomic, per the SetStreamIdleTimeout
// precedent), so a test that leaves it disabled would poison every later test in
// the package.
func restoreThinkingPolicy(t *testing.T) {
	t.Helper()
	prev := thinkingDisabled.Load()
	t.Cleanup(func() { thinkingDisabled.Store(prev) })
}

// TestThinkingPolicyZeroValuePermitsThinking pins the default polarity at the
// storage layer. It reads the atomic's zero value directly rather than going
// through a setter, because the property under test is precisely "what happens
// when nothing ever installed a policy" — a fresh install, an embedding
// consumer that never calls SetThinkingDisabled, a unit test that constructs a
// provider directly.
//
// THIS TEST FAILS IF THE DEFAULT POLARITY IS EVER FLIPPED. If someone renames
// the config field from `Disabled` to `Enabled` and inverts the storage, the
// zero value becomes "thinking off" and this assertion goes red. Do not "fix"
// it by installing a policy first; fix the polarity.
func TestThinkingPolicyZeroValuePermitsThinking(t *testing.T) {
	restoreThinkingPolicy(t)

	// Simulate a never-configured engine by restoring the zero value.
	thinkingDisabled.Store(false)

	if !ThinkingPermitted() {
		t.Fatal("zero-value thinking policy must PERMIT thinking: an install with no engine.json thinking block, or an embedder that never calls SetThinkingDisabled, must behave exactly as it did before the switch existed")
	}

	// The zero value of the config struct must agree with the zero value of the
	// storage. This is the half that catches an inverted config field even when
	// the atomic's polarity is untouched.
	var zeroCfg types.ThinkingPolicyConfig
	if zeroCfg.Disabled {
		t.Fatal("types.ThinkingPolicyConfig zero value must mean thinking ENABLED (Disabled=false); a field whose zero value disables thinking breaks every existing install")
	}

	// And the exact wiring cmd_serve uses: a nil block must resolve to
	// permitted. This is the line that would break if the daemon's install call
	// were ever rewritten to pass the field's negation.
	var nilBlock *types.ThinkingPolicyConfig
	SetThinkingDisabled(nilBlock != nil && nilBlock.Disabled)
	if !ThinkingPermitted() {
		t.Fatal("a nil Thinking config block must resolve to thinking PERMITTED")
	}
}

// TestThinkingPolicyEmptyJSONBlockPermitsThinking pins the polarity through the
// JSON layer. An operator who writes `"thinking": {}` has expressed no opinion,
// and must get working thinking — the same result as omitting the block.
func TestThinkingPolicyEmptyJSONBlockPermitsThinking(t *testing.T) {
	restoreThinkingPolicy(t)

	for _, raw := range []string{`{}`, `{"disabled":false}`} {
		var cfg types.ThinkingPolicyConfig
		if err := unmarshalThinkingPolicy(raw, &cfg); err != nil {
			t.Fatalf("unmarshal %s: %v", raw, err)
		}
		SetThinkingDisabled(cfg.Disabled)
		if !ThinkingPermitted() {
			t.Fatalf("engine.json thinking block %s must permit thinking", raw)
		}
	}

	var cfg types.ThinkingPolicyConfig
	if err := unmarshalThinkingPolicy(`{"disabled":true}`, &cfg); err != nil {
		t.Fatalf("unmarshal disabled:true: %v", err)
	}
	SetThinkingDisabled(cfg.Disabled)
	if ThinkingPermitted() {
		t.Fatal(`engine.json thinking block {"disabled":true} must disable thinking`)
	}
}

// TestListModelsProjectsEffortsWhenPolicyUnset is the out-of-the-box path: with
// no policy installed, every model projects its declared reasoning capability
// exactly as before. This is the assertion that fails if the projection scrub
// ever runs on the default path.
func TestListModelsProjectsEffortsWhenPolicyUnset(t *testing.T) {
	restoreThinkingPolicy(t)
	thinkingDisabled.Store(false)

	const id = "policy-test-adaptive"
	RegisterModel(id, types.ModelInfo{
		ProviderID:       "anthropic",
		SupportsThinking: true,
		ThinkingMode:     "adaptive",
		ThinkingEfforts:  []string{"low", "medium", "high"},
	})
	t.Cleanup(func() { UnregisterModel(id) })

	got := findModelEntry(t, id)
	if got.ThinkingMode != "adaptive" {
		t.Errorf("thinkingMode = %q, want \"adaptive\" (policy unset must not scrub capability)", got.ThinkingMode)
	}
	if len(got.ThinkingEfforts) != 3 {
		t.Errorf("thinkingEfforts = %v, want 3 declared levels", got.ThinkingEfforts)
	}
	if !got.SupportsThinking {
		t.Error("supportsThinking = false, want true when policy is unset")
	}
}

// TestListModelsWithholdsEffortsWhenDisabled is the disabled path: models
// project NO reasoning capability, which is what carries the operator's
// decision to consumers over the existing per-model projection instead of a new
// wire field.
func TestListModelsWithholdsEffortsWhenDisabled(t *testing.T) {
	restoreThinkingPolicy(t)

	const id = "policy-test-disabled"
	RegisterModel(id, types.ModelInfo{
		ProviderID:       "anthropic",
		SupportsThinking: true,
		ThinkingMode:     "adaptive",
		ThinkingEfforts:  []string{"low", "medium", "high"},
	})
	t.Cleanup(func() { UnregisterModel(id) })

	SetThinkingDisabled(true)

	got := findModelEntry(t, id)
	if got.ThinkingMode != "" {
		t.Errorf("thinkingMode = %q, want empty: leaving \"adaptive\" on the wire asserts an active reasoning floor that does not exist on a disabled install", got.ThinkingMode)
	}
	if len(got.ThinkingEfforts) != 0 {
		t.Errorf("thinkingEfforts = %v, want none when the operator disabled thinking", got.ThinkingEfforts)
	}
	if got.SupportsThinking {
		t.Error("supportsThinking = true, want false when the operator disabled thinking")
	}
	// The rest of the entry must be untouched — the policy withholds reasoning
	// capability, it does not hide the model.
	if got.ID != id || got.ProviderID != "anthropic" {
		t.Errorf("entry identity altered: id=%q provider=%q", got.ID, got.ProviderID)
	}
}

// TestResolveThinkingRefusesWhenDisabled pins that the operator switch outranks
// the per-run config on the REQUEST path: a consumer sending Enabled+Effort
// still gets no directive.
func TestResolveThinkingRefusesWhenDisabled(t *testing.T) {
	restoreThinkingPolicy(t)
	registerThinkingTestModels()

	cfg := &types.ThinkingConfig{Enabled: true, Effort: "high"}

	thinkingDisabled.Store(false)
	for _, model := range []string{"test-adaptive", "test-reasoning", "test-gemini", "test-budget"} {
		if res := resolveThinking(model, cfg); res.Mode == "none" {
			t.Fatalf("policy unset: resolveThinking(%q) = none, want a directive on the out-of-the-box path", model)
		}
	}

	SetThinkingDisabled(true)
	for _, model := range []string{"test-adaptive", "test-reasoning", "test-gemini", "test-budget"} {
		res := resolveThinking(model, cfg)
		if res.Mode != "none" {
			t.Errorf("policy disabled: resolveThinking(%q) = %q, want \"none\": the operator switch outranks a per-run Enabled:true", model, res.Mode)
		}
		if res.Effort != "" || res.Budget != 0 {
			t.Errorf("policy disabled: resolveThinking(%q) leaked effort=%q budget=%d", model, res.Effort, res.Budget)
		}
	}
}

// TestAnthropicAdaptiveSelfEngagedDirectiveWithheldWhenDisabled covers the one
// thinking directive NOT governed by resolveThinking's return value: the
// display-only adaptive directive anthropic.go emits under Mode=="none" when the
// consumer sent no thinking config at all. Without its own guard, an adaptive
// model would keep reasoning on a disabled install — the projection would say
// "no thinking" while the provider request still asked for it.
func TestAnthropicAdaptiveSelfEngagedDirectiveWithheldWhenDisabled(t *testing.T) {
	restoreThinkingPolicy(t)
	registerThinkingTestModels()

	p := &anthropicProvider{}
	opts := types.LlmStreamOptions{
		Model: "test-adaptive",
		// Deliberately NO Thinking config: this is the self-engaged path.
	}

	thinkingDisabled.Store(false)
	if _, ok := p.buildRequestBody(opts)["thinking"]; !ok {
		t.Fatal("policy unset: adaptive model must still receive the display-only thinking directive (pre-existing behavior)")
	}

	SetThinkingDisabled(true)
	if v, ok := p.buildRequestBody(opts)["thinking"]; ok {
		t.Errorf("policy disabled: adaptive self-engaged directive still sent (%v); the model would keep reasoning while list_models reports it cannot", v)
	}
}

/* ─── helpers ─── */

// findModelEntry pulls one entry out of the ListModels projection.
func findModelEntry(t *testing.T, id string) types.ModelEntry {
	t.Helper()
	for _, e := range ListModels() {
		if e.ID == id {
			return e
		}
	}
	t.Fatalf("model %q missing from ListModels()", id)
	return types.ModelEntry{}
}

// unmarshalThinkingPolicy decodes an engine.json `thinkingPolicy` block. Wrapped in a
// helper so the JSON-layer polarity tests read as assertions about the config
// contract rather than about encoding/json.
func unmarshalThinkingPolicy(raw string, out *types.ThinkingPolicyConfig) error {
	return json.Unmarshal([]byte(raw), out)
}
