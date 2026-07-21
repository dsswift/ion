package extcontext

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// Tests for D-007: enterprise MaxAgentsPerSession dispatch gate in
// BuildDispatchAgentFunc. The gate must:
//   - reject a new dispatch when the live count meets the ceiling
//   - allow a dispatch when below the ceiling
//   - be unbounded when ResourceLimits is nil or MaxAgentsPerSession is nil
//   - emit an error with the stable "agent dispatch limit reached" prefix

func intPtrAgent(v int) *int { return &v }

// agentLimitSA satisfies SessionAccessor by embedding noopSA for all
// methods the limit guard doesn't call. We only override EngineConfig and
// the identity methods needed by the depth+eligibility guards that fire first.
type agentLimitSA struct {
	noopSA
	cfg *types.EngineRuntimeConfig
}

func (a *agentLimitSA) SessionKey() string                                    { return "limit-test" }
func (a *agentLimitSA) EngineConfig() *types.EngineRuntimeConfig              { return a.cfg }
func (a *agentLimitSA) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string { return "" }
// NewChildBackend must return a real backend so dispatch paths that proceed
// past the guards don't panic on a nil child.
func (a *agentLimitSA) NewChildBackend() backend.RunBackend                   { return backend.NewApiBackend() }

// populateRegistry fills a DispatchRegistry with n placeholder active entries
// (simulating n running dispatched agents) without going through the full
// dispatch path.
func populateRegistry(n int) *DispatchRegistry {
	r := NewDispatchRegistry()
	for i := range n {
		id := "fake-dispatch-" + string(rune('a'+i))
		r.Reserve(id, "fake-agent", "", 1)
	}
	return r
}

// TestDispatchAgentLimit_Rejected asserts that when the live dispatch count
// equals the MaxAgentsPerSession ceiling, a new dispatch is rejected with the
// stable error prefix.
//
// Red-then-green: removing the enterprise agent-count gate added in
// dispatch_agent.go causes this test to fail (the dispatch proceeds past the
// check and errors later trying to start a real backend, not with the
// expected limit message).
func TestDispatchAgentLimit_Rejected(t *testing.T) {
	limit := 2
	sa := &agentLimitSA{
		cfg: &types.EngineRuntimeConfig{
			ResourceLimits: &types.ResourceLimits{
				MaxAgentsPerSession: intPtrAgent(limit),
			},
		},
	}
	// Fill the registry to the limit: 2 active dispatches.
	registry := populateRegistry(limit)

	dispatchFn := BuildDispatchAgentFunc(sa, registry, 0, "")
	_, err := dispatchFn(extension.DispatchAgentOpts{Name: "new-agent", Task: "do work"})
	if err == nil {
		t.Fatal("expected rejection at MaxAgentsPerSession=2 with 2 active, got nil error")
	}
	if !strings.Contains(err.Error(), "agent dispatch limit reached") {
		t.Errorf("error must contain stable prefix 'agent dispatch limit reached', got: %q", err.Error())
	}
}

// TestDispatchAgentLimit_AllowedBelowCeiling asserts that a dispatch is not
// blocked by the limit gate when the live count is below the ceiling.
func TestDispatchAgentLimit_AllowedBelowCeiling(t *testing.T) {
	limit := 3
	sa := &agentLimitSA{
		cfg: &types.EngineRuntimeConfig{
			ResourceLimits: &types.ResourceLimits{
				MaxAgentsPerSession: intPtrAgent(limit),
			},
		},
	}
	// Only 2 active — one slot free.
	registry := populateRegistry(2)

	dispatchFn := BuildDispatchAgentFunc(sa, registry, 0, "")
	_, err := dispatchFn(extension.DispatchAgentOpts{Name: "new-agent", Task: "do work"})
	// The dispatch will fail eventually (no real backend), but NOT with the
	// limit error — it should pass the gate and fail downstream.
	if err != nil && strings.Contains(err.Error(), "agent dispatch limit reached") {
		t.Errorf("dispatch below ceiling should not be blocked by the limit gate, got: %q", err.Error())
	}
}

// TestDispatchAgentLimit_NilLimitsUnbounded asserts that nil ResourceLimits
// and nil MaxAgentsPerSession both result in no limit enforcement.
func TestDispatchAgentLimit_NilLimitsUnbounded(t *testing.T) {
	cases := []struct {
		name string
		cfg  *types.EngineRuntimeConfig
	}{
		{"nil EngineConfig", nil},
		{"nil ResourceLimits", &types.EngineRuntimeConfig{}},
		{"nil MaxAgentsPerSession", &types.EngineRuntimeConfig{
			ResourceLimits: &types.ResourceLimits{},
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sa := &agentLimitSA{cfg: tc.cfg}
			// Pack the registry with many dispatches — none should be blocked.
			registry := populateRegistry(50)
			dispatchFn := BuildDispatchAgentFunc(sa, registry, 0, "")
			_, err := dispatchFn(extension.DispatchAgentOpts{Name: "any-agent", Task: "do work"})
			if err != nil && strings.Contains(err.Error(), "agent dispatch limit reached") {
				t.Errorf("case %q: without MaxAgentsPerSession policy the limit gate must not fire, got: %q", tc.name, err.Error())
			}
		})
	}
}

// TestDispatchAgentLimit_NilRegistry asserts no panic and no limit rejection
// when the registry is nil (sessions constructed without an extension group).
func TestDispatchAgentLimit_NilRegistry(t *testing.T) {
	sa := &agentLimitSA{
		cfg: &types.EngineRuntimeConfig{
			ResourceLimits: &types.ResourceLimits{
				MaxAgentsPerSession: intPtrAgent(1),
			},
		},
	}
	// nil registry — the gate must be skipped entirely (no panic).
	dispatchFn := BuildDispatchAgentFunc(sa, nil, 0, "")
	_, err := dispatchFn(extension.DispatchAgentOpts{Name: "any-agent", Task: "do work"})
	if err != nil && strings.Contains(err.Error(), "agent dispatch limit reached") {
		t.Errorf("nil registry must not trigger the limit gate, got: %q", err.Error())
	}
}

// TestDispatchAgentLimit_ErrorMessagePrefix pins the stable prefix the desktop
// matches on. Ceiling=0 means any non-nil registry triggers immediate rejection.
//
// Red-then-green: changing the prefix in dispatch_agent.go causes this test
// to fail; the desktop's engine-slice.ts must also be updated in lock-step
// when the prefix changes.
func TestDispatchAgentLimit_ErrorMessagePrefix(t *testing.T) {
	sa := &agentLimitSA{
		cfg: &types.EngineRuntimeConfig{
			ResourceLimits: &types.ResourceLimits{
				MaxAgentsPerSession: intPtrAgent(0),
			},
		},
	}
	// Even an empty registry triggers the gate when the ceiling is 0.
	registry := NewDispatchRegistry()
	dispatchFn := BuildDispatchAgentFunc(sa, registry, 0, "")
	_, err := dispatchFn(extension.DispatchAgentOpts{Name: "any-agent", Task: "work"})
	if err == nil {
		t.Fatal("expected rejection at MaxAgentsPerSession=0")
	}
	const wantPrefix = "agent dispatch limit reached"
	if !strings.Contains(err.Error(), wantPrefix) {
		t.Errorf("error message must contain stable prefix %q for desktop matching, got: %q", wantPrefix, err.Error())
	}
}
