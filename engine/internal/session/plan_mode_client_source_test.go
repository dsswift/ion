package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/extension"
)

// The server sends set_plan_mode for a user's toggle, a plan approval, and a
// session start alike. The client's own label rides the hook payload, so a handler
// can tell them apart.
func TestTransitionPlanMode_HookPayloadCarriesClientSource(t *testing.T) {
	mgr, host, _ := transitionSession(t, "pm-client-source")
	var enter extension.PlanModeEnterInfo
	var exit extension.BeforePlanModeExitInfo
	host.SDK().On(extension.HookBeforePlanModeEnter, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		enter = payload.(extension.PlanModeEnterInfo)
		return nil, nil
	})
	host.SDK().On(extension.HookBeforePlanModeExit, func(_ *extension.Context, payload interface{}) (interface{}, error) {
		exit = payload.(extension.BeforePlanModeExitInfo)
		return nil, nil
	})

	mgr.TransitionPlanMode("pm-client-source", PlanModeTransitionRequest{Enabled: true, Source: backend.PlanModeSourceWire, ClientSource: "session_start"})
	if enter.Source != backend.PlanModeSourceWire || enter.ClientSource != "session_start" {
		t.Fatalf("enter payload = %+v", enter)
	}
	mgr.TransitionPlanMode("pm-client-source", PlanModeTransitionRequest{Enabled: false, Source: backend.PlanModeSourceWire, ClientSource: "plan_approved"})
	if exit.Source != backend.PlanModeSourceWire || exit.ClientSource != "plan_approved" {
		t.Fatalf("exit payload = %+v", exit)
	}
}
