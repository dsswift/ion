package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

// Every provider with a delegated-CLI option reports how its sign-in
// completes, so a client on another machine can refuse a callback-only flow
// before starting it; API-only providers report nothing.
func TestBuildProviderEntries_LoginFlow(t *testing.T) {
	s := &Server{authResolver: auth.NewResolver(nil)}
	entries := s.buildProviderEntries(nil)
	byID := map[string]types.ProviderEntry{}
	for _, e := range entries {
		byID[e.ID] = e
	}
	want := map[string]string{
		"anthropic": types.LoginFlowBrowserCode,
		"openai":    types.LoginFlowBrowserOrDeviceCode,
		"xai":       types.LoginFlowBrowserCallback,
		"cursor":    types.LoginFlowBrowserCallback,
	}
	for pid, flow := range want {
		e, ok := byID[pid]
		if !ok {
			t.Fatalf("no entry for %s", pid)
		}
		if e.LoginFlow != flow {
			t.Errorf("%s: loginFlow = %q, want %q", pid, e.LoginFlow, flow)
		}
	}
	for pid, e := range byID {
		if _, cli := want[pid]; !cli && e.LoginFlow != "" {
			t.Errorf("%s: API-only provider must report no loginFlow, got %q", pid, e.LoginFlow)
		}
	}
	if loginFlowForCliKind("unknown") != "" {
		t.Error("an unknown kind must map to an empty flow, not a guess")
	}
}
