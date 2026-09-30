package appconfig

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Fetcher resolves the configuration document for the current process
// principal. It runs with a context bounded by the source's timeout. prior
// holds the validators of the last resolved document, empty on the first
// resolution. HTTPFetcher is the engine's implementation; the type is the
// seam for any other source.
type Fetcher func(ctx context.Context, source types.ApplicationConfigSource, prior Validators) (FetchResult, error)

// Store owns the application config lifecycle for one engine process. It
// holds exactly one principal's snapshot at a time: the verified process
// identity. A change of identity purges the old snapshot before the new
// principal's resolution begins.
type Store struct {
	source  types.ApplicationConfigSource
	fetch   Fetcher
	refresh time.Duration
	timeout time.Duration

	mu          sync.Mutex
	current     Snapshot
	changed     chan struct{}
	identityKey string
	generation  uint64
	cancelRun   context.CancelFunc
	stopped     bool
	unsubscribe func()
	notify      *notifier
}

// NewStore builds a store for source. It stays deferred until Start.
func NewStore(source types.ApplicationConfigSource, fetch Fetcher) *Store {
	return &Store{
		source:  source,
		fetch:   fetch,
		refresh: time.Duration(source.RefreshInterval()) * time.Second,
		timeout: time.Duration(source.FetchTimeoutMs()) * time.Millisecond,
		current: Snapshot{State: StateDeferred},
		changed: make(chan struct{}),
		notify:  newNotifier(),
	}
}

// Start subscribes to identity transitions, then resolves for the identity
// already present (a grant reconciled at startup, or a workload identity).
// Subscribing first means an identity published in between is never lost;
// applying the same identity twice is a no-op.
func (s *Store) Start() {
	unsubscribe := auth.SubscribeContextIdentityChanges(func(change auth.ContextIdentityChange) {
		s.applyIdentity(change.Identity, change.Reason)
	})
	s.mu.Lock()
	s.unsubscribe = unsubscribe
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config store started", map[string]any{
		"endpoint": s.source.Endpoint, "refresh_seconds": int(s.refresh / time.Second),
	})
	var identity *auth.ContextIdentity
	if provider := auth.CurrentContextIdentityProvider(); provider != nil {
		identity = provider.ContextIdentity()
	}
	s.applyIdentity(identity, "initial")
}

// Stop ends the identity subscription and any in-flight resolution. The
// snapshot is dropped with the store; nothing was ever written to disk.
func (s *Store) Stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	unsubscribe := s.unsubscribe
	s.unsubscribe = nil
	if s.cancelRun != nil {
		s.cancelRun()
		s.cancelRun = nil
	}
	s.mu.Unlock()
	if unsubscribe != nil {
		unsubscribe()
	}
	s.notify.close()
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config store stopped", nil)
}

// Snapshot returns the current process snapshot. It is immutable; readers
// outside the engine receive a View of it.
func (s *Store) Snapshot() Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

// Await blocks until subject's view is settled (values available, failed,
// or disabled) or ctx ends. It always returns the latest snapshot; the
// error is ctx's when the wait ended before the view settled.
func (s *Store) Await(ctx context.Context, subject string) (Snapshot, error) {
	for {
		s.mu.Lock()
		current := s.current
		changed := s.changed
		s.mu.Unlock()
		if current.View(subject, "").State.Settled() {
			return current, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return current, ctx.Err()
		}
	}
}

func identityKeyOf(identity *auth.ContextIdentity) string {
	if identity == nil {
		return ""
	}
	return identity.Kind + "\x00" + identity.Provider + "\x00" + identity.Subject
}

// applyIdentity is the single entry point for identity transitions. The
// same identity is a no-op, which is what makes resolution happen once per
// identity: renewals and reconciles republish an unchanged identity.
func (s *Store) applyIdentity(identity *auth.ContextIdentity, reason string) {
	key := identityKeyOf(identity)
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	if key == s.identityKey {
		state := s.current.State
		s.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "appconfig", "identity unchanged; snapshot kept", map[string]any{"reason": reason, "state": state})
		return
	}
	if s.cancelRun != nil {
		s.cancelRun()
		s.cancelRun = nil
	}
	s.generation++
	s.identityKey = key
	if identity == nil {
		previous := s.current.Subject
		s.transitionLocked(Snapshot{State: StateDeferred})
		s.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "appconfig", "application config purged", map[string]any{"reason": reason, "previous_subject": previous})
		return
	}
	generation := s.generation
	runCtx, cancel := context.WithCancel(context.Background())
	s.cancelRun = cancel
	s.transitionLocked(Snapshot{State: StateFetching, Subject: identity.Subject, Provider: identity.Provider})
	s.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config resolution started", map[string]any{
		"reason": reason, "subject": identity.Subject, "provider": identity.Provider, "generation": generation,
	})
	go s.run(runCtx, generation, identity.Subject, identity.Provider)
}

