package session

import (
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestApplicationConfigChangedReachesSessionsScoped proves every live
// session's extension receives each transition, and a session acting as a
// different principal receives the deferred view instead of the values.
func TestApplicationConfigChangedReachesSessionsScoped(t *testing.T) {
	manager := NewManager(newMockBackend())
	t.Cleanup(manager.Shutdown)

	var mu sync.Mutex
	received := map[string]appconfig.Snapshot{}
	addSession := func(key string, principal *types.SessionPrincipal) {
		host := extension.NewHost()
		host.SDK().On(extension.HookApplicationConfigChanged, func(_ *extension.Context, payload interface{}) (interface{}, error) {
			mu.Lock()
			received[key] = payload.(extension.ApplicationConfigChangedInfo) //nolint:errcheck // test asserts the payload type below
			mu.Unlock()
			return nil, nil
		})
		group := extension.NewExtensionGroup()
		group.Add(host)
		manager.mu.Lock()
		manager.sessions[key] = &engineSession{key: key, extGroup: group, principal: principal}
		manager.mu.Unlock()
	}
	addSession("process-session", nil)
	addSession("other-principal", &types.SessionPrincipal{Kind: "operator", Provider: "entra", Subject: "subject-b"})

	stop := manager.WatchApplicationConfig()
	defer stop()
	manager.handleApplicationConfigChange(appconfig.Snapshot{
		State: appconfig.StateReady, Revision: 2, Subject: "subject-a", Values: map[string]any{"region": "east"},
	})

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		count := len(received)
		mu.Unlock()
		if count == 2 || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	mu.Lock()
	defer mu.Unlock()
	if got := received["process-session"]; got.State != appconfig.StateReady || got.Values["region"] != "east" {
		t.Fatalf("the process session must receive the snapshot: %+v", got)
	}
	if got := received["other-principal"]; got.State != appconfig.StateDeferred || got.Values != nil || got.Revision != 2 {
		t.Fatalf("another principal's session must receive the deferred view: %+v", got)
	}
}
