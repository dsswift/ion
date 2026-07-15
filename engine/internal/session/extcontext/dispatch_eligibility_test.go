package extcontext

import (
	"context"
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// eligibilityTestAccessor is a minimal SessionAccessor for unit-testing
// checkDispatchEligibility. Only SessionKey and EngineConfig carry behavior;
// every other method is an inert stub (the eligibility guard never calls them).
type eligibilityTestAccessor struct {
	noopPluginMethods
	cfg *types.EngineRuntimeConfig
}

func (a *eligibilityTestAccessor) SessionKey() string                       { return "elig-test-session" }
func (a *eligibilityTestAccessor) ExtensionName() string    { return "" }
func (a *eligibilityTestAccessor) ExtensionVersion() string { return "" }
func (a *eligibilityTestAccessor) EngineConfig() *types.EngineRuntimeConfig { return a.cfg }
func (a *eligibilityTestAccessor) ClaudeCompat() bool { return false }
func (a *eligibilityTestAccessor) GetDispatchContextDefaults() *extension.ContextPolicy { return nil }

func (a *eligibilityTestAccessor) ConversationID() string                          { return "" }
func (a *eligibilityTestAccessor) WorkingDirectory() string                        { return "/tmp" }
func (a *eligibilityTestAccessor) Emit(_ types.EngineEvent)                         {}
func (a *eligibilityTestAccessor) SendAbort()                                       {}
func (a *eligibilityTestAccessor) RootContext() context.Context                     { return context.Background() }
func (a *eligibilityTestAccessor) SendPrompt(_, _ string, _ []string) error         { return nil }
func (a *eligibilityTestAccessor) SteerSelfMainLoop(_ string) bool                  { return false }
func (a *eligibilityTestAccessor) Elicit(_ extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	return nil, false, nil
}
func (a *eligibilityTestAccessor) SuppressTool(_ string)                          {}
func (a *eligibilityTestAccessor) CacheExtAgentStates(_ []types.AgentStateUpdate) {}
func (a *eligibilityTestAccessor) RegisterAgent(_ string, _ types.AgentHandle)    {}
func (a *eligibilityTestAccessor) DeregisterAgent(_ string)                       {}
func (a *eligibilityTestAccessor) RegisterAgentSpec(_ types.AgentSpec)            {}
func (a *eligibilityTestAccessor) DeregisterAgentSpec(_ string)                   {}
func (a *eligibilityTestAccessor) LookupAgentSpec(_ string) (types.AgentSpec, bool) {
	return types.AgentSpec{}, false
}
func (a *eligibilityTestAccessor) LookupExtDisplayName(_ string) string     { return "" }
func (a *eligibilityTestAccessor) ExtGroup() *extension.ExtensionGroup      { return nil }
func (a *eligibilityTestAccessor) ExtConfig() *extension.ExtensionConfig    { return nil }
func (a *eligibilityTestAccessor) ProcRegistry() *extension.ProcessRegistry { return nil }
func (a *eligibilityTestAccessor) NewChildBackend() backend.RunBackend      { return nil }
func (a *eligibilityTestAccessor) AllocatePlanFilePath() string             { return "/tmp/.ion/plans/plan.md" }
func (a *eligibilityTestAccessor) BumpParentProgress()                      {}
func (a *eligibilityTestAccessor) EmitDispatchCountStatus(_ string)         {}
func (a *eligibilityTestAccessor) ResolveTier(_ string) string              { return "" }
func (a *eligibilityTestAccessor) PermissionCheck(_ string, _ map[string]interface{}) (string, string) {
	return "", ""
}
func (a *eligibilityTestAccessor) McpConnections() []*mcp.Connection                      { return nil }
func (a *eligibilityTestAccessor) SearchHistory(_ string, _ int) []extension.HistoryMatch { return nil }
func (a *eligibilityTestAccessor) GetSessionMemory() string                               { return "" }
func (a *eligibilityTestAccessor) SetSessionMemory(_ string)                              {}
func (a *eligibilityTestAccessor) TranslateEvent(_ types.NormalizedEvent, _ int) types.EngineEvent {
	return types.EngineEvent{}
}
func (a *eligibilityTestAccessor) SetPlanMode(_ bool, _ string)                            {}
func (a *eligibilityTestAccessor) GetPlanModeState() (bool, string)                        { return false, "" }
func (a *eligibilityTestAccessor) AppendOrUpdateAgentState(_ types.AgentStateUpdate) string { return "" }
func (a *eligibilityTestAccessor) UpdateAgentStateByID(_ string, _ func(*types.AgentStateUpdate)) {
}
func (a *eligibilityTestAccessor) EmitAgentSnapshot(_ string)                  {}
func (a *eligibilityTestAccessor) ResourceBroker() *resource.Broker            { return nil }
func (a *eligibilityTestAccessor) GlobalResourceBroker() *resource.Broker      { return nil }
func (a *eligibilityTestAccessor) BroadcastNotification(_ types.NotifyOpts)    {}
func (a *eligibilityTestAccessor) BroadcastIntercept(_ extension.InterceptOpts) {}
func (a *eligibilityTestAccessor) ListAllSessions() []extension.SessionListEntry { return nil }
func (a *eligibilityTestAccessor) SendToSession(_, _, _ string, _ map[string]interface{}) error {
	return nil
}

func (a *eligibilityTestAccessor) FireSchedule(_, _ string) error { return nil }
func (a *eligibilityTestAccessor) GetScheduleStatus(_, _ string) ([]extension.ScheduleStatusEntry, error) {
	return nil, nil
}
func (a *eligibilityTestAccessor) RunOnceCheck(_ string, _ int64) (bool, string) { return true, "" }
func (a *eligibilityTestAccessor) RunOnceComplete(_ string, _ bool)              {}
func (a *eligibilityTestAccessor) Telemetry() *telemetry.Collector { return nil }

// registerDispatcher records a depth-1 dispatch named name with id in the
// registry so NameForID resolves the dispatcher's own name in the guard.
func registerDispatcher(r *DispatchRegistry, id, name string) {
	r.RegisterWithID(id, name, func() {}, nil, "elig-test-session", "", 1)
}

// registerDispatcherWithAllowlist records a dispatcher and its carry-forward
// AllowedSubAgents (the agents it is permitted to dispatch in turn).
func registerDispatcherWithAllowlist(r *DispatchRegistry, id, name string, allowed []string) {
	registerDispatcher(r, id, name)
	r.SetAllowedSubAgents(id, allowed)
}

// TestEligibility_SelfDispatchBlocked is the regression pin for the reported
// bug: a dispatched dev-lead dispatching another dev-lead. With the dispatcher
// registered under its own name, checkDispatchEligibility must return
// ErrSelfDispatch. Reverting the self-rail turns this red (the dispatch would
// be allowed).
func TestEligibility_SelfDispatchBlocked(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1782826410296-a60564c08c12"
	registerDispatcher(r, dispatcherID, "dev-lead")
	sa := &eligibilityTestAccessor{}

	err := checkDispatchEligibility(sa, r, dispatcherID, "dev-lead")
	if !errors.Is(err, ErrSelfDispatch) {
		t.Fatalf("expected ErrSelfDispatch, got %v", err)
	}
}

// TestEligibility_SelfDispatchCaseInsensitiveTrimmed verifies the self-rail
// normalizes names (case-insensitive, trimmed) so "Dev-Lead" / " dev-lead "
// are still recognized as the dispatcher's own name.
func TestEligibility_SelfDispatchCaseInsensitiveTrimmed(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1-x"
	registerDispatcher(r, dispatcherID, "dev-lead")
	sa := &eligibilityTestAccessor{}

	for _, name := range []string{"Dev-Lead", " dev-lead ", "DEV-LEAD"} {
		if err := checkDispatchEligibility(sa, r, dispatcherID, name); !errors.Is(err, ErrSelfDispatch) {
			t.Errorf("name %q: expected ErrSelfDispatch, got %v", name, err)
		}
	}
}

// TestEligibility_DifferentAgentAllowed confirms no false positive: a dev-lead
// with engine-dev in its allowlist dispatching engine-dev is allowed.
func TestEligibility_DifferentAgentAllowed(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1-y"
	registerDispatcherWithAllowlist(r, dispatcherID, "dev-lead", []string{"engine-dev", "desktop-dev"})
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "engine-dev"); err != nil {
		t.Fatalf("expected dev-lead -> engine-dev to be allowed, got %v", err)
	}
}