// run resolves, then refreshes on the interval, until the generation is
// purged. A refresh passes through refreshing, never fetching: readers keep
// the previous values until the next document replaces them whole.
func (s *Store) run(ctx context.Context, generation uint64, subject, provider string) {
	timer := time.NewTimer(0)
	defer timer.Stop()
	var validators Validators
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if !s.beginRefresh(generation) {
			return
		}
		fetchCtx, cancel := context.WithTimeout(ctx, s.timeout)
		result, err := s.fetch(fetchCtx, s.source, validators)
		cancel()
		if ctx.Err() != nil {
			utils.LogWithFields(utils.LevelInfo, "appconfig", "application config result discarded; identity changed", map[string]any{"subject": subject, "generation": generation})
			return
		}
		if s.complete(generation, subject, provider, result, err) {
			validators = result.Validators
		}
		timer.Reset(s.refresh)
	}
}

// beginRefresh moves a ready snapshot to refreshing before a refresh
// fetch. It reports false when the generation is gone.
func (s *Store) beginRefresh(generation uint64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || generation != s.generation {
		return false
	}
	if s.current.State == StateReady {
		next := s.current
		next.State = StateRefreshing
		s.transitionLocked(next)
		utils.LogWithFields(utils.LevelInfo, "appconfig", "application config refresh started", map[string]any{
			"subject": s.current.Subject, "revision": s.current.Revision,
		})
	}
	return true
}

// complete applies one fetch outcome. It reports whether the outcome
// installed or confirmed a document, so the caller keeps its validators.
func (s *Store) complete(generation uint64, subject, provider string, result FetchResult, err error) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || generation != s.generation {
		utils.LogWithFields(utils.LevelInfo, "appconfig", "application config result discarded; identity changed", map[string]any{"subject": subject, "generation": generation})
		return false
	}
	if err == nil && result.NotModified && s.current.Document == nil {
		err = errors.New("source answered not modified with no previous document")
	}
	if err == nil && !result.NotModified && result.Document == nil {
		err = errors.New("source returned no document")
	}
	if err != nil {
		if s.current.State.HasValues() {
			next := s.current
			next.State = StateReady
			s.transitionLocked(next)
			utils.LogWithFields(utils.LevelWarn, "appconfig", "application config refresh failed; previous snapshot kept", map[string]any{
				"subject": subject, "revision": s.current.Revision, "error": err.Error(),
			})
			return false
		}
		if s.current.State == StateFailed && s.current.Error == err.Error() {
			utils.LogWithFields(utils.LevelWarn, "appconfig", "application config retry failed", map[string]any{
				"subject": subject, "revision": s.current.Revision, "error": err.Error(),
			})
			return false
		}
		s.transitionLocked(Snapshot{State: StateFailed, Subject: subject, Provider: provider, Error: err.Error()})
		utils.LogWithFields(utils.LevelWarn, "appconfig", "application config resolution failed", map[string]any{
			"subject": subject, "revision": s.current.Revision, "retry_seconds": int(s.refresh / time.Second), "error": err.Error(),
		})
		return false
	}
	if result.NotModified {
		next := s.current
		next.State = StateReady
		s.transitionLocked(next)
		utils.LogWithFields(utils.LevelInfo, "appconfig", "application config unchanged", map[string]any{
			"subject": subject, "revision": s.current.Revision,
		})
		return true
	}
	s.transitionLocked(Snapshot{
		State: StateReady, Subject: subject, Provider: provider, Document: result.Document,
		FetchedAt: time.Now().UTC().Format(time.RFC3339),
	})
	utils.LogWithFields(utils.LevelInfo, "appconfig", "application config ready", map[string]any{
		"subject": subject, "revision": s.current.Revision,
		"common_count":       len(result.Document.Common.Values) + len(result.Document.Common.Secrets),
		"extension_sections": len(result.Document.Extensions),
	})
	return true
}

// transitionLocked installs next as the whole snapshot, wakes waiters, and
// queues the transition for subscribers in order. Callers hold s.mu.
func (s *Store) transitionLocked(next Snapshot) {
	next.Revision = s.current.Revision + 1
	s.current = next
	close(s.changed)
	s.changed = make(chan struct{})
	s.notify.enqueue(next)
}
