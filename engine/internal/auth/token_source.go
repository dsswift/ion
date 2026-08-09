package auth

import (
	"context"
	"fmt"
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

func (c *machineTokenCache) expiry(scope, audience string) time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.entries[cacheKey(scope, audience)].expiresAt
}

func (c *machineTokenCache) getOrAcquire(
	ctx context.Context,
	provider, sourceKind, scope, audience string,
	acquire func(context.Context) (string, time.Time, error),
) (string, error) {
	key := cacheKey(scope, audience)
	c.mu.Lock()
	if cached, ok := c.entries[key]; ok && cached.token != "" && time.Now().Add(c.threshold).Before(cached.expiresAt) {
		c.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "auth.machine", "machine token cache hit", map[string]any{
			"provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
		})
		return cached.token, nil
	}
	if flight, ok := c.flights[key]; ok {
		c.mu.Unlock()
		utils.LogWithFields(utils.LevelDebug, "auth.machine", "joined machine token acquisition", map[string]any{
			"provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
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
		"provider": provider, "source": sourceKind, "scope": scope, "audience": audience,
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
			"provider": provider, "source": sourceKind, "scope": scope, "audience": audience, "error": err.Error(),
		})
		return "", err
	}
	utils.LogWithFields(utils.LevelInfo, "auth.machine", "machine token acquired", map[string]any{
		"provider": provider, "source": sourceKind, "scope": scope, "audience": audience, "expires_at": expiresAt,
	})
	return token, nil
}
