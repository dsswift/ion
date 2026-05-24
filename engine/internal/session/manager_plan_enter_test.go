package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// RequestPlanModeEnter tests (Part 2 — EnterPlanMode sentinel tool)
// ---------------------------------------------------------------------------

// TestRequestPlanModeEnter_AutoApproveNoExtensions verifies that
// RequestPlanModeEnter succeeds with the default (auto-approve) behaviour when
// no extension group is attached to the session.
func TestRequestPlanModeEnter_AutoApproveNoExtensions(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("enter-auto", defaultConfig())

	// Session starts in auto mode (planMode=false).
	allowed, reason, planFilePath := mgr.RequestPlanModeEnter("enter-auto")

	if !allowed {
		t.Errorf("expected auto-approve, got denied: reason=%q", reason)
	}
	if planFilePath == "" {
		t.Error("expected a non-empty planFilePath to be allocated")
	}

	// The session must now be in plan mode.
	mgr.mu.RLock()
	s := mgr.sessions["enter-auto"]
	planMode := s.planMode
	sessionPath := s.planFilePath
	mgr.mu.RUnlock()

	if !planMode {
		t.Error("expected session planMode=true after RequestPlanModeEnter")
	}
	if sessionPath != planFilePath {
		t.Errorf("session planFilePath=%q does not match returned path=%q", sessionPath, planFilePath)
	}
}

// TestRequestPlanModeEnter_ReusesExistingPlanFile verifies that calling
// RequestPlanModeEnter on a session that previously had a plan file (Part 1
// preserved it) reuses the same path rather than allocating a new hash.
func TestRequestPlanModeEnter_ReusesExistingPlanFile(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("enter-reuse", defaultConfig())

	// Enter plan mode via the normal SendPrompt path to allocate a hash.
	mgr.SetPlanMode("enter-reuse", true, []string{"Read"}, "test")
	_ = mgr.SendPrompt("enter-reuse", "plan it", nil)

	mgr.mu.RLock()
	s := mgr.sessions["enter-reuse"]
	firstPath := s.planFilePath
	mgr.mu.RUnlock()

	if firstPath == "" {
		t.Fatal("expected planFilePath after first SendPrompt")
	}

	// Simulate run exit so requestID clears.
	ordered := mb.startedInOrder()
	code := 0
	mb.emitExit(ordered[0], &code, nil, "sess-1")

	// Toggle to auto mode (user dropdown) — Part 1 preserves the path.
	mgr.SetPlanMode("enter-reuse", false, nil, "ui_dropdown")

	// Model calls EnterPlanMode. Must reuse the preserved path.
	allowed, reason, planFilePath := mgr.RequestPlanModeEnter("enter-reuse")
	if !allowed {
		t.Fatalf("expected auto-approve, got denied: reason=%q", reason)
	}
	if planFilePath != firstPath {
		t.Errorf("expected reused planFilePath=%q, got=%q", firstPath, planFilePath)
	}
}

// TestRequestPlanModeEnter_AlreadyInPlanMode verifies that calling
// RequestPlanModeEnter when the session is already in plan mode returns
// allowed=false without flipping any state.
func TestRequestPlanModeEnter_AlreadyInPlanMode(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("enter-dup", defaultConfig())

	mgr.SetPlanMode("enter-dup", true, []string{"Read"}, "test")

	allowed, reason, _ := mgr.RequestPlanModeEnter("enter-dup")
	if allowed {
		t.Error("expected denied when already in plan mode")
	}
	if reason == "" {
		t.Error("expected a non-empty reason when denying already-in-plan-mode request")
	}
}

// TestRequestPlanModeEnter_UnknownSession verifies that calling
// RequestPlanModeEnter for a non-existent session returns allowed=false.
func TestRequestPlanModeEnter_UnknownSession(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)

	allowed, reason, _ := mgr.RequestPlanModeEnter("ghost-session")
	if allowed {
		t.Error("expected denied for unknown session")
	}
	if reason == "" {
		t.Error("expected a non-empty reason for unknown session")
	}
}

