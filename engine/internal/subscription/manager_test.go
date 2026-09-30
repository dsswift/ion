package subscription

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

type fakeKeys struct {
	mu   sync.Mutex
	keys map[string]string
}

func (k *fakeKeys) SetSubscriptionKey(provider, key string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.keys[provider] = key
}

func (k *fakeKeys) ClearSubscriptionKey(provider string) {
	k.mu.Lock()
	defer k.mu.Unlock()
	delete(k.keys, provider)
}

func (k *fakeKeys) get(provider string) string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.keys[provider]
}

type memoryCache struct {
	mu      sync.Mutex
	entries map[string]CacheEntry
}

func (c *memoryCache) Load(identity, provider string) (*CacheEntry, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[identity+"/"+provider]
	if !ok {
		return nil, nil
	}
	return &entry, nil
}

func (c *memoryCache) Save(identity, provider string, entry CacheEntry) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[identity+"/"+provider] = entry
	return nil
}

func (c *memoryCache) Delete(identity, provider string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, identity+"/"+provider)
	return nil
}

// scriptedFetch answers each lookup from the next scripted response and
// counts calls.
type scriptedFetch struct {
	mu        sync.Mutex
	calls     int
	responses []func() ([]Subscription, error)
}

func (f *scriptedFetch) fetch(context.Context, types.SubscriptionLookupConfig) ([]Subscription, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if len(f.responses) == 0 {
		return nil, errors.New("no scripted response")
	}
	next := f.responses[0]
	if len(f.responses) > 1 {
		f.responses = f.responses[1:]
	}
	return next()
}

func (f *scriptedFetch) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func answer(subs ...Subscription) func() ([]Subscription, error) {
	return func() ([]Subscription, error) { return subs, nil }
}

type harness struct {
	m       *Manager
	keys    *fakeKeys
	cache   *memoryCache
	fetch   *scriptedFetch
	changes chan types.ProviderSubscriptionStatus
}

func newHarness(t *testing.T, cfg types.SubscriptionLookupConfig, responses ...func() ([]Subscription, error)) *harness {
	t.Helper()
	if cfg.Provider == "" {
		cfg.Provider = "gateway"
	}
	if cfg.Endpoint == "" {
		cfg.Endpoint = "https://example.invalid/subscriptions"
	}
	h := &harness{
		keys:    &fakeKeys{keys: map[string]string{}},
		cache:   &memoryCache{entries: map[string]CacheEntry{}},
		fetch:   &scriptedFetch{responses: responses},
		changes: make(chan types.ProviderSubscriptionStatus, 32),
	}
	h.m = NewManager(cfg, h.fetch.fetch, h.cache, h.keys, func(status types.ProviderSubscriptionStatus) { h.changes <- status })
	t.Cleanup(h.m.Stop)
	return h
}

func (h *harness) signIn(subject string) {
	h.m.applyIdentity(&auth.ContextIdentity{Kind: "operator", Provider: "entra", Subject: subject}, "test")
}

// waitFor returns the first published status in state, failing after a
// bound so a missing publish is a failure, not a hang.
func (h *harness) waitFor(t *testing.T, state string) types.ProviderSubscriptionStatus {
	t.Helper()
	return h.waitMatch(t, state, func(status types.ProviderSubscriptionStatus) bool { return status.State == state })
}

func (h *harness) waitMatch(t *testing.T, what string, match func(types.ProviderSubscriptionStatus) bool) types.ProviderSubscriptionStatus {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case status := <-h.changes:
			if match(status) {
				return status
			}
		case <-deadline:
			t.Fatalf("no %s status published; current %+v", what, h.m.Status())
		}
	}
}

var (
	standard = Subscription{ID: "std", Label: "Standard", Key: "key-std"}
	premium  = Subscription{ID: "prem", Label: "High quota", Key: "key-prem"}
)

