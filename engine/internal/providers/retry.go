package providers

import (
	"context"
	"math"
	"math/rand"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// RetryConfig controls retry behavior for provider streams.
type RetryConfig struct {
	MaxRetries                  int
	BaseDelayMs                 int
	MaxDelayMs                  int
	FallbackModel               string
	MaxOverloadedBeforeFallback int
	Persistent                  bool
	PersistentMaxDelayMs        int
	PersistentMaxWaitMs         int64
	OnRetryWait                 func(attempt, delayMs int, err *ProviderError)
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
		startTime := time.Now()

		for {
			streamOpts := opts
			streamOpts.Model = currentModel

			evCh, errCh := currentProvider.Stream(ctx, streamOpts)

			// Buffer events per attempt. Only forward to caller after the
			// stream completes without error. On retry, discard the buffer
			// so the caller never sees partial results from failed attempts.
			var buf []types.LlmStreamEvent
			var streamErr error
			for ev := range evCh {
				if ctx.Err() != nil {
					errc <- ctx.Err()
					return
				}
				buf = append(buf, ev)
			}

			// Check for stream error
			if errCh != nil {
				streamErr = <-errCh
			}

			// Stream completed without error — flush buffer to caller
			if streamErr == nil {
				for _, ev := range buf {
					select {
					case events <- ev:
					case <-ctx.Done():
						errc <- ctx.Err()
						return
					}
				}
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

			// Model fallback after N overloaded errors
			if overloadedCount >= config.maxOverloaded() && config != nil && config.FallbackModel != "" && config.FallbackModel != currentModel {
				fallback := ResolveProvider(config.FallbackModel)
				if fallback != nil {
					currentProvider = fallback
					currentModel = config.FallbackModel
					overloadedCount = 0
					continue // retry immediately with new model
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