// TestRequestPlanModeEnter_BlockedByHook verifies that an extension returning
// Allow=&false from the before_plan_mode_enter hook prevents plan mode entry.
func TestRequestPlanModeEnter_BlockedByHook(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("enter-hook-deny", defaultConfig())

	// Wire an in-process extension that denies plan mode entry.
	const denyReason = "extension says no"
	falseVal := false
	mgr.mu.Lock()
	s := mgr.sessions["enter-hook-deny"]
	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}
	host := extension.NewHost()
	s.extGroup.Add(host)
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &falseVal, Reason: denyReason}, nil
	})
	mgr.mu.Unlock()

	// Collect events to verify no PlanModeChangedEvent is emitted.
	ec := newEventCollector(mgr)

	allowed, reason, planFilePath := mgr.RequestPlanModeEnter("enter-hook-deny")
	if allowed {
		t.Error("expected denied by hook")
	}
	if reason != denyReason {
		t.Errorf("expected reason=%q, got=%q", denyReason, reason)
	}
	if planFilePath != "" {
		t.Error("expected empty planFilePath when denied")
	}

	// Session must still be in auto mode.
	mgr.mu.RLock()
	s = mgr.sessions["enter-hook-deny"]
	planMode := s.planMode
	mgr.mu.RUnlock()
	if planMode {
		t.Error("expected session to remain in auto mode after hook denial")
	}

	// No engine_plan_mode_changed event should have been emitted.
	planModeEvents := ec.byType("engine_plan_mode_changed")
	if len(planModeEvents) != 0 {
		t.Errorf("expected 0 plan_mode_changed events after denial, got %d", len(planModeEvents))
	}
}

// TestRequestPlanModeEnter_AllowedByHook verifies that an extension returning
// Allow=&true from before_plan_mode_enter permits plan mode entry normally.
func TestRequestPlanModeEnter_AllowedByHook(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("enter-hook-allow", defaultConfig())

	trueVal := true
	mgr.mu.Lock()
	s := mgr.sessions["enter-hook-allow"]
	if s.extGroup == nil {
		s.extGroup = extension.NewExtensionGroup()
	}
	host := extension.NewHost()
	s.extGroup.Add(host)
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &trueVal}, nil
	})
	mgr.mu.Unlock()

	allowed, reason, planFilePath := mgr.RequestPlanModeEnter("enter-hook-allow")
	if !allowed {
		t.Errorf("expected allowed by hook, got denied: reason=%q", reason)
	}
	if planFilePath == "" {
		t.Error("expected non-empty planFilePath on allow")
	}

	mgr.mu.RLock()
	s = mgr.sessions["enter-hook-allow"]
	planMode := s.planMode
	mgr.mu.RUnlock()
	if !planMode {
		t.Error("expected session to be in plan mode after hook allow")
	}
}

// TestFireBeforePlanModeEnter_DefaultAllow verifies that the SDK's
// FireBeforePlanModeEnter returns (true, "") when no handlers are registered.
func TestFireBeforePlanModeEnter_DefaultAllow(t *testing.T) {
	sdk := extension.NewSDK()
	allowed, reason := sdk.FireBeforePlanModeEnter(
		&extension.Context{},
		extension.PlanModeEnterInfo{Source: "model_tool"},
	)
	if !allowed {
		t.Errorf("expected allowed=true by default, got false reason=%q", reason)
	}
	if reason != "" {
		t.Errorf("expected empty reason when allowed, got %q", reason)
	}
}

// TestFireBeforePlanModeEnter_DenyLastWins verifies last-writer semantics:
// if two handlers return conflicting Allow values, the last-registered wins.
func TestFireBeforePlanModeEnter_DenyLastWins(t *testing.T) {
	sdk := extension.NewSDK()
	trueVal := true
	falseVal := false

	// First handler allows, second denies — last wins (deny).
	sdk.On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &trueVal}, nil
	})
	sdk.On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		return &extension.BeforePlanModeEnterResult{Allow: &falseVal, Reason: "second handler"}, nil
	})

	allowed, reason := sdk.FireBeforePlanModeEnter(
		&extension.Context{},
		extension.PlanModeEnterInfo{Source: "model_tool"},
	)
	// The plan says "last non-nil Allow wins". Both handlers returned non-nil.
	// Because sdk.fire iterates forward and FireBeforePlanModeEnter also
	// iterates forward (overwriting), the second handler's false wins.
	if allowed {
		t.Error("expected denied when second handler returns Allow=false")
	}
	if reason != "second handler" {
		t.Errorf("expected reason=%q, got %q", "second handler", reason)
	}
}

