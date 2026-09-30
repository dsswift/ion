package subscription

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// KeyApplier receives the resolved key. *auth.Resolver implements it.
type KeyApplier interface {
	SetSubscriptionKey(providerID, key string)
	ClearSubscriptionKey(providerID string)
}

// Validate reports a configuration the manager cannot run.
func Validate(cfg types.SubscriptionLookupConfig) error {
	if strings.TrimSpace(cfg.Provider) == "" {
		return fmt.Errorf("subscriptionLookup.provider is required")
	}
	if cfg.TimeoutMs < 0 || cfg.CacheMaxAgeSeconds < 0 {
		return fmt.Errorf("subscriptionLookup.timeoutMs and cacheMaxAgeSeconds cannot be negative")
	}
	return ValidateEndpoint(cfg.Endpoint)
}

// Manager owns the Provider Subscription lifecycle for one engine process.
// It follows the verified process identity: each new identity gets its own
// cached selection or a fresh lookup, and signing out removes the applied key
// so the manual levels serve again.
type Manager struct {
	cfg      types.SubscriptionLookupConfig
	fetch    Fetcher
	cache    Cache
	keys     KeyApplier
	onChange func(types.ProviderSubscriptionStatus)
	now      func() time.Time

	root       context.Context
	cancelRoot context.CancelFunc

	// publishMu orders snapshots: each publish reads the state current at
	// that moment, so the last snapshot delivered is always the latest.
	publishMu sync.Mutex

	mu          sync.Mutex
	status      types.ProviderSubscriptionStatus
	identityKey string
	// partition is the identity's credential-store partition (its subject).
	// Empty when signed out, or when the identity carries no subject, in
	// which case nothing is cached.
	partition string
	signedIn  bool
	// remembered is the selected subscription id to prefer when a lookup
	// returns several.
	remembered string
	// results is the last lookup response, keys included, so a selection
	// among its options needs no second lookup.
	results    []Subscription
	resultsAt  int64
	generation uint64
	stopped    bool
	unsub      func()
}

// NewManager builds a manager. onChange receives every state change.
func NewManager(cfg types.SubscriptionLookupConfig, fetch Fetcher, cache Cache, keys KeyApplier, onChange func(types.ProviderSubscriptionStatus)) *Manager {
	root, cancel := context.WithCancel(context.Background())
	cfg.Provider = strings.ToLower(cfg.Provider)
	return &Manager{
		cfg:        cfg,
		fetch:      fetch,
		cache:      cache,
		keys:       keys,
		onChange:   onChange,
		now:        time.Now,
		root:       root,
		cancelRoot: cancel,
		status:     types.ProviderSubscriptionStatus{State: types.SubscriptionStateAwaitingIdentity, Provider: cfg.Provider},
	}
}

// Start follows identity transitions, then resolves for the identity already
// present. Subscribing first means an identity published in between is never
// lost; the same identity applied twice is a no-op.
func (m *Manager) Start() {
	unsub := auth.SubscribeContextIdentityChanges(func(change auth.ContextIdentityChange) {
		m.applyIdentity(change.Identity, change.Reason)
	})
	m.mu.Lock()
	m.unsub = unsub
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription lookup started", map[string]any{
		"url": m.cfg.Endpoint, "provider": m.cfg.Provider, "limit": m.cfg.CacheMaxAgeSeconds,
	})
	var identity *auth.ContextIdentity
	if provider := auth.CurrentContextIdentityProvider(); provider != nil {
		identity = provider.ContextIdentity()
	}
	m.applyIdentity(identity, "initial")
}

// Stop ends the identity subscription and any lookup in flight.
func (m *Manager) Stop() {
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	m.stopped = true
	unsub := m.unsub
	m.mu.Unlock()
	if unsub != nil {
		unsub()
	}
	m.cancelRoot()
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription lookup stopped", map[string]any{"provider": m.cfg.Provider})
}

// Status returns the current snapshot.
func (m *Manager) Status() types.ProviderSubscriptionStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	return cloneStatus(m.status)
}