func TestSingleSubscriptionAppliesAutomatically(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, answer(standard))
	h.signIn("user-1")
	status := h.waitFor(t, types.SubscriptionStateApplied)
	if status.Selected == nil || status.Selected.ID != "std" || status.Source != types.SubscriptionSourceLookup {
		t.Fatalf("applied status = %+v", status)
	}
	if got := h.keys.get("gateway"); got != "key-std" {
		t.Fatalf("applied key = %q", got)
	}
	cached, _ := h.cache.Load("user-1", "gateway")
	if cached == nil || cached.Key != "key-std" || cached.SelectedID != "std" {
		t.Fatalf("cache = %+v", cached)
	}
}

func TestMultipleSubscriptionsRequireSelectionAndPersistChoice(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, answer(standard, premium))
	h.signIn("user-1")
	status := h.waitFor(t, types.SubscriptionStateSelectionRequired)
	if len(status.Options) != 2 || status.Options[1].Label != "High quota" {
		t.Fatalf("options = %+v", status.Options)
	}
	if got := h.keys.get("gateway"); got != "" {
		t.Fatalf("a key was applied before selection: %q", got)
	}

	selected, err := h.m.Select("prem")
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if selected.State != types.SubscriptionStateApplied || selected.Selected.ID != "prem" {
		t.Fatalf("selected status = %+v", selected)
	}
	if got := h.keys.get("gateway"); got != "key-prem" {
		t.Fatalf("applied key = %q", got)
	}
	if h.fetch.count() != 1 {
		t.Fatalf("selection from the last response looked up again: %d calls", h.fetch.count())
	}

	// A later launch reuses the choice with no lookup.
	next := newHarness(t, types.SubscriptionLookupConfig{}, answer(standard, premium))
	next.cache = h.cache
	next.m.cache = h.cache
	next.signIn("user-1")
	reused := next.waitFor(t, types.SubscriptionStateApplied)
	if reused.Source != types.SubscriptionSourceCache || reused.Selected.ID != "prem" || len(reused.Options) != 2 {
		t.Fatalf("reused status = %+v", reused)
	}
	if next.keys.get("gateway") != "key-prem" || next.fetch.count() != 0 {
		t.Fatalf("launch key %q, lookups %d", next.keys.get("gateway"), next.fetch.count())
	}
}

func TestRememberedSelectionAppliesAfterRefresh(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, answer(standard, premium),
		answer(standard, Subscription{ID: "prem", Label: "High quota", Key: "key-prem-rotated"}))
	h.signIn("user-1")
	h.waitFor(t, types.SubscriptionStateSelectionRequired)
	if _, err := h.m.Select("prem"); err != nil {
		t.Fatalf("select: %v", err)
	}
	status, err := h.m.Refresh()
	if err != nil || status.Selected.ID != "prem" || h.keys.get("gateway") != "key-prem-rotated" {
		t.Fatalf("refresh = %+v, %v, key %q", status, err, h.keys.get("gateway"))
	}
}

func TestZeroSubscriptionsReportNoneAndDropCache(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, answer())
	if err := h.cache.Save("user-1", "gateway", CacheEntry{SelectedID: "std", Label: "Standard", Key: "key-std", ResolvedAt: 1}); err != nil {
		t.Fatal(err)
	}
	h.m.cfg.CacheMaxAgeSeconds = 1
	h.signIn("user-1")
	status := h.waitFor(t, types.SubscriptionStateNone)
	if status.Selected != nil || h.keys.get("gateway") != "" {
		t.Fatalf("none status = %+v, key %q", status, h.keys.get("gateway"))
	}
	if cached, _ := h.cache.Load("user-1", "gateway"); cached != nil {
		t.Fatalf("cache kept after zero subscriptions: %+v", cached)
	}
}

func TestLookupFailureWithoutCacheLeavesManualKey(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, func() ([]Subscription, error) { return nil, errors.New("endpoint returned status 503") })
	h.signIn("user-1")
	status := h.waitFor(t, types.SubscriptionStateFailed)
	if status.Error == "" || h.keys.get("gateway") != "" {
		t.Fatalf("failed status = %+v, key %q", status, h.keys.get("gateway"))
	}
}

