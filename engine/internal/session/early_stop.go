package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// earlyStopWireTimeout is the maximum time the engine will wait for a
// wire-protocol consumer (socket-only harness) to respond to an
// engine_early_stop_decision_request event before falling through to its
// existing merge logic. Tight by design: this fires synchronously inside
// the agent loop after every end_turn / stop, so a slow consumer must not
// block the run. A missing response is non-fatal — the engine treats it
// as "no opinion" and proceeds (which, absent any ContinueMessage from
// any source, means no continuation will be injected).
//
// 100ms is enough for a local consumer on the same machine to do a setting
// lookup and build a response; faster than humans can perceive, and faster
// than any LLM-related latency the run is already incurring.
const earlyStopWireTimeout = 100 * time.Millisecond

// HandleEarlyStopDecisionResponse resolves a pending early-stop wire-protocol
// request. Called by the server when an `early_stop_decision_response`
// command is received. Fire-and-forget: if no pending request matches the
// ID (because the runloop's timeout already fired and unregistered it, or
// because the consumer sent a stale response), the call is silently
// dropped — the runloop has already moved on.
func (m *Manager) HandleEarlyStopDecisionResponse(
	key, requestID string,
	forceContinue *bool,
	overrideBudget, overrideThresholdPct int,
	continueMessage string,
) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session", "early_stop_decision_response for unknown session", map[string]any{"key": key})
		return
	}
	reply := pending.EarlyStopReply{
		ForceContinue:        forceContinue,
		OverrideBudget:       overrideBudget,
		OverrideThresholdPct: overrideThresholdPct,
		ContinueMessage:      continueMessage,
	}
	if !s.pending.ResolveEarlyStop(requestID, reply) {
		utils.LogWithFields(utils.LevelDebug, "session", "no pending early-stop for session (likely timed out)", map[string]any{"run_id": requestID, "key": key})
	}
}

// requestEarlyStopDecisionViaWire emits an engine_early_stop_decision_request
// event for socket-only harnesses to respond to, blocks briefly on the
// response channel, and returns the resolved backend.EarlyStopDecisionResult
// (or nil when nothing decisive came back inside the timeout).
//
// Called by the OnBeforeEarlyStopDecision callback wired in prompt_runconfig.go
// AFTER the extension-side hook has been fired and returned nil. This means:
//
//   - Subprocess extensions (TS/Go SDK) take precedence: their reply wins
//     before this wire event is ever emitted. The wire protocol is the
//     fallback for harnesses that don't run extensions.
//   - Multiple wire consumers receive the same emitted event (sockets are
//     broadcast). The first to respond wins; later responses are dropped
//     by the broker's non-blocking send semantics.
//
// The request ID is monotonic-ish (nanosecond-derived) and prefixed with
// "early-stop-" for log greppability.
func (m *Manager) requestEarlyStopDecisionViaWire(
	key string,
	info backend.EarlyStopDecisionInfo,
) *backend.EarlyStopDecisionResult {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "requestearlystopdecisionviawire: session not found", map[string]any{"key": key})
		return nil
	}

	requestID := fmt.Sprintf("early-stop-%d", time.Now().UnixNano())
	ch := s.pending.RegisterEarlyStop(requestID)
	defer s.pending.UnregisterEarlyStop(requestID)

	m.emit(key, types.EngineEvent{
		Type:                           "engine_early_stop_decision_request",
		EarlyStopRequestID:             requestID,
		EarlyStopRunID:                 info.RunID,
		EarlyStopModel:                 info.Model,
		EarlyStopTurnNumber:            info.TurnNumber,
		EarlyStopStopReason:            info.StopReason,
		EarlyStopCumulativeOutput:      info.CumulativeOutputTokens,
		EarlyStopBudget:                info.Budget,
		EarlyStopThresholdPct:          info.ThresholdPct,
		EarlyStopContinuationCount:     info.ContinuationCount,
		EarlyStopMaxContinuations:      info.MaxContinuations,
		EarlyStopLastContinuationDelta: info.LastContinuationDelta,
		EarlyStopWouldContinue:         info.WouldContinue,
		EarlyStopIsSubagent:            info.IsSubagent,
	})

	utils.LogWithFields(utils.LevelDebug, "session", "requestearlystopdecisionviawire: emitted — awaiting consumer", map[string]any{"run_id": requestID, "run_id_1": info.RunID, "turn_number": info.TurnNumber, "would_continue": info.WouldContinue})

	select {
	case reply := <-ch:
		// Translate broker reply into the backend's result type. An entirely
		// empty reply (all zero values) still produces a non-nil result so
		// the caller can distinguish "consumer expressed no opinion" from
		// "consumer never responded" — but in practice the engine's merge
		// logic treats all-zero exactly the same as nil, so this is
		// observationally equivalent. Returning non-nil records the
		// participation for log/audit purposes.
		utils.LogWithFields(utils.LevelDebug, "session", "requestearlystopdecisionviawire: consumer responded", map[string]any{"run_id": requestID, "force_continue": reply.ForceContinue, "override_budget": reply.OverrideBudget, "count": len(reply.ContinueMessage)})
		return &backend.EarlyStopDecisionResult{
			ForceContinue:        reply.ForceContinue,
			OverrideBudget:       reply.OverrideBudget,
			OverrideThresholdPct: reply.OverrideThresholdPct,
			ContinueMessage:      reply.ContinueMessage,
		}
	case <-time.After(earlyStopWireTimeout):
		utils.LogWithFields(utils.LevelInfo, "session", "requestearlystopdecisionviawire: timeout after — proceeding with no opinion", map[string]any{"early_stop_wire_timeout": earlyStopWireTimeout, "run_id": requestID, "run_id_2": info.RunID})
		return nil
	}
}
