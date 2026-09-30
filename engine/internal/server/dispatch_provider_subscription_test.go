package server

// dispatch_provider_subscription_test.go — the provider_subscription_*
// commands through the socket: the disabled answer, a lookup that needs a
// selection, selection over the wire, and the broadcast snapshot that never
// carries a key.

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/subscription"
	"github.com/dsswift/ion/engine/internal/types"
)

type fixedIdentity struct{ subject string }

func (f fixedIdentity) ContextIdentity() *auth.ContextIdentity {
	return &auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: f.subject}
}

func subscriptionCommand(t *testing.T, srv *Server, cmd map[string]any) (*types.EngineEvent, bool, string) {
	t.Helper()
	conn := dialServer(t, srv)
	defer conn.Close()
	sendJSON(t, conn, cmd)
	lines := readLinesUntil(t, conn, 5*time.Second, func(l string) bool { return strings.Contains(l, `"cmd":"result"`) })
	result := findResult(t, lines)
	if result == nil {
		t.Fatalf("no result for %v, lines: %v", cmd["cmd"], lines)
	}
	return findMcpEvent(t, lines, types.EventProviderSubscription), result.OK, strings.Join(lines, "\n")
}

func TestProviderSubscriptionDisabledWithoutConfig(t *testing.T) {
	srv := newShortPathTestServer(t, &mockBackend{})
	evt, ok, _ := subscriptionCommand(t, srv, map[string]any{"cmd": "provider_subscription_status", "requestId": "r1"})
	if !ok || evt == nil || evt.ProviderSubscription == nil || evt.ProviderSubscription.State != types.SubscriptionStateDisabled {
		t.Fatalf("status without config = ok %v, event %+v", ok, evt)
	}
	_, ok, _ = subscriptionCommand(t, srv, map[string]any{"cmd": "provider_subscription_refresh", "requestId": "r2"})
	if ok {
		t.Fatal("refresh without config succeeded")
	}
}

func TestProviderSubscriptionSelectOverTheWire(t *testing.T) {
	t.Setenv("ION_DATA_DIR", t.TempDir())
	srv := newShortPathTestServer(t, &mockBackend{})
	resolver := auth.NewResolver(nil)
	fetch := func(context.Context, types.SubscriptionLookupConfig) ([]subscription.Subscription, error) {
		return []subscription.Subscription{
			{ID: "std", Label: "Standard", Key: "key-std"},
			{ID: "prem", Label: "High quota", Key: "key-prem"},
		}, nil
	}
	auth.SetContextIdentityProvider(fixedIdentity{subject: "user-1"})
	t.Cleanup(func() { auth.SetContextIdentityProvider(nil) })
	manager := subscription.NewManager(types.SubscriptionLookupConfig{Endpoint: "https://example.invalid/s", Provider: "gateway"},
		fetch, subscription.NewFileStoreCache(), resolver, srv.BroadcastProviderSubscription)
	srv.SetSubscriptionManager(manager)
	t.Cleanup(manager.Stop)

	watcher := dialServer(t, srv)
	defer watcher.Close()
	manager.Start()

	deadline := time.Now().Add(5 * time.Second)
	for manager.Status().State != types.SubscriptionStateSelectionRequired && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	evt, ok, _ := subscriptionCommand(t, srv, map[string]any{"cmd": "provider_subscription_status", "requestId": "r1"})
	if !ok || evt.ProviderSubscription.State != types.SubscriptionStateSelectionRequired || len(evt.ProviderSubscription.Options) != 2 {
		t.Fatalf("status = ok %v, %+v", ok, evt.ProviderSubscription)
	}

	evt, ok, raw := subscriptionCommand(t, srv, map[string]any{"cmd": "provider_subscription_select", "requestId": "r2", "subscriptionId": "prem"})
	if !ok || evt.ProviderSubscription.State != types.SubscriptionStateApplied || evt.ProviderSubscription.Selected.ID != "prem" {
		t.Fatalf("select = ok %v, %+v", ok, evt.ProviderSubscription)
	}
	if strings.Contains(raw, "key-prem") {
		t.Fatalf("a subscription key crossed the wire: %s", raw)
	}
	if key, err := resolver.ResolveKey("gateway"); err != nil || key != "key-prem" {
		t.Fatalf("resolver key = %q, %v", key, err)
	}

	broadcast := readLinesUntil(t, watcher, 5*time.Second, func(l string) bool {
		return strings.Contains(l, types.EventProviderSubscription) && strings.Contains(l, `"state":"applied"`)
	})
	if evt := findMcpEvent(t, broadcast[len(broadcast)-1:], types.EventProviderSubscription); evt == nil || evt.ProviderSubscription.Selected.ID != "prem" {
		t.Fatalf("no applied broadcast to another client: %v", broadcast)
	}
}
