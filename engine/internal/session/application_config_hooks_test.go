package session

import (
	"github.com/dsswift/ion/engine/internal/session/agents"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestApplicationConfigChangedReachesSessionsScoped proves every live
// session's extension receives each transition scoped to its trusted
// allowlist identity, and a session acting as a different principal
// receives the deferred view instead of the values.
func TestApplicationConfigChangedReachesSessionsScoped(t *testing.T) {
	manager := NewManager(newMockBackend())
	t.Cleanup(manager.Shutdown)

	var mu sync.Mutex
	received := map[string]appconfig.View{}
	addSession := func(key, trustedID string, principal *types.SessionPrincipal) {
		host := extension.NewHost()
		host.SetTrustedIDForTest(trustedID)
		host.SDK().On(extension.HookApplicationConfigChanged, func(_ *extension.Context, payload interface{}) (interface{}, error) {
			mu.Lock()
			received[key] = payload.(extension.ApplicationConfigChangedInfo) //nolint:errcheck // test asserts the payload type below
			mu.Unlock()
			return nil, nil
		})
		group := extension.NewExtensionGroup()
		group.Add(host)
		manager.mu.Lock()
		manager.sessions[key] = &engineSession{agents: agents.NewRegistry(), key: key, extGroup: group, principal: principal}
		manager.mu.Unlock()
	}
	addSession("process-session", "ext-a", nil)
	addSession("untrusted", "", nil)
	addSession("other-principal", "ext-a", &types.SessionPrincipal{Kind: "operator", Provider: "entra", Subject: "subject-b"})

	stop := manager.WatchApplicationConfig()
	defer stop()
	manager.handleApplicationConfigChange(appconfig.Snapshot{
		State: appconfig.StateReady, Revision: 2, Subject: "subject-a", Document: &appconfig.Document{
			Common:     appconfig.Section{Values: map[string]any{"region": "east"}, Secrets: map[string]string{"key": "secret-value"}},
			Extensions: map[string]appconfig.Section{"ext-a": {Values: map[string]any{"storage": "a-bucket"}}},
		},
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := len(received)
		mu.Unlock()
		if count == 3 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := received["process-session"]; got.State != appconfig.StateReady || got.Values["region"] != "east" || got.Values["storage"] != "a-bucket" {
		t.Fatalf("the trusted extension must receive common plus its section: %+v", got)
	}
	if got := received["process-session"]; len(got.SecretKeys) != 1 || got.SecretKeys[0] != "key" {
		t.Fatalf("the payload must name the secret and never carry its value: %+v", got)
	}
	if got := received["untrusted"]; got.Values["region"] != "east" || got.Values["storage"] != nil {
		t.Fatalf("an untrusted extension must receive only common: %+v", got)
	}
	if got := received["other-principal"]; got.State != appconfig.StateDeferred || got.Values != nil || got.Revision != 2 {
		t.Fatalf("another principal's session must receive the deferred view: %+v", got)
	}
}
