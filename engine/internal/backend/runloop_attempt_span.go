package backend

import (
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/utils"
)

// attemptSpanStarter returns the RetryConfig.OnAttemptStart observer that
// records every provider request of a turn as an llm.attempt span: a client
// span under the turn's llm.call, with attributes attempt, model, provider,
// turn, ttft_ms, and outcome (providers.AttemptOutcome*). The parent is read
// from the run's stream context at attempt start (withLlmCallSpan puts the
// llm.call span there before WithRetry runs). Nil telem observes nothing.
func attemptSpanStarter(telem TelemetryCollector, run *activeRun, turn int) func(attempt int, model, providerID string) func(outcome string, ttftMs float64, err error) {
	if telem == nil {
		return nil
	}
	return func(attempt int, model, providerID string) func(string, float64, error) {
		ctx := buildTelemCtx(run)
		if parent := run.llmCallSpanID(); parent != "" && ctx != nil {
			ctx["parent_span_id"] = parent
		}
		span := telem.StartSpanCtx(telemetry.LlmAttempt, map[string]interface{}{
			"attempt": attempt, "model": model, "provider": providerID, "turn": turn,
			"span_kind": telemetry.SpanKindClient,
		}, ctx)
		return func(outcome string, ttftMs float64, err error) {
			errMsg := ""
			if err != nil {
				errMsg = err.Error()
			}
			span.End(map[string]interface{}{"outcome": outcome, "ttft_ms": ttftMs}, errMsg)
			utils.LogWithFields(utils.LevelDebug, "backend.runloop", "llm.attempt span recorded", map[string]any{
				"run_id": run.requestID, "turn": turn, "attempt": attempt, "model": model, "provider": providerID,
				"outcome": outcome, "ttft_ms": ttftMs, "span_id": span.SpanID(), "error": errMsg,
			})
		}
	}
}

// llmCallSpanID is the span-id of the llm.call in flight for this run, or
// "" between turns. Set by the run loop around each provider call.
func (r *activeRun) llmCallSpanID() string {
	if r == nil {
		return ""
	}
	if v := r.currentLlmSpan.Load(); v != nil {
		if id, ok := v.(string); ok {
			return id
		}
	}
	return ""
}

// setLlmCallSpan records (or clears, with "") the llm.call span in flight.
func (r *activeRun) setLlmCallSpan(id string) {
	if r == nil {
		return
	}
	r.currentLlmSpan.Store(id)
}
