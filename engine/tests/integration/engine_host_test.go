//go:build integration

// End-to-end test for engine-scoped extension hosts: a real Manager starts
// the scope-canary as an engine host from the extensionHosts config, its
// schedule fires into a headless session the manager mints, and the session
// half the headless session loads carries the tool but not the schedule.
package integration

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session"
	"github.com/dsswift/ion/engine/internal/types"
)

func scopeCanaryEntry(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "..", "extensions", "scope-canary", "index.ts"))
	if err != nil {
		t.Fatalf("resolve scope-canary path: %v", err)
	}
	return abs
}

func TestEngineHost_ScopeCanaryHalvesLandWhereDeclared(t *testing.T) {
	requireEsbuild(t)
	mgr := session.NewManager(&nullBackend{})
	t.Cleanup(mgr.Shutdown)
	mgr.SetConfig(&types.EngineRuntimeConfig{
		ExtensionHosts: &types.ExtensionHostsConfig{
			Extensions: []string{scopeCanaryEntry(t)},
			RunAs:      &types.RunAsPrincipalConfig{Mode: types.RunAsModePrincipal, Principal: &types.SessionPrincipal{Subject: "local:canary", Provider: "os", Kind: "local"}},
			Session:    types.HeadlessSessionConfig{WorkingDirectory: t.TempDir(), IdleReleaseMs: 1000},
		},
	})

	if err := mgr.StartEngineHosts(t.Context()); err != nil {
		t.Fatalf("StartEngineHosts: %v", err)
	}
	group := mgr.EngineHosts()
	if group == nil || len(group.Hosts()) != 1 {
		t.Fatal("expected the scope-canary engine host")
	}
	engineHost := group.Hosts()[0]
	if got := scheduleJobIDs(engineHost.Schedules()); len(got) != 1 || got[0] != "scope-canary-tick" {
		t.Fatalf("engine host schedules = %v, want scope-canary-tick", got)
	}
	if len(engineHost.Tools()) != 0 {
		t.Fatalf("engine host tools = %v, want none", toolNames(engineHost.Tools()))
	}

	// Fire the schedule: the resolver mints a headless session that loads
	// the session half, and the fire's handler runs with that session's key.
	if err := mgr.FireEngineHostSchedule("scope-canary", "scope-canary-tick"); err != nil {
		t.Fatalf("fire: %v", err)
	}
	var headless *session.SessionInfo
	deadline := time.Now().Add(60 * time.Second)
	for headless == nil && time.Now().Before(deadline) {
		for _, si := range mgr.ListSessions() {
			if si.Headless {
				copy := si
				headless = &copy
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	if headless == nil {
		t.Fatal("no headless session appeared for the fire")
	}
	if headless.PrincipalSubject != "local:canary" || !session.IsHeadlessKey(headless.Key) {
		t.Fatalf("headless session = %+v", headless)
	}
	// The session half carries the tool and no schedule.
	hosts := mgr.SessionHosts(headless.Key)
	if len(hosts) != 1 {
		t.Fatalf("headless session loaded %d host(s), want the session half", len(hosts))
	}
	sessionHost := hosts[0]
	if sessionHost.IsEngineHost() || sessionHost.ManifestScope() != extension.ManifestScopeBoth {
		t.Fatalf("session half scope = %s/%s", sessionHost.Scope(), sessionHost.ManifestScope())
	}
	if got := toolNames(sessionHost.Tools()); len(got) != 1 || got[0] != "scope_canary_scope" {
		t.Fatalf("session half tools = %v, want scope_canary_scope", got)
	}
	if n := len(sessionHost.Schedules()); n != 0 {
		t.Fatalf("session half registered %d schedule(s)", n)
	}
	result, err := sessionHost.Tools()[0].Execute(map[string]any{}, &extension.Context{SessionKey: headless.Key})
	if err != nil || result == nil || !strings.Contains(result.Content, "scope:session") {
		t.Fatalf("session half tool = %+v, %v; want scope:session", result, err)
	}
}