// TestEligibility_OrchestratorExempt verifies the depth-0 orchestrator
// (empty currentDispatchId) is never subject to the self-rail OR the allowlist.
// This is the regression pin for conversation 1782840520215: the orchestrator
// dispatching a top-tier lead must be allowed even though that lead is not in
// any allowlist (the orchestrator has no dispatcher entry, so nothing scopes
// it). Reverting the depth-0 short-circuit turns this red.
func TestEligibility_OrchestratorExempt(t *testing.T) {
	r := NewDispatchRegistry()
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, "", "dev-lead"); err != nil {
		t.Fatalf("orchestrator dispatch should be exempt, got %v", err)
	}
}

// TestEligibility_AllowlistEnforced verifies the dispatcher's carry-forward
// allowlist: a name outside the DISPATCHER's allowlist is rejected; a member is
// allowed. The allowlist is recorded on the dispatcher (dev-lead) and resolved
// from currentDispatchId, NOT supplied per call.
func TestEligibility_AllowlistEnforced(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1-z"
	registerDispatcherWithAllowlist(r, dispatcherID, "dev-lead", []string{"engine-dev", "desktop-dev"})
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "qa-lead"); !errors.Is(err, ErrSubAgentNotAllowed) {
		t.Fatalf("expected ErrSubAgentNotAllowed for qa-lead, got %v", err)
	}
	if err := checkDispatchEligibility(sa, r, dispatcherID, "engine-dev"); err != nil {
		t.Fatalf("expected engine-dev (in allowlist) to be allowed, got %v", err)
	}
}

