// credential_request.go — the session-package half of the engine-asks
// client-answers bridge (FR-05 child 09, SC-8/SC-9).
//
// auth.PrincipalCredentialSource cannot itself reach across the socket: it
// runs inside a request-scoped resolution call with only a context and a
// CredentialScope, no session key. This file closes that gap: a single
// process-wide clientCredentialSource resolves WHICH session to ask from
// scope.Subject (sessionKeyForSubject), then asks it via
// askClientForCredential, which emits engine_credential_request and waits
// for a credential_response.
package session

import (
	"context"
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// credentialAskTimeout bounds how long askClientForCredential waits for a
// credential_response before treating the request as unanswered. A wedged or
// absent server must never block a run indefinitely (engine-grounding.md §2:
// engine never blocks the socket for a human, and this must not block a run
// for a server that will never answer either). A var, not a const, so a
// timeout test can shrink it rather than waiting out the real 5s.
var credentialAskTimeout = 5 * time.Second

// askClientForCredential emits engine_credential_request for one (subject,
// axis) scope on session key and waits up to credentialAskTimeout for a
// credential_response. Returns (nil, nil) -- "no answer, try the next
// source" -- on timeout, on no connected client (emit still happens; nobody
// is listening), and on an explicit Found:false reply. This mirrors elicit's
// register/emit/wait/unregister shape exactly (dialog_elicit.go), with a
// bounded rather than indefinite wait: a credential lookup is a fast
// yes/no/timeout question a run is blocked on mid-resolution, never a human
// decision an operator might take minutes to make.
func (m *Manager) askClientForCredential(key string, scope auth.CredentialScope) (*pending.CredentialReply, error) {
	requestID := fmt.Sprintf("cred-%d", time.Now().UnixNano())

	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelDebug, "session", "credential request: unknown session", map[string]any{"key": key})
		return nil, nil
	}

	ch := s.pending.RegisterCredential(requestID)
	defer s.pending.UnregisterCredential(requestID)

	axis := "provider"
	if scope.Host != "" {
		axis = "git"
	}
	m.emit(key, types.EngineEvent{
		Type:                "engine_credential_request",
		CredentialRequestID: requestID,
		CredentialSubject:   scope.Subject,
		CredentialAxis:      axis,
		CredentialProvider:  scope.Provider,
		CredentialHost:      scope.Host,
	})
	utils.LogWithFields(utils.LevelDebug, "session", "credential request emitted", map[string]any{
		"key": key, "credential_request_id": requestID, "subject": scope.Subject, "axis": axis,
		"provider": scope.Provider, "credential_host": scope.Host,
	})

	timer := time.NewTimer(credentialAskTimeout)
	defer timer.Stop()

	select {
	case reply := <-ch:
		return &reply, nil
	case <-timer.C:
		utils.LogWithFields(utils.LevelInfo, "session", "credential request timed out", map[string]any{
			"key": key, "credential_request_id": requestID, "subject": scope.Subject,
		})
		return nil, nil
	}
}

// HandleCredentialResponse resolves a pending credential request from a
// client. Called by the server when a credential_response command is
// received. Mirrors HandleElicitationResponse exactly.
func (m *Manager) HandleCredentialResponse(key, requestID string, found bool, token, header string) {
	m.mu.RLock()
	s, ok := m.sessions[key]
	m.mu.RUnlock()
	if !ok {
		utils.LogWithFields(utils.LevelInfo, "session", "credential_response for unknown session", map[string]any{"key": key})
		return
	}
	if !s.pending.ResolveCredential(requestID, pending.CredentialReply{Found: found, Token: token, Header: header}) {
		utils.LogWithFields(utils.LevelInfo, "session", "no pending credential request for session", map[string]any{"credential_request_id": requestID, "key": key})
	}
}

// sessionKeyForSubject finds the session key of a session attributed to
// subject. auth.RegisterPrincipalSource is a single GLOBAL registry keyed by
// Name() -- a source cannot be registered "for one session"; there is
// exactly one "client" source for the whole process, and it must find the
// right session itself from scope.Subject at ask time. Returns "" when no
// live session is attributed to subject (the source then answers (nil,
// nil): nothing to ask, chain continues).
//
// When more than one session shares a subject (the same principal with
// several open tabs/conversations), the first match found is used -- any of
// them can answer the same underlying identity's credential question, and
// which one answers is not otherwise observable to the caller.
func (m *Manager) sessionKeyForSubject(subject string) string {
	if subject == "" {
		return ""
	}
	m.mu.RLock()
	defer m.mu.RUnlock()
	for key, s := range m.sessions {
		if s.principal != nil && s.principal.Subject == subject {
			return key
		}
	}
	return ""
}

// RegisterClientCredentialSource registers the process-wide "client"
// PrincipalCredentialSource that asks a connected session's client for a
// credential (FR-05 child 09, SC-1/SC-8/SC-9). Called once, from engine
// startup wiring (mirroring where other process-wide auth seams are set
// up) -- NOT per session, since auth.RegisterPrincipalSource is a single
// global registry keyed by Name(). Idempotent: registering twice replaces
// the prior instance in place rather than duplicating it.
func (m *Manager) RegisterClientCredentialSource() {
	auth.RegisterPrincipalSource(clientCredentialSource{m: m})
}

// clientCredentialSource is the process-wide auth.PrincipalCredentialSource
// that asks a connected client via askClientForCredential. It resolves
// WHICH session to ask from scope.Subject at resolve time
// (sessionKeyForSubject) rather than being bound to one session at
// construction -- there is exactly one instance of this source for the
// whole engine (see RegisterClientCredentialSource).
type clientCredentialSource struct {
	m *Manager
}

func (s clientCredentialSource) Name() string { return "client" }

func (s clientCredentialSource) Resolve(ctx context.Context, scope auth.CredentialScope) (auth.RequestAuthenticator, error) {
	key := s.m.sessionKeyForCredentialAsk(ctx, scope.Subject)
	if key == "" {
		// No live session is attributed to this subject right now (e.g. the
		// principal's only session already ended). Nothing to ask.
		return nil, nil
	}
	reply, err := s.m.askClientForCredential(key, scope)
	if err != nil {
		return nil, err
	}
	if reply == nil || !reply.Found || reply.Token == "" {
		// No answer, or an explicit "I have nothing": both are (nil, nil) --
		// the chain continues to the next registered source, or to
		// fall-through policy (child 04) if this is the last one.
		return nil, nil
	}
	header := reply.Header
	if header == "" {
		header = "bearer"
	}
	return auth.NewStaticKeyAuthenticator(reply.Token, header), nil
}
