package backend

import (
	"errors"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

func providerErrorEvent(t *testing.T, status *types.ProviderSubscriptionStatus, providerID string) *types.ErrorEvent {
	t.Helper()
	t.Setenv("ION_DATA_DIR", t.TempDir())
	b := NewApiBackend()
	resolver := auth.NewResolver(nil)
	if status != nil {
		resolver.SetSubscriptionStatusSource(func() types.ProviderSubscriptionStatus { return *status })
	}
	b.SetAuthResolver(resolver)
	run := &activeRun{requestID: "req-provider-error", startTime: time.Now()}
	c := collectEvents(b, run.requestID)

	b.emitProviderError(run, providerID, errors.New("auth: 401 Unauthorized"))

	c.mu.Lock()
	defer c.mu.Unlock()
	for _, event := range c.normalized {
		if errEvent, ok := event.Data.(*types.ErrorEvent); ok {
			return errEvent
		}
	}
	t.Fatal("no ErrorEvent emitted")
	return nil
}

func TestProviderErrorCarriesUnappliedSubscription(t *testing.T) {
	for _, state := range []string{types.SubscriptionStateSelectionRequired, types.SubscriptionStateNone} {
		status := &types.ProviderSubscriptionStatus{
			State: state, Provider: "gateway", ProviderDisplayName: "Gateway",
			Options: []types.SubscriptionOption{{ID: "a", Label: "Standard"}},
		}
		event := providerErrorEvent(t, status, "Gateway")
		if event.ProviderSubscription == nil {
			t.Fatalf("state %s: error carried no subscription snapshot", state)
		}
		if event.ProviderSubscription.State != state || event.ProviderSubscription.ProviderDisplayName != "Gateway" {
			t.Fatalf("state %s: snapshot = %+v", state, event.ProviderSubscription)
		}
		if event.ErrorMessage != "auth: 401 Unauthorized" {
			t.Fatalf("state %s: message changed to %q", state, event.ErrorMessage)
		}
	}
}

func TestProviderErrorOmitsSubscriptionWhenItDoesNotApply(t *testing.T) {
	cases := map[string]struct {
		status   *types.ProviderSubscriptionStatus
		provider string
	}{
		"no lookup configured": {nil, "gateway"},
		"lookup disabled":      {&types.ProviderSubscriptionStatus{State: types.SubscriptionStateDisabled}, "gateway"},
		"key applied":          {&types.ProviderSubscriptionStatus{State: types.SubscriptionStateApplied, Provider: "gateway"}, "gateway"},
		"another provider":     {&types.ProviderSubscriptionStatus{State: types.SubscriptionStateNone, Provider: "gateway"}, "anthropic"},
	}
	for name, tc := range cases {
		if event := providerErrorEvent(t, tc.status, tc.provider); event.ProviderSubscription != nil {
			t.Errorf("%s: error carried snapshot %+v", name, event.ProviderSubscription)
		}
	}
}