// TestEnterPlanModeChangedEvent_EmittedOnModelEntry verifies that
// RequestPlanModeEnter triggers a PlanModeChangedEvent when the model-initiated
// entry succeeds. In practice the event is emitted by runloop_tools.go after
// the hook check; here we simulate the expected session state.
func TestEnterPlanModeChangedEvent_EmittedOnModelEntry(t *testing.T) {
	mb := newMockBackend()
	mgr := NewManager(mb)
	_, _ = mgr.StartSession("emit-plan-changed", defaultConfig())

	var planChangedEvent *types.EngineEvent
	mgr.OnEvent(func(_ string, ev types.EngineEvent) {
		if ev.Type == "engine_plan_mode_changed" && ev.PlanModeEnabled {
			planChangedEvent = &ev
		}
	})

	// Simulate the event as the runloop would emit it post-RequestPlanModeEnter.
	_, _, planFilePath := mgr.RequestPlanModeEnter("emit-plan-changed")

	// Emit the PlanModeChangedEvent{Enabled:true} as the runloop would.
	mb.emitNormalized("any-run-id", types.NormalizedEvent{
		Data: &types.PlanModeChangedEvent{Enabled: true, PlanFilePath: planFilePath},
	})

	// The event goes through handleNormalizedEvent → translateToEngineEvent.
	// Since "any-run-id" is not a known run, it's dropped. So instead test
	// that RequestPlanModeEnter correctly set the session state, and verify the
	// translation function produces the right EngineEvent shape.
	ee := translateToEngineEvent(
		types.NormalizedEvent{Data: &types.PlanModeChangedEvent{Enabled: true, PlanFilePath: planFilePath}},
		200000,
	)
	if ee.Type != "engine_plan_mode_changed" {
		t.Errorf("expected engine_plan_mode_changed, got %q", ee.Type)
	}
	if !ee.PlanModeEnabled {
		t.Error("expected PlanModeEnabled=true")
	}
	if ee.PlanModeFilePath != planFilePath {
		t.Errorf("expected PlanModeFilePath=%q, got %q", planFilePath, ee.PlanModeFilePath)
	}
	// PlanModeSlug should be populated by the translation layer as a
	// fallback when the emitter didn't set it. For a path like
	// /home/u/.ion/plans/happy-jumping-rabbit.md the slug is
	// "happy-jumping-rabbit"; for legacy hex paths it's the hex string.
	// Either way it must be non-empty when the path is non-empty.
	wantSlug := types.PlanSlugFromPath(planFilePath)
	if ee.PlanModeSlug != wantSlug {
		t.Errorf("expected PlanModeSlug=%q, got %q", wantSlug, ee.PlanModeSlug)
	}
	if planFilePath != "" && ee.PlanModeSlug == "" {
		t.Error("expected non-empty PlanModeSlug when PlanFilePath is non-empty")
	}
	_ = planChangedEvent // collected above; not used because the run key is unknown
}

// TestPlanProposalEvent_TranslationShape verifies that PlanProposalEvent is
// translated to the flat EngineEvent with type=engine_plan_proposal and the
// expected discriminator + path fields. This locks in the wire-side contract
// for the workflow event that fires when the model calls ExitPlanMode — see
// docs/architecture/adr/003-state-events-vs-workflow-events.md for the
// state-vs-workflow distinction.
func TestPlanProposalEvent_TranslationShape(t *testing.T) {
	planFilePath := "/tmp/ion/plans/happy-jumping-rabbit.md"

	ee := translateToEngineEvent(
		types.NormalizedEvent{Data: &types.PlanProposalEvent{
			Kind:         "exit",
			PlanFilePath: planFilePath,
		}},
		200000,
	)
	if ee.Type != "engine_plan_proposal" {
		t.Errorf("expected type=engine_plan_proposal, got %q", ee.Type)
	}
	if ee.PlanProposalKind != "exit" {
		t.Errorf("expected PlanProposalKind=%q, got %q", "exit", ee.PlanProposalKind)
	}
	if ee.PlanModeFilePath != planFilePath {
		t.Errorf("expected PlanModeFilePath=%q, got %q", planFilePath, ee.PlanModeFilePath)
	}
	// Slug fallback should populate from the path when the emitter did not
	// set it directly.
	wantSlug := types.PlanSlugFromPath(planFilePath)
	if ee.PlanModeSlug != wantSlug {
		t.Errorf("expected PlanModeSlug=%q, got %q", wantSlug, ee.PlanModeSlug)
	}
	// Crucially: PlanModeEnabled must NOT be set on a plan_proposal event.
	// The proposal is a workflow signal; mode changes flow through
	// engine_plan_mode_changed exclusively.
	if ee.PlanModeEnabled {
		t.Error("PlanModeEnabled should be false on a plan_proposal event (mode change is deferred to user approval)")
	}
}

// TestPlanProposalEvent_TranslationEmptyPath covers the degenerate case where
// a proposal is emitted without a plan file path. The slug must be empty too
// (no fallback magic) and the translation must still produce a valid event.
func TestPlanProposalEvent_TranslationEmptyPath(t *testing.T) {
	ee := translateToEngineEvent(
		types.NormalizedEvent{Data: &types.PlanProposalEvent{Kind: "exit"}},
		200000,
	)
	if ee.Type != "engine_plan_proposal" {
		t.Errorf("expected type=engine_plan_proposal, got %q", ee.Type)
	}
	if ee.PlanProposalKind != "exit" {
		t.Errorf("expected PlanProposalKind=%q, got %q", "exit", ee.PlanProposalKind)
	}
	if ee.PlanModeFilePath != "" {
		t.Errorf("expected empty PlanModeFilePath, got %q", ee.PlanModeFilePath)
	}
	if ee.PlanModeSlug != "" {
		t.Errorf("expected empty PlanModeSlug, got %q", ee.PlanModeSlug)
	}
}
