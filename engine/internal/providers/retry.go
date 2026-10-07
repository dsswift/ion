package providers

import (
	"context"
	"math"
	"math/rand"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
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
	// OnAttemptStart observes one request to a provider: it is called as
	// the attempt's Stream begins and returns the function WithRetry calls
	// when the attempt ends, with how it ended (AttemptOutcome*), the time
	// to the attempt's first event in milliseconds (0 when none arrived),
	// and the error for every outcome but ok. Nil observes nothing. The
	// backend records each attempt as an llm.attempt span through it.
	OnAttemptStart func(attempt int, model, providerID string) func(outcome string, ttftMs float64, err error)
	// AttachAuth re-resolves and attaches the acting principal's request
	// credential for providerID, returning the context WithRequestCredential
	// carries it on. Called before every Stream call -- the initial one and
	// each fallback-chain hop -- because a hop can switch to a different
	// provider than the one the caller originally attached auth for (R-02,
	// R-03: a fallback must authenticate as the SAME principal, never fall
	// back to a shared/no credential). nil means the context already carries
	// whatever credential the caller attached and is used unchanged --
	// preserves the pre-existing behavior for any caller that never adopted
	// per-principal credentials.
	AttachAuth func(ctx context.Context, providerID string) context.Context
	// Subject is the acting principal, used only for the auth-rejection
	// self-heal below (child 07, R-19). "" is the unattributed principal --
	// InvalidatePrincipal("", providerID) still clears that principal's own
	// cached negative/entitlement/token state, so self-heal is meaningful
	// even for a single-user engine that keeps stale state around (a
	// revoked key that was cached positive nowhere, but whose entitlement or
	// negative HasKey cache could still be stale).
	Subject string
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
// How one provider attempt ended, as reported to RetryConfig.OnAttemptStart.
const (
	AttemptOutcomeOK        = "ok"        // the stream completed
	AttemptOutcomeRetry     = "retry"     // a retryable error; the same model is tried again
	AttemptOutcomeFallback  = "fallback"  // an overload moved to the next fallback model
	AttemptOutcomeError     = "error"     // the error ends the call
	AttemptOutcomeCancelled = "cancelled" // the caller's context ended it
)

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
		// authSelfHealed bounds the auth-rejection self-heal (child 07,
		// R-19) to exactly one attempt across the whole retry loop -- not
		// per fallback hop, so a persistently revoked credential cannot
		// retry once per chain link and turn one rejection into N.
		authSelfHealed := false

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

			attemptCtx := ctx
			if config != nil && config.AttachAuth != nil {
				attemptCtx = config.AttachAuth(ctx, currentProvider.ID())
			}
			// One attempt, as the observer sees it. endAttempt is idempotent so
			// every exit below can report without tracking which fired.
			attemptStart := time.Now()
			var firstEventAt time.Time
			var attemptEnd func(outcome string, ttftMs float64, err error)
			if config != nil && config.OnAttemptStart != nil {
				attemptEnd = config.OnAttemptStart(attempt, currentModel, currentProvider.ID())
			}
			attemptEnded := false
			endAttempt := func(outcome string, err error) {
				if attemptEnded || attemptEnd == nil {
					attemptEnded = true
					return
				}
				attemptEnded = true
				ttft := 0.0
				if !firstEventAt.IsZero() {
					ttft = float64(firstEventAt.Sub(attemptStart).Microseconds()) / 1000.0
				}
				attemptEnd(outcome, ttft, err)
			}
			evCh, errCh := currentProvider.Stream(attemptCtx, streamOpts)

			// Forward each event to the caller immediately.
			var streamErr error
			for ev := range evCh {
				if firstEventAt.IsZero() {
					firstEventAt = time.Now()
				}
				if ctx.Err() != nil {
					endAttempt(AttemptOutcomeCancelled, ctx.Err())
					errc <- ctx.Err()
					return
				}
				select {
				case events <- ev:
					forwardedSinceReset = true
				case <-ctx.Done():
					endAttempt(AttemptOutcomeCancelled, ctx.Err())
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
				endAttempt(AttemptOutcomeOK, nil)
				return
			}

			// Context cancelled is not retryable
			if ctx.Err() != nil {
				endAttempt(AttemptOutcomeCancelled, ctx.Err())
				errc <- ctx.Err()
				return
			}

			// Convert to ProviderError
			pe, ok := streamErr.(*ProviderError)
			if !ok {
				endAttempt(AttemptOutcomeError, streamErr)
				errc <- streamErr
				return
			}
			pe.Attempt = attempt

			// Auth rejection self-heal (child 07, R-19): a 401/403 is
			// Retryable:false (errors.go), which would otherwise return
			// immediately below. That non-retryable tag is exactly what
			// keeps this a single deliberate re-resolution rather than a
			// generic retry loop -- ErrAuth stays Retryable:false for every
			// OTHER consumer; this is the one caller that treats it as a
			// one-shot self-heal opportunity BEFORE the generic
			// not-retryable return. principal_credential_unresolved (child
			// 04's refusal) is deliberately excluded: invalidating and
			// re-resolving a principal the fall-through policy already
			// refused cannot produce a different answer, so retrying it
			// would just be a wasted round trip with an identical outcome.
			if pe.Code == ErrAuth && pe.Reason != ReasonPrincipalCredentialUnresolved && !authSelfHealed && config != nil && config.AttachAuth != nil {
				authSelfHealed = true
				InvalidatePrincipal(config.Subject, currentProvider.ID())
				utils.LogWithFields(utils.LevelInfo, "providers.retry", "auth rejection; invalidated and re-resolving once", map[string]any{
					"subject": config.Subject, "provider": currentProvider.ID(),
				})
				if !sendReset() {
					endAttempt(AttemptOutcomeCancelled, ctx.Err())
					errc <- ctx.Err()
					return
				}
				endAttempt(AttemptOutcomeRetry, pe)
				continue // re-resolve auth and retry immediately, no backoff
			}

			// Not retryable
			if !pe.Retryable {
				if pe.Code == ErrAuth {
					subject := ""
					if config != nil {
						subject = config.Subject
					}
					utils.LogWithFields(utils.LevelWarn, "providers.retry", "auth rejection after re-resolution; not retrying again", map[string]any{
						"subject": subject, "provider": currentProvider.ID(), "already_self_healed": authSelfHealed,
					})
				}
				endAttempt(AttemptOutcomeError, pe)
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
							endAttempt(AttemptOutcomeCancelled, ctx.Err())
							errc <- ctx.Err()
							return
						}
						endAttempt(AttemptOutcomeFallback, pe)
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
				endAttempt(AttemptOutcomeError, pe)
				errc <- pe
				return
			}

			// Persistent mode: check total wall time
			if config.isPersistent() && time.Since(startTime).Milliseconds() > config.persistentMaxWait() {
				endAttempt(AttemptOutcomeError, pe)
				errc <- pe
				return
			}

			// This attempt will be retried. Discard any partial output it
			// already forwarded — before the backoff wait, so consumers drop
			// the stale partial state immediately rather than after the delay.
			if !sendReset() {
				endAttempt(AttemptOutcomeCancelled, ctx.Err())
				errc <- ctx.Err()
				return
			}
			endAttempt(AttemptOutcomeRetry, pe)

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