func cloneStatus(status types.ProviderSubscriptionStatus) types.ProviderSubscriptionStatus {
	out := status
	if status.Selected != nil {
		selected := *status.Selected
		out.Selected = &selected
	}
	if status.Options != nil {
		out.Options = append([]types.SubscriptionOption(nil), status.Options...)
	}
	return out
}

func (m *Manager) publish() {
	m.publishMu.Lock()
	defer m.publishMu.Unlock()
	status := m.Status()
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription state changed", map[string]any{
		"provider": status.Provider, "state": status.State, "source": status.Source, "count": len(status.Options),
	})
	if m.onChange != nil {
		m.onChange(status)
	}
}

func identityKeyOf(identity *auth.ContextIdentity) string {
	if identity == nil {
		return ""
	}
	return identity.Kind + "\x00" + identity.Provider + "\x00" + identity.Subject
}

// applyIdentity is the single entry point for identity transitions.
// Renewals republish an unchanged identity; those are no-ops.
func (m *Manager) applyIdentity(identity *auth.ContextIdentity, reason string) {
	key := identityKeyOf(identity)
	m.mu.Lock()
	if m.stopped {
		m.mu.Unlock()
		return
	}
	if key == m.identityKey && (identity != nil) == m.signedIn {
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "subscription", "identity unchanged; subscription kept", map[string]any{"reason": reason, "provider": m.cfg.Provider})
		return
	}
	m.generation++
	generation := m.generation
	m.identityKey = key
	m.signedIn = identity != nil
	m.partition = ""
	if identity != nil {
		m.partition = identity.Subject
	}
	m.remembered = ""
	m.results = nil
	m.resultsAt = 0
	partition := m.partition
	m.keys.ClearSubscriptionKey(m.cfg.Provider)
	if identity == nil {
		m.status = types.ProviderSubscriptionStatus{State: types.SubscriptionStateAwaitingIdentity, Provider: m.cfg.Provider}
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "subscription", "identity signed out; subscription key removed", map[string]any{"reason": reason, "provider": m.cfg.Provider})
		m.publish()
		return
	}
	m.mu.Unlock()

	entry := m.loadCache(partition)

	m.mu.Lock()
	if generation != m.generation || m.stopped {
		m.mu.Unlock()
		return
	}
	if entry == nil {
		m.status = types.ProviderSubscriptionStatus{State: types.SubscriptionStateResolving, Provider: m.cfg.Provider}
		m.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "subscription", "no cached subscription; looking up", map[string]any{"reason": reason, "provider": m.cfg.Provider})
		m.publish()
		go m.lookupAsync(generation, "no_cache")
		return
	}
	m.remembered = entry.SelectedID
	m.keys.SetSubscriptionKey(m.cfg.Provider, entry.Key)
	m.status = types.ProviderSubscriptionStatus{
		State:      types.SubscriptionStateApplied,
		Provider:   m.cfg.Provider,
		Selected:   &types.SubscriptionOption{ID: entry.SelectedID, Label: entry.Label},
		Options:    entry.Options,
		Source:     types.SubscriptionSourceCache,
		ResolvedAt: entry.ResolvedAt,
	}
	expired := m.cacheExpired(entry.ResolvedAt)
	m.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "subscription", "cached subscription applied", map[string]any{
		"reason": reason, "provider": m.cfg.Provider, "subscription_id": entry.SelectedID, "expired": expired,
	})
	m.publish()
	if expired {
		go m.lookupAsync(generation, "cache_expired")
	}
}

func (m *Manager) loadCache(partition string) *CacheEntry {
	if partition == "" {
		utils.LogWithFields(utils.LevelInfo, "subscription", "identity has no subject; subscription cache unused", map[string]any{"provider": m.cfg.Provider})
		return nil
	}
	entry, err := m.cache.Load(partition, m.cfg.Provider)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "subscription", "subscription cache unreadable; looking up", map[string]any{"provider": m.cfg.Provider, "error": err.Error()})
		return nil
	}
	if entry == nil || entry.Key == "" || entry.SelectedID == "" {
		return nil
	}
	return entry
}