// TestEligibility_AllowlistInertWhenEmpty verifies a dispatcher with an
// empty/nil allowlist imposes no restriction on its nested dispatches (only the
// self-rail applies).
func TestEligibility_AllowlistInertWhenEmpty(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1-w"
	registerDispatcher(r, dispatcherID, "dev-lead") // no allowlist set
	sa := &eligibilityTestAccessor{}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "any-agent"); err != nil {
		t.Fatalf("empty allowlist should impose no restriction, got %v", err)
	}
}

// TestEligibility_ConfigEscapeHatch verifies AllowSelfDispatch=true disables
// the self-rail so a dev-lead -> dev-lead dispatch is allowed.
func TestEligibility_ConfigEscapeHatch(t *testing.T) {
	r := NewDispatchRegistry()
	const dispatcherID = "dispatch-dev-lead-1-esc"
	registerDispatcher(r, dispatcherID, "dev-lead")
	sa := &eligibilityTestAccessor{cfg: &types.EngineRuntimeConfig{AllowSelfDispatch: true}}

	if err := checkDispatchEligibility(sa, r, dispatcherID, "dev-lead"); err != nil {
		t.Fatalf("AllowSelfDispatch=true should permit self-dispatch, got %v", err)
	}
}

// TestEligibility_RegistryMissFailsOpen verifies a non-empty currentDispatchId
// that is not in the registry does NOT block the dispatch (fail-open on the
// lookup miss; neither the self-name compare nor the allowlist can run).
func TestEligibility_RegistryMissFailsOpen(t *testing.T) {
	r := NewDispatchRegistry()
	sa := &eligibilityTestAccessor{}

	// dispatcherID is not registered.
	if err := checkDispatchEligibility(sa, r, "dispatch-unknown-1", "dev-lead"); err != nil {
		t.Fatalf("registry miss should fail open, got %v", err)
	}
}

