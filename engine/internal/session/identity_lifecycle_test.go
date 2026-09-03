package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/extension"
)

func TestInitialIdentityChangedPrecedesSessionStart(t *testing.T) {
	manager := NewManager(newMockBackend())
	t.Cleanup(manager.Shutdown)
	host := extension.NewHost()
	order := []string{}
	host.SDK().On(extension.HookIdentityChanged, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		order = append(order, "identity_changed")
		return nil, nil
	})
	host.SDK().On(extension.HookSessionStart, func(_ *extension.Context, _ interface{}) (interface{}, error) {
		order = append(order, "session_start")
		return nil, nil
	})
	group := extension.NewExtensionGroup()
	group.Add(host)
	s := &engineSession{key: "identity-order", extGroup: group}
	manager.fireInitialIdentityChanged(s, s.key)
	if err := group.FireSessionStart(&extension.Context{}); err != nil {
		t.Fatalf("session start: %v", err)
	}
	if len(order) != 2 || order[0] != "identity_changed" || order[1] != "session_start" {
		t.Fatalf("hook order = %v", order)
	}
}

func TestIdentityChangeEquality(t *testing.T) {
	identity := &auth.ContextIdentity{Kind: "operator", Provider: "provider", Subject: "subject"}
	if !identityChangeEqual(identity, &auth.ContextIdentity{Kind: "operator", Provider: "provider", Subject: "subject"}) {
		t.Fatal("equal snapshots differ")
	}
	if identityChangeEqual(identity, nil) {
		t.Fatal("different snapshots match")
	}
}
