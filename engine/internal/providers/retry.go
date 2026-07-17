package providers

import (
	"context"
	"math"
	"math/rand"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// RetryConfig controls retry behavior for provider streams.
//
// FallbackChain is walked in order after MaxOverloadedBeforeFallback overload
// errors. Each entry is a model name (any provider resolved by ResolveProvider).
// When the chain is exhausted, the loop falls back to normal retry/backoff
// behavior with the last-attempted model.
type RetryConfig struct {
	MaxRetries                  int
	BaseDelayMs                 int
	MaxDelayMs                  int
	FallbackChain               []string
	MaxOverloadedBeforeFallback int
	Persistent                  bool
	PersistentMaxDelayMs        int
	PersistentMaxWaitMs         int64
	OnRetryWait                 func(attempt, delayMs int, err *ProviderError)
	OnFallback                  func(fromModel, toModel string, hopIndex int)
}

func (c *RetryConfig) maxRetries() int {
	if c == nil || c.MaxRetries == 0 {
		return 5
	}
	return c.MaxRetries
}

func (c *RetryConfig) baseDelay() int {
	if c == nil || c.BaseDelayMs == 0 {
		return 1000
	}
	return c.BaseDelayMs
}

func (c *RetryConfig) maxDelay() int {
	if c == nil || c.MaxDelayMs == 0 {
		return 30000
	}
	return c.MaxDelayMs
}

func (c *RetryConfig) maxOverloaded() int {
	if c == nil || c.MaxOverloadedBeforeFallback == 0 {
		return 3
	}
	return c.MaxOverloadedBeforeFallback
}

func (c *RetryConfig) persistentMaxDelay() int {
	if c == nil || c.PersistentMaxDelayMs == 0 {
		return 300000
	}
	return c.PersistentMaxDelayMs
}

func (c *RetryConfig) persistentMaxWait() int64 {
	if c == nil || c.PersistentMaxWaitMs == 0 {
		return 21600000 // 6 hours
	}
	return c.PersistentMaxWaitMs
}

func (c *RetryConfig) isPersistent() bool {
	return c != nil && c.Persistent
}

// WithRetry wraps a provider stream call with retry logic including exponential
// backoff, jitter, model fallback on repeated overloaded errors, and persistent
// mode for CI/headless use.
//
// Events are forwarded to the caller live, as the provider emits them. When a
// retryable failure interrupts a stream that has already forwarded events, a
// stream_reset marker (types.LlmStreamEventStreamReset) is sent before the
// next attempt's events — the caller must discard all state accumulated for
// the interrupted attempt on receipt.
func WithRetry(ctx context.Context, provider LlmProvider, opts types.LlmStreamOptions, config *RetryConfig) (<-chan types.LlmStreamEvent, <-chan error) {
	events := make(chan types.LlmStreamEvent, 32)
	errc := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errc)

		currentProvider := provider
		currentModel := opts.Model
		overloadedCount := 0
		attempt := 0
		fallbackIdx := -1 // -1 = primary; 0..len(chain)-1 = chain hop
		startTime := time.Now()

		// Events are forwarded to the caller as they arrive so consumers
		// stream live — time-to-first-token is a user-visible property of
		// every client. The cost of live forwarding is that a failed attempt
		// may have already delivered partial events; forwardedSinceReset
		// tracks that, and sendReset injects the in-band stream_reset marker
		// (types.LlmStreamEventStreamReset) before the next attempt's events
		// so the caller discards the partial state. sendReset returns false
		// only when the context died mid-send.
		forwardedSinceReset := false
		sendReset := func() bool {
			if !forwardedSinceReset {
				return true
			}
			select {
			case events <- types.LlmStreamEvent{Type: types.LlmStreamEventStreamReset}:
				forwardedSinceReset = false
				return true
			case <-ctx.Done():
				return false
			}
		}

		for {
			streamOpts := opts
			streamOpts.Model = currentModel

			evCh, errCh := currentProvider.Stream(ctx, streamOpts)

			// Forward each event to the caller immediately.
			var streamErr error
			for ev := range evCh {
				if ctx.Err() != nil {
					errc <- ctx.Err()
					return
				}
				select {
				case events <- ev:
					forwardedSinceReset = true
				case <-ctx.Done():
					errc <- ctx.Err()
					return
				}
			}

			// Check for stream error
			if errCh != nil {
				streamErr = <-errCh
			}

			// Stream completed without error — done.
			if streamErr == nil {
				return
			}

			// Context cancelled is not retryable
			if ctx.Err() != nil {
				errc <- ctx.Err()
				return
			}

			// Convert to ProviderError
			pe, ok := streamErr.(*ProviderError)
			if !ok {
				errc <- streamErr
				return
			}
			pe.Attempt = attempt

			// Not retryable
			if !pe.Retryable {
				errc <- pe
				return
			}

			// Stale connection: disable keepalive for future requests
			if pe.Code == ErrStaleConn {
				DisableKeepAlive()
			}

			// Track overloaded for model fallback
			if pe.Code == ErrOverloaded {
				overloadedCount++
			}

			// Walk fallback chain after N overload errors. Each hop resets
			// the overload counter so the next link gets its own budget.
			if overloadedCount >= config.maxOverloaded() && config != nil && fallbackIdx+1 < len(config.FallbackChain) {
				next := config.FallbackChain[fallbackIdx+1]
				if next != "" && next != currentModel {
					if fallback := ResolveProvider(next); fallback != nil {
						// Discard any partial output the failed attempt
						// already forwarded before the fallback re-streams.
						if !sendReset() {
							errc <- ctx.Err()
							return
						}
						if config.OnFallback != nil {
							config.OnFallback(currentModel, next, fallbackIdx+1)
						}
						currentProvider = fallback
						currentModel = next
						fallbackIdx++
						overloadedCount = 0
						continue // retry immediately with new model
					}
				}
			}

			attempt++

			// Check retry limits
			if !config.isPersistent() && attempt > config.maxRetries() {
				errc <- pe
				return
			}

			// Persistent mode: check total wall time
			if config.isPersistent() && time.Since(startTime).Milliseconds() > config.persistentMaxWait() {
				errc <- pe
				return
			}

			// This attempt will be retried. Discard any partial output it
			// already forwarded — before the backoff wait, so consumers drop
			// the stale partial state immediately rather than after the delay.
			if !sendReset() {
				errc <- ctx.Err()
				return
			}

			// Calculate delay with exponential backoff + jitter
			cap := config.maxDelay()
			if config.isPersistent() {
				cap = config.persistentMaxDelay()
			}
			delay := int(math.Min(float64(config.baseDelay())*math.Pow(2, float64(attempt-1)), float64(cap)))
			jitter := int(rand.Float64() * 0.25 * float64(delay))
			totalDelay := delay + jitter

			// Use retry-after from provider if larger
			if pe.RetryAfterMs > 0 && int(pe.RetryAfterMs) > totalDelay {
				totalDelay = int(pe.RetryAfterMs)
			}

			// Notify callback
			if config != nil && config.OnRetryWait != nil {
				config.OnRetryWait(attempt, totalDelay, pe)
			}

			// Wait with context cancellation
			timer := time.NewTimer(time.Duration(totalDelay) * time.Millisecond)
			select {
			case <-timer.C:
				// continue to next attempt
			case <-ctx.Done():
				timer.Stop()
				errc <- ctx.Err()
				return
			}
		}
	}()

	return events, errc
}
