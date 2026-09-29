package auth

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

// A renewal that keeps failing used to be retried on every Identity() call,
// which in practice asked the provider for a token about every two seconds.
func TestRenewalBackoff_WaitsLongerAfterEachFailureUpToTheCap(t *testing.T) {
	var b renewalBackoff
	now := time.Unix(1_000_000, 0)
	if !b.due(now) {
		t.Fatal("a fresh backoff must be due")
	}

	want := []time.Duration{15 * time.Second, 30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		if got := b.failed(now); got != w {
			t.Fatalf("failure %d: wait = %v, want %v", i+1, got, w)
		}
		if b.due(now.Add(w - time.Second)) {
			t.Fatalf("failure %d: due before the wait ended", i+1)
		}
		if !b.due(now.Add(w)) {
			t.Fatalf("failure %d: not due once the wait ended", i+1)
		}
	}

	if !b.succeeded() {
		t.Fatal("succeeded() must report the backoff it cleared")
	}
	if !b.due(now) || b.failed(now) != 15*time.Second {
		t.Fatal("a success must reset the backoff to its first step")
	}
}

// The same, at the call site: a stored grant whose renewal cannot succeed
// (here, no issuerUrl to verify the renewed id_token against) is renewed
// once, not once per Identity() call.
func TestIdentityManager_FailingRenewalIsNotRetriedOnEveryCall(t *testing.T) {
	var hits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at-2", "refresh_token": "rt-2", "id_token": "not.a.jwt", "expires_in": 3600})
	}))
	defer srv.Close()

	m := testIdentityManager(t, srv.URL)
	raw, err := json.Marshal(oauthToken{AccessToken: "at-1", RefreshToken: "rt-1", ExpiresAt: time.Now().Add(-time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	if err := m.fs.SetKey(m.storeKey(), string(raw)); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 5; i++ {
		if id := m.Identity(); id != nil {
			t.Fatalf("call %d: identity = %+v; renewal cannot succeed here", i+1, id)
		}
		deadline := time.Now().Add(5 * time.Second)
		for m.renewing.Load() && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
	}
	if got := hits.Load(); got != 1 {
		t.Fatalf("token endpoint hit %d times across 5 Identity() calls; want 1", got)
	}
}
