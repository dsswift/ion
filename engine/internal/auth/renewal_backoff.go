package auth

import (
	"sync"
	"time"
)

const (
	renewalBackoffBase = 15 * time.Second
	renewalBackoffMax  = 5 * time.Minute
)

// renewalBackoff spaces out background identity renewals after they fail.
// The wait doubles with each consecutive failure, from renewalBackoffBase up
// to renewalBackoffMax, and a success clears it. The zero value is ready to
// use and always due.
type renewalBackoff struct {
	mu       sync.Mutex
	failures int
	retryAt  time.Time
}

// due reports whether a renewal may start at now.
func (b *renewalBackoff) due(now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return !now.Before(b.retryAt)
}

// failed records a failed renewal at now and returns how long until the next
// one may start.
func (b *renewalBackoff) failed(now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.failures++
	wait := renewalBackoffBase
	for i := 1; i < b.failures && wait < renewalBackoffMax; i++ {
		wait *= 2
	}
	if wait > renewalBackoffMax {
		wait = renewalBackoffMax
	}
	b.retryAt = now.Add(wait)
	return wait
}

// succeeded clears the backoff. It reports whether there was one to clear.
func (b *renewalBackoff) succeeded() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	had := b.failures > 0
	b.failures = 0
	b.retryAt = time.Time{}
	return had
}