// cacheExpired reports whether a cached key is past CacheMaxAgeSeconds.
// Zero means a cached key never expires on its own.
func (m *Manager) cacheExpired(resolvedAt int64) bool {
	if m.cfg.CacheMaxAgeSeconds <= 0 {
		return false
	}
	age := m.now().Sub(time.UnixMilli(resolvedAt))
	return age >= time.Duration(m.cfg.CacheMaxAgeSeconds)*time.Second
}

func (m *Manager) lookupAsync(generation uint64, reason string) {
	if _, err := m.lookup(generation, reason); err != nil {
		utils.LogWithFields(utils.LevelWarn, "subscription", "background subscription lookup failed", map[string]any{"reason": reason, "provider": m.cfg.Provider, "error": err.Error()})
	}
}

// lookup runs one lookup for generation and settles its result. It returns
// the lookup error, if any; the state it leaves is always published.
func (m *Manager) lookup(generation uint64, reason string) ([]Subscription, error) {
	ctx, cancel := context.WithTimeout(m.root, time.Duration(m.cfg.LookupTimeoutMs())*time.Millisecond)
	defer cancel()
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription lookup requested", map[string]any{"reason": reason, "url": m.cfg.Endpoint, "provider": m.cfg.Provider})
	started := m.now()
	results, err := m.fetch(ctx, m.cfg)
	fields := map[string]any{"reason": reason, "provider": m.cfg.Provider, "duration_ms": m.now().Sub(started).Milliseconds()}
	if err != nil {
		fields["error"] = err.Error()
		utils.LogWithFields(utils.LevelWarn, "subscription", "subscription lookup failed", fields)
	} else {
		fields["count"] = len(results)
		utils.LogWithFields(utils.LevelInfo, "subscription", "subscription lookup succeeded", fields)
	}
	if !m.settle(generation, results, err) {
		return nil, fmt.Errorf("identity changed during the lookup")
	}
	m.publish()
	return results, err
}

// settle applies one lookup result. It returns false when the identity
// changed while the lookup ran; the stale result is then dropped.
func (m *Manager) settle(generation uint64, results []Subscription, lookupErr error) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if generation != m.generation || m.stopped {
		utils.LogWithFields(utils.LevelInfo, "subscription", "stale subscription lookup dropped", map[string]any{"provider": m.cfg.Provider})
		return false
	}
	if lookupErr != nil {
		m.status.Error = lookupErr.Error()
		if m.status.State != types.SubscriptionStateApplied {
			m.status.State = types.SubscriptionStateFailed
			m.status.Selected = nil
			m.status.Source = ""
		}
		utils.LogWithFields(utils.LevelInfo, "subscription", "lookup failure settled", map[string]any{"provider": m.cfg.Provider, "state": m.status.State})
		return true
	}
	resolvedAt := m.now().UnixMilli()
	m.results = results
	m.resultsAt = resolvedAt
	options := make([]types.SubscriptionOption, 0, len(results))
	for _, result := range results {
		options = append(options, result.Option())
	}
	switch {
	case len(results) == 0:
		m.keys.ClearSubscriptionKey(m.cfg.Provider)
		m.deleteCacheLocked()
		m.remembered = ""
		m.status = types.ProviderSubscriptionStatus{State: types.SubscriptionStateNone, Provider: m.cfg.Provider, ResolvedAt: resolvedAt}
		utils.LogWithFields(utils.LevelInfo, "subscription", "lookup returned no subscriptions", map[string]any{"provider": m.cfg.Provider})
	case len(results) == 1:
		m.applyLocked(results[0], options, resolvedAt, "single")
	default:
		for _, result := range results {
			if result.ID == m.remembered {
				m.applyLocked(result, options, resolvedAt, "remembered")
				return true
			}
		}
		m.keys.ClearSubscriptionKey(m.cfg.Provider)
		m.status = types.ProviderSubscriptionStatus{
			State: types.SubscriptionStateSelectionRequired, Provider: m.cfg.Provider, Options: options, ResolvedAt: resolvedAt,
		}
		utils.LogWithFields(utils.LevelInfo, "subscription", "lookup returned several subscriptions; selection required", map[string]any{
			"provider": m.cfg.Provider, "count": len(results), "status": m.remembered != "",
		})
	}
	return true
}

