package auth

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// TokenSource acquires one short-lived bearer token. Implementations own only
// the provider protocol; machineTokenCache owns caching and singleflight.
type TokenSource interface {
	Acquire(ctx context.Context, scope, audience string) (string, time.Time, error)
}

type tokenFlight struct {
	done      chan struct{}
	token     string
	expiresAt time.Time
	err       error
}

type cachedMachineToken struct {
	token     string
	expiresAt time.Time
}

// machineTokenCache caches tokens by exact scope+audience and coalesces
// concurrent acquisition for one key. Different resources remain independent.
type machineTokenCache struct {
	mu        sync.Mutex
	entries   map[string]cachedMachineToken
	flights   map[string]*tokenFlight
	threshold time.Duration
}

func newMachineTokenCache(threshold time.Duration) *machineTokenCache {
	if threshold <= 0 {
		threshold = defaultRefreshThreshold
	}
	return &machineTokenCache{
		entries:   make(map[string]cachedMachineToken),
		flights:   make(map[string]*tokenFlight),
		threshold: threshold,
	}
}

func (c *machineTokenCache) expiry(subject, scope, audience string) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.entries[cacheKey(subject, scope, audience)].expiresAt
}

func (c *machineTokenCache) getOrAcquire(
	ctx context.Context,
	subject, provider, sourceKind, scope, audience string,
	acquire func(context.Context) (string, time.Time, error),
) (string, error) {
	key := cacheKey(subject, scope, audience)
	c.mu.Lock()
	if cached, ok := c.entries[key]; ok && cached.token != "" && time.Now().Add(c.threshold).Before(cached.expiresAt) {
		c.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "auth.machine", "machine token cache hit", map[string]any{
			"subject": subject, "provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
		})
		return cached.token, nil
	}
	if flight, ok := c.flights[key]; ok {
		c.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "auth.machine", "joined machine token acquisition", map[string]any{
			"subject": subject, "provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
		})
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-flight.done:
			return flight.token, flight.err
		}
	}
	flight := &tokenFlight{done: make(chan struct{})}
	c.flights[key] = flight
	c.mu.Unlock()

	utils.LogWithFields(utils.LevelDebug, "auth.machine", "machine token acquisition started", map[string]any{
		"subject": subject, "provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
	})
	token, expiresAt, err := acquire(ctx)
	if err == nil && (token == "" || expiresAt.IsZero()) {
		err = fmt.Errorf("credential source returned an empty token or expiry")
	}

	c.mu.Lock()
	if err == nil {
		c.entries[key] = cachedMachineToken{token: token, expiresAt: expiresAt}
	}
	flight.token = token
	flight.expiresAt = expiresAt
	flight.err = err
	delete(c.flights, key)
	close(flight.done)
	c.mu.Unlock()

	if err != nil {
		utils.LogWithFields(utils.LevelError, "auth.machine", "machine token acquisition failed", map[string]any{
			"subject": subject, "provider": provider, "source": sourceKind, "scope": scope, "audience": audience, "error": err.Error(),
		})
		return "", err
	}
	utils.LogWithFields(utils.LevelInfo, "auth.machine", "machine token acquired", map[string]any{
		"subject": subject, "provider": provider, "source": sourceKind, "scope": scope, "audience": audience, "expires_at": expiresAt,
	})
	return token, nil
}

// dropByPrefix removes every cached entry and in-flight acquisition whose key
// starts with prefix. Used by InvalidateAuthenticatorCache (child 07) to drop
// one principal's cached tokens without touching another's -- cacheKey's
// leading "<subject>\x00" segment makes a subject's entries a contiguous
// prefix, so dropping them never depends on knowing the exact scope/audience
// that was cached.
func (c *machineTokenCache) dropByPrefix(prefix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	dropped := 0
	for k := range c.entries {
		if strings.HasPrefix(k, prefix) {
			delete(c.entries, k)
			dropped++
		}
	}
	for k := range c.flights {
		if strings.HasPrefix(k, prefix) {
			delete(c.flights, k)
		}
	}
	return dropped
}

// sharedPrincipalTokenCache is the one machineTokenCache that a
// PrincipalTokenProvider's subject-bound tokens are cached and coalesced
// through (subjectBoundProvider, registry.go). It exists so any future
// PrincipalTokenProvider implementation -- and child 07's
// InvalidateAuthenticatorCache -- share exactly one cache rather than each
// inventing its own; there is deliberately no second caching mechanism
// anywhere in this program (R-04).
var sharedPrincipalTokenCache = newMachineTokenCache(defaultRefreshThreshold)
