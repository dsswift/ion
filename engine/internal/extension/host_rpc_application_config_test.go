package extension

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/appconfig"
	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

type fixedIdentityProvider struct{ identity *auth.ContextIdentity }

func (p fixedIdentityProvider) ContextIdentity() *auth.ContextIdentity { return p.identity }

// installReadyStore installs a store resolved for subject-a with values.
func installReadyStore(t *testing.T, values map[string]any) {
	t.Helper()
	auth.SetContextIdentityProvider(fixedIdentityProvider{&auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: "subject-a"}})
	store := appconfig.NewStore(types.ApplicationConfigSource{Endpoint: "https://config.example.invalid"},
		func(context.Context, types.ApplicationConfigSource) (map[string]any, error) { return values, nil })
	appconfig.Install(store)
	t.Cleanup(func() {
		store.Stop()
		appconfig.Install(nil)
		auth.SetContextIdentityProvider(nil)
	})
	store.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if snap, err := store.Await(ctx, ""); err != nil || snap.State != appconfig.StateReady {
		t.Fatalf("store never became ready: %+v %v", snap, err)
	}
}

func applicationConfigRequest(t *testing.T, h *Host, method string, params map[string]any) ApplicationConfigRead {
	t.Helper()
	ch := attachStdout(h)
	payload, err := json.Marshal(map[string]any{"params": params})
	if err != nil {
		t.Fatal(err)
	}
	h.handleExtRequest(method, 1, payload)
	resp := readResponse(t, ch, 2*time.Second)
	if resp["error"] != nil {
		t.Fatalf("%s failed: %v", method, resp["error"])
	}
	encoded, err := json.Marshal(resp["result"])
	if err != nil {
		t.Fatal(err)
	}
	var answer ApplicationConfigRead
	if err := json.Unmarshal(encoded, &answer); err != nil {
		t.Fatal(err)
	}
	return answer
}

func TestGetApplicationConfigDisabledWhenUnconfigured(t *testing.T) {
	appconfig.Install(nil)
	answer := applicationConfigRequest(t, NewHost(), "ext/get_application_config", map[string]any{"key": "region"})
	if answer.State != appconfig.StateDisabled || answer.Found {
		t.Fatalf("an unconfigured engine must answer disabled: %+v", answer)
	}
}

func TestGetApplicationConfigDistinguishesMissingKey(t *testing.T) {
	installReadyStore(t, map[string]any{"region": "east"})

	whole := applicationConfigRequest(t, NewHost(), "ext/get_application_config", map[string]any{})
	if whole.State != appconfig.StateReady || whole.Values["region"] != "east" {
		t.Fatalf("a read with no key must return the whole snapshot: %+v", whole)
	}
	hit := applicationConfigRequest(t, NewHost(), "ext/get_application_config", map[string]any{"key": "region"})
	if !hit.Found || hit.Value != "east" || hit.Values != nil {
		t.Fatalf("a keyed read must return that key alone: %+v", hit)
	}
	miss := applicationConfigRequest(t, NewHost(), "ext/get_application_config", map[string]any{"key": "absent"})
	if miss.State != appconfig.StateReady || miss.Found {
		t.Fatalf("a missing key must read ready and not found: %+v", miss)
	}
}

func TestGetApplicationConfigScopedToSessionPrincipal(t *testing.T) {
	installReadyStore(t, map[string]any{"region": "east"})
	h := NewHost()
	h.ctxStack.Push(&Context{Identity: &auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: "subject-b"}})
	answer := applicationConfigRequest(t, h, "ext/get_application_config", map[string]any{"key": "region"})
	if answer.State != appconfig.StateDeferred || answer.Found {
		t.Fatalf("another principal's session must never read these values: %+v", answer)
	}
}

func TestAwaitApplicationConfig(t *testing.T) {
	installReadyStore(t, map[string]any{"region": "east"})
	answer := applicationConfigRequest(t, NewHost(), "ext/await_application_config", map[string]any{"key": "region", "timeoutMs": 1000})
	if answer.State != appconfig.StateReady || !answer.Found || answer.TimedOut {
		t.Fatalf("await on a ready store must answer at once: %+v", answer)
	}

	h := NewHost()
	h.ctxStack.Push(&Context{Identity: &auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: "subject-b"}})
	waited := applicationConfigRequest(t, h, "ext/await_application_config", map[string]any{"timeoutMs": 20})
	if waited.State != appconfig.StateDeferred || !waited.TimedOut {
		t.Fatalf("await for a principal with no snapshot must time out deferred: %+v", waited)
	}
}