// applyLocked applies one subscription's key, remembers it, and caches it.
func (m *Manager) applyLocked(chosen Subscription, options []types.SubscriptionOption, resolvedAt int64, reason string) {
	m.keys.SetSubscriptionKey(m.cfg.Provider, chosen.Key)
	m.remembered = chosen.ID
	selected := chosen.Option()
	m.status = types.ProviderSubscriptionStatus{
		State: types.SubscriptionStateApplied, Provider: m.cfg.Provider, Selected: &selected,
		Options: options, Source: types.SubscriptionSourceLookup, ResolvedAt: resolvedAt,
	}
	utils.LogWithFields(utils.LevelInfo, "subscription", "subscription applied", map[string]any{
		"reason": reason, "provider": m.cfg.Provider, "subscription_id": chosen.ID,
	})
	if m.partition == "" {
		return
	}
	entry := CacheEntry{SelectedID: chosen.ID, Label: chosen.Label, Key: chosen.Key, Options: options, ResolvedAt: resolvedAt}
	if err := m.cache.Save(m.partition, m.cfg.Provider, entry); err != nil {
		utils.LogWithFields(utils.LevelError, "subscription", "subscription cache write failed; key applied for this run only", map[string]any{"provider": m.cfg.Provider, "error": err.Error()})
	}
}

func (m *Manager) deleteCacheLocked() {
	if m.partition == "" {
		return
	}
	if err := m.cache.Delete(m.partition, m.cfg.Provider); err != nil {
		utils.LogWithFields(utils.LevelError, "subscription", "subscription cache delete failed", map[string]any{"provider": m.cfg.Provider, "error": err.Error()})
	}
}

// errNotSignedIn answers a request that needs an identity.
var errNotSignedIn = fmt.Errorf("no identity is signed in; sign in before looking up a subscription")

// Refresh runs a fresh lookup now and returns the state it leaves.
func (m *Manager) Refresh() (types.ProviderSubscriptionStatus, error) {
	m.mu.Lock()
	signedIn, generation := m.signedIn, m.generation
	m.mu.Unlock()
	if !signedIn {
		return m.Status(), errNotSignedIn
	}
	_, err := m.lookup(generation, "refresh")
	return m.Status(), err
}

// Select applies the subscription with id and remembers the choice. It uses
// the last lookup's response when that response offered id, and looks up
// again otherwise (after a restart, only the selected key is cached).
func (m *Manager) Select(id string) (types.ProviderSubscriptionStatus, error) {
	if id == "" {
		return m.Status(), fmt.Errorf("a subscription id is required")
	}
	if m.selectFromResults(id) {
		m.publish()
		return m.Status(), nil
	}
	m.mu.Lock()
	signedIn, generation := m.signedIn, m.generation
	m.mu.Unlock()
	if !signedIn {
		return m.Status(), errNotSignedIn
	}
	utils.LogWithFields(utils.LevelInfo, "subscription", "selected subscription not in memory; looking up", map[string]any{"provider": m.cfg.Provider, "subscription_id": id})
	if _, err := m.lookup(generation, "select"); err != nil {
		return m.Status(), err
	}
	if m.selectFromResults(id) {
		m.publish()
		return m.Status(), nil
	}
	utils.LogWithFields(utils.LevelWarn, "subscription", "selected subscription not offered", map[string]any{"provider": m.cfg.Provider, "subscription_id": id})
	return m.Status(), fmt.Errorf("subscription %q is not offered to this identity", id)
}

func (m *Manager) selectFromResults(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.signedIn {
		return false
	}
	options := make([]types.SubscriptionOption, 0, len(m.results))
	for _, result := range m.results {
		options = append(options, result.Option())
	}
	for _, result := range m.results {
		if result.ID == id {
			m.applyLocked(result, options, m.resultsAt, "selected")
			return true
		}
	}
	return false
}
