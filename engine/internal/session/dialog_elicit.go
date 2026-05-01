package session

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SendDialogResponse responds to a dialog prompt.
func (m *Manager) SendDialogResponse(key, dialogID string, value interface{}) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("dialog response for unknown session %s", key))
		return
	}

	ch, exists := s.pendingDialogs[dialogID]
	m.mu.RUnlock()

	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending dialog %s for session %s", dialogID, key))
		return
	}
	// Non-blocking send -- if nobody is waiting, drop silently.
	select {
	case ch <- value:
	default:
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

	ch := make(chan elicitReply, 1)
	m.mu.Lock()
	s.pendingElicit[requestID] = ch
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		delete(s.pendingElicit, requestID)
		m.mu.Unlock()
	}()

	// Fan out to clients.
	m.emit(key, types.EngineEvent{
		Type:            "engine_elicitation_request",
		ElicitRequestID: requestID,
		ElicitSchema:    info.Schema,
		ElicitURL:       info.URL,
		ElicitMode:      info.Mode,
	})

	// Fire the extension hook in parallel — extensions can also reply.
	hookCh := make(chan elicitReply, 1)
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
				case hookCh <- elicitReply{response: resp}:
				default:
				}
				return
			}
		}
	}()

	const timeout = 5 * time.Minute
	select {
	case reply := <-ch:
		// Mirror the response back through the elicitation_result hook so
		// extensions that observe rather than reply still see the outcome.
		if s.extGroup != nil {
			s.extGroup.FireElicitationResult(m.newExtContext(s, key), extension.ElicitationResultInfo{
				RequestID: requestID,
				Response:  reply.response,
				Cancelled: reply.cancelled,
			})
		}
		return reply.response, reply.cancelled, nil
	case reply := <-hookCh:
		return reply.response, false, nil
	case <-time.After(timeout):
		return nil, true, fmt.Errorf("elicitation %s timed out", requestID)
	}
}

// HandleElicitationResponse resolves a pending elicitation from a client.
// Called by the server when an `elicitation_response` command is received.
func (m *Manager) HandleElicitationResponse(key, requestID string, response map[string]interface{}, cancelled bool) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	if !ok {
		m.mu.RUnlock()
		utils.Log("Session", fmt.Sprintf("elicitation_response for unknown session %s", key))
		return
	}
	ch, exists := s.pendingElicit[requestID]
	m.mu.RUnlock()
	if !exists {
		utils.Log("Session", fmt.Sprintf("no pending elicitation %s for session %s", requestID, key))
		return
	}
	select {
	case ch <- elicitReply{response: response, cancelled: cancelled}:
	default:
	}
}
