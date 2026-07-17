package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SendDialogResponse responds to a dialog prompt.
func (m *Manager) SendDialogResponse(key, dialogID string, value interface{}) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session", "dialog response for unknown session", map[string]any{"key": key})
		return
	}
	if !s.pending.ResolveDialog(dialogID, value) {
		utils.LogWithFields(utils.LevelInfo, "session", "no pending dialog for session", map[string]any{"run_id": dialogID, "key": key})
	}
}

// elicit raises an elicitation request: emits engine_elicitation_request to
// connected clients, fires the elicitation_request extension hook, and waits
// for whichever responds first. Returns (response, cancelled, error).
//
// Human-wait semantics: by default the wait is INDEFINITE — a human (or an
// extension answering on their behalf) is expected to respond, and a forgotten
// elicitation must not be silently cancelled by a wall-clock deadline. The wait
// is still bounded by session lifecycle: s.rootCtx is cancelled by SendAbort
// (user abort) and StopSession (teardown), so an unanswered elicitation can
// never wedge a torn-down session. An operator who configures a finite
// human-wait (TimeoutsConfig.ElicitationMs > 0) opts into a deadline, after
// which the elicitation returns cancelled=true. If both client and extension
// respond, the first reply wins; the second is dropped (non-blocking send).
func (m *Manager) elicit(s *engineSession, key string, info extension.ElicitationRequestInfo) (map[string]interface{}, bool, error) {
	requestID := info.RequestID
	if requestID == "" {
		requestID = fmt.Sprintf("elicit-%d", time.Now().UnixNano())
		info.RequestID = requestID
	}

	ch := s.pending.RegisterElicit(requestID)
	defer s.pending.UnregisterElicit(requestID)

	// Fan out to clients.
	m.emit(key, types.EngineEvent{
		Type:            "engine_elicitation_request",
		ElicitRequestID: requestID,
		ElicitSchema:    info.Schema,
		ElicitURL:       info.URL,
		ElicitMode:      info.Mode,
	})

	// Fire the extension hook in parallel — extensions can also reply.
	hookCh := make(chan pending.ElicitReply, 1)
	go func() {
		extCtx := m.newExtContext(s, key)
		if s.extGroup == nil {
			return
		}
		// Fan out to every host; first non-nil reply wins.
		for _, h := range s.extGroup.Hosts() {
			resp, err := h.SDK().FireElicitationRequest(extCtx, info)
			if err == nil && resp != nil {
				select {
				case hookCh <- pending.ElicitReply{Response: resp}:
				default:
				}
				return
			}
		}
	}()

	// Resolve the human-wait timeout. Default is indefinite (timerCh stays
	// nil, which blocks forever in the select below). A configured finite
	// human-wait installs a real timer; on expiry the elicitation is
	// reported cancelled.
	var timerCh <-chan time.Time
	if m.config != nil && m.config.Timeouts != nil {
		if d, finite := m.config.Timeouts.HumanWait(); finite {
			timer := time.NewTimer(d)
			defer timer.Stop()
			timerCh = timer.C
			utils.LogWithFields(utils.LevelInfo, "session", "elicit : finite human-wait", map[string]any{"run_id": requestID, "d": d})
		} else {
			utils.LogWithFields(utils.LevelInfo, "session", "elicit : indefinite human-wait (waiting for user/extension)", map[string]any{"run_id": requestID})
		}
	} else {
		utils.LogWithFields(utils.LevelInfo, "session", "elicit : indefinite human-wait (no timeouts config)", map[string]any{"run_id": requestID})
	}

	// Session-lifecycle cancellation. rootCtx is cancelled by SendAbort and
	// StopSession, so an indefinite wait can never wedge a torn-down session.
	// nil-guarded for test-constructed sessions that never called
	// newSessionRootContext (a nil channel blocks forever, which is the
	// correct "no lifecycle cancellation wired" behavior).
	var doneCh <-chan struct{}
	if s.rootCtx != nil {
		doneCh = s.rootCtx.Done()
	}

	// Mark the run as entering an intentional indefinite human-wait so the
	// run-progress watchdog does not cancel it for idleness while the user
	// decides. Paired End on every exit path via defer — the wait is indefinite
	// by default (see TimeoutsConfig.HumanWait) and the watchdog must honor that
	// (the 1782060832205-836960a71da9 / 3d580dc5 incidents cancelled an
	// unanswered elicitation at 10m precisely because this bracket was missing).
	m.beginHumanWait(s)
	defer m.endHumanWait(s)

	select {
	case reply := <-ch:
		// Mirror the response back through the elicitation_result hook so
		// extensions that observe rather than reply still see the outcome.
		if s.extGroup != nil {
			s.extGroup.FireElicitationResult(m.newExtContext(s, key), extension.ElicitationResultInfo{
				RequestID: requestID,
				Response:  reply.Response,
				Cancelled: reply.Cancelled,
			})
		}
		return reply.Response, reply.Cancelled, nil
	case reply := <-hookCh:
		return reply.Response, false, nil
	case <-doneCh:
		utils.LogWithFields(utils.LevelInfo, "session", "elicit : cancelled by session teardown/abort", map[string]any{"run_id": requestID})
		return nil, true, fmt.Errorf("elicitation %s cancelled", requestID)
	case <-timerCh:
		utils.LogWithFields(utils.LevelInfo, "session", "elicit : finite human-wait expired, returning cancelled", map[string]any{"run_id": requestID})
		return nil, true, fmt.Errorf("elicitation %s timed out", requestID)
	}
}

// HandleElicitationResponse resolves a pending elicitation from a client.
// Called by the server when an `elicitation_response` command is received.
func (m *Manager) HandleElicitationResponse(key, requestID string, response map[string]interface{}, cancelled bool) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session", "elicitation_response for unknown session", map[string]any{"key": key})
		return
	}
	if !s.pending.ResolveElicit(requestID, pending.ElicitReply{Response: response, Cancelled: cancelled}) {
		utils.LogWithFields(utils.LevelInfo, "session", "no pending elicitation for session", map[string]any{"run_id": requestID, "key": key})
	}
}