func TestExpiredCacheStaysAppliedWhenRefreshFails(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{CacheMaxAgeSeconds: 60}, func() ([]Subscription, error) { return nil, errors.New("timeout") })
	if err := h.cache.Save("user-1", "gateway", CacheEntry{SelectedID: "std", Label: "Standard", Key: "key-std", ResolvedAt: time.Now().Add(-time.Hour).UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	h.signIn("user-1")
	status := h.waitMatch(t, "failed refresh", func(status types.ProviderSubscriptionStatus) bool { return status.Error != "" })
	if status.State != types.SubscriptionStateApplied || status.Error != "timeout" || h.keys.get("gateway") != "key-std" {
		t.Fatalf("status = %+v, key %q", status, h.keys.get("gateway"))
	}
	if h.fetch.count() != 1 {
		t.Fatalf("expired cache did not trigger one lookup: %d", h.fetch.count())
	}
}

func TestFreshCacheSkipsLookup(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{CacheMaxAgeSeconds: 3600}, answer(premium))
	if err := h.cache.Save("user-1", "gateway", CacheEntry{SelectedID: "std", Label: "Standard", Key: "key-std", ResolvedAt: time.Now().UnixMilli()}); err != nil {
		t.Fatal(err)
	}
	h.signIn("user-1")
	h.waitFor(t, types.SubscriptionStateApplied)
	if h.fetch.count() != 0 || h.keys.get("gateway") != "key-std" {
		t.Fatalf("lookups %d, key %q", h.fetch.count(), h.keys.get("gateway"))
	}
}

func TestSignOutRemovesKeyAndSwitchDropsStaleLookup(t *testing.T) {
	release := make(chan struct{})
	h := newHarness(t, types.SubscriptionLookupConfig{},
		func() ([]Subscription, error) { <-release; return []Subscription{standard}, nil },
		answer(premium))
	h.signIn("user-1")
	h.waitFor(t, types.SubscriptionStateResolving)
	// A second identity signs in while the first lookup is in flight.
	h.signIn("user-2")
	close(release)
	status := h.waitFor(t, types.SubscriptionStateApplied)
	// Give the released first lookup time to settle; it must be dropped.
	time.Sleep(50 * time.Millisecond)
	if status.Selected.ID != "prem" || h.keys.get("gateway") != "key-prem" {
		t.Fatalf("status = %+v, key %q", status, h.keys.get("gateway"))
	}
	if cached, _ := h.cache.Load("user-1", "gateway"); cached != nil {
		t.Fatalf("stale lookup cached for the first identity: %+v", cached)
	}

	h.m.applyIdentity(nil, "signed_out")
	signedOut := h.waitFor(t, types.SubscriptionStateAwaitingIdentity)
	if signedOut.Selected != nil || h.keys.get("gateway") != "" {
		t.Fatalf("signed out status = %+v, key %q", signedOut, h.keys.get("gateway"))
	}
	if _, err := h.m.Refresh(); err == nil {
		t.Fatal("refresh without an identity succeeded")
	}
}

func TestSelectUnknownIDFails(t *testing.T) {
	h := newHarness(t, types.SubscriptionLookupConfig{}, answer(standard, premium))
	h.signIn("user-1")
	h.waitFor(t, types.SubscriptionStateSelectionRequired)
	if _, err := h.m.Select("missing"); err == nil {
		t.Fatal("selecting an id the lookup never offered succeeded")
	}
	if h.keys.get("gateway") != "" {
		t.Fatalf("key applied for an unknown id: %q", h.keys.get("gateway"))
	}
}

func TestValidate(t *testing.T) {
	if err := Validate(types.SubscriptionLookupConfig{Endpoint: "https://example.invalid/s", Provider: "gateway"}); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	for _, cfg := range []types.SubscriptionLookupConfig{
		{Endpoint: "https://example.invalid/s"},
		{Endpoint: "ftp://example.invalid/s", Provider: "gateway"},
		{Endpoint: "https://example.invalid/s", Provider: "gateway", TimeoutMs: -1},
	} {
		if err := Validate(cfg); err == nil {
			t.Fatalf("invalid config accepted: %+v", cfg)
		}
	}
}
