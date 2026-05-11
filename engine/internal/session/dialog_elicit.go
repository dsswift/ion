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
		utils.Log("Session", fmt.Sprintf("dialog response for unknown session %s", key))
		return
	}
	if !s.pending.ResolveDialog(dialogID, value) {
		utils.Log("Session", fmt.Sprintf("no pending dialog %s for session %s", dialogID, key))
	}
}

// elicit raises an elicitation request: emits engine_elicitation_request to
// connected clients, fires the elicitation_request extension hook, and waits
// for whichever responds first. Returns (response, cancelled, error).
//
// Defaults: a 5-minute timeout caps the wait so a forgotten elicitation
// cannot wedge an extension forever. If both client and extension respond,
// the first reply wins; the second is dropped (non-blocking send).
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

	timeout := 5 * time.Minute
	if m.config != nil && m.config.Timeouts != nil {
		timeout = m.config.Timeouts.Elicitation()
	}
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
	case <-time.After(timeout):
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
		utils.Log("Session", fmt.Sprintf("elicitation_response for unknown session %s", key))
		return
	}
	if !s.pending.ResolveElicit(requestID, pending.ElicitReply{Response: response, Cancelled: cancelled}) {
		utils.Log("Session", fmt.Sprintf("no pending elicitation %s for session %s", requestID, key))
	}
}