// TestEligibility_AllowlistCarriesForward is the integration-level pin for the
// carry-forward semantics that fix conversation 1782840520215. The orchestrator
// dispatches dev-lead (no constraint on the orchestrator). dev-lead's dispatch
// records its children as its allowlist. When dev-lead later dispatches
// engine-dev (in its children) it is allowed; when it dispatches qa-lead (not
// its child) it is blocked. Crucially, the call that SPAWNED dev-lead never
// required dev-lead to be in its own children list (the original bug).
func TestEligibility_AllowlistCarriesForward(t *testing.T) {
	r := NewDispatchRegistry()
	sa := &eligibilityTestAccessor{}

	// 1. Orchestrator dispatches dev-lead -> allowed (no dispatcher entry).
	if err := checkDispatchEligibility(sa, r, "", "dev-lead"); err != nil {
		t.Fatalf("orchestrator -> dev-lead must be allowed, got %v", err)
	}

	// 2. dev-lead's dispatch is registered with its children as the allowlist.
	const devLeadID = "dispatch-dev-lead-carry-1"
	registerDispatcherWithAllowlist(r, devLeadID, "dev-lead", []string{"engine-dev", "desktop-dev"})

	// 3. dev-lead dispatches engine-dev (its child) -> allowed.
	if err := checkDispatchEligibility(sa, r, devLeadID, "engine-dev"); err != nil {
		t.Fatalf("dev-lead -> engine-dev (its child) must be allowed, got %v", err)
	}

	// 4. dev-lead dispatches qa-lead (NOT its child) -> blocked.
	if err := checkDispatchEligibility(sa, r, devLeadID, "qa-lead"); !errors.Is(err, ErrSubAgentNotAllowed) {
		t.Fatalf("dev-lead -> qa-lead (not its child) must be blocked, got %v", err)
	}
}

// TestNameForID verifies the registry accessor used by the self-rail.
func TestNameForID(t *testing.T) {
	r := NewDispatchRegistry()
	registerDispatcher(r, "dispatch-x-1", "engine-dev")

	if name, ok := r.NameForID("dispatch-x-1"); !ok || name != "engine-dev" {
		t.Fatalf("NameForID(dispatch-x-1) = (%q, %v), want (engine-dev, true)", name, ok)
	}
	if name, ok := r.NameForID("nope"); ok || name != "" {
		t.Fatalf("NameForID(nope) = (%q, %v), want (\"\", false)", name, ok)
	}
}

// TestAllowedSubAgentsForID verifies the registry allowlist setter/accessor.
func TestAllowedSubAgentsForID(t *testing.T) {
	r := NewDispatchRegistry()
	registerDispatcher(r, "dispatch-a-1", "dev-lead")

	// Registered with no allowlist -> (nil, true): exists, no restriction.
	if list, ok := r.AllowedSubAgentsForID("dispatch-a-1"); !ok || len(list) != 0 {
		t.Fatalf("AllowedSubAgentsForID(no-set) = (%v, %v), want (empty, true)", list, ok)
	}

	// After SetAllowedSubAgents the list is returned.
	r.SetAllowedSubAgents("dispatch-a-1", []string{"engine-dev", "desktop-dev"})
	list, ok := r.AllowedSubAgentsForID("dispatch-a-1")
	if !ok {
		t.Fatal("expected dispatch-a-1 to be found")
	}
	if len(list) != 2 || list[0] != "engine-dev" || list[1] != "desktop-dev" {
		t.Fatalf("AllowedSubAgentsForID = %v, want [engine-dev desktop-dev]", list)
	}

	// Unknown id -> (nil, false).
	if list, ok := r.AllowedSubAgentsForID("nope"); ok || list != nil {
		t.Fatalf("AllowedSubAgentsForID(nope) = (%v, %v), want (nil, false)", list, ok)
	}

	// SetAllowedSubAgents on an unknown id is a no-op (does not panic / create).
	r.SetAllowedSubAgents("ghost", []string{"x"})
	if _, ok := r.AllowedSubAgentsForID("ghost"); ok {
		t.Fatal("SetAllowedSubAgents on unknown id should not create an entry")
	}
}
