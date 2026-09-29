package session

import (
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/session/pending"
	"github.com/dsswift/ion/engine/internal/types"
)

// newCredentialTestSession builds a minimal manager+session attributed to
// subject, wired with a pending broker, sufficient to drive
// askClientForCredential / clientCredentialSource directly. Mirrors
// newElicitTestSession (dialog_elicit_test.go) exactly.
func newCredentialTestSession(t *testing.T, subject string) (*Manager, *engineSession, string) {
	t.Helper()
	key := "test-session"
	m := &Manager{sessions: make(map[string]*engineSession)}
	s := &engineSession{key: key, pending: pending.New(), principal: &types.SessionPrincipal{Subject: subject}}
	s.newSessionRootContext()
	m.sessions[key] = s
	return m, s, key
}

// watchCredentialRequestIDs registers an OnEvent listener BEFORE the caller
// triggers a credential request, and returns a channel that receives each
// engine_credential_request's request id as it is emitted -- so a test can
// learn the id the real client would learn from the event itself, with no
// race against when Resolve happens to emit it.
func watchCredentialRequestIDs(m *Manager, key string) <-chan string {
	ch := make(chan string, 4)
	m.OnEvent(func(k string, ev types.EngineEvent) {
		if k == key && ev.Type == "engine_credential_request" {
			select {
			case ch <- ev.CredentialRequestID:
			default:
			}
		}
	})
	return ch
}

// TestClientSource_AnswersFound pins the happy path: a client reply with
// Found=true resolves to a working RequestAuthenticator.
func TestClientSource_AnswersFound(t *testing.T) {
	m, _, key := newCredentialTestSession(t, "alice")
	reqIDs := watchCredentialRequestIDs(m, key)
	src := clientCredentialSource{m: m}

	type result struct {
		a   auth.RequestAuthenticator
		err error
	}
	resCh := make(chan result, 1)
	go func() {
		a, err := src.Resolve(t.Context(), auth.CredentialScope{Subject: "alice", Provider: "anthropic"})
		resCh <- result{a, err}
	}()

	var reqID string
	select {
	case reqID = <-reqIDs:
	case <-time.After(2 * time.Second):
		t.Fatal("no engine_credential_request event observed")
	}
	m.HandleCredentialResponse(key, reqID, true, "sk-alice", "x-api-key")

	select {
	case r := <-resCh:
		if r.err != nil {
			t.Fatalf("unexpected error: %v", r.err)
		}
		if r.a == nil {
			t.Fatal("expected a non-nil authenticator for Found=true")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Resolve did not return after the client answered")
	}
}

// TestClientSource_AnswersNotFound pins that an explicit Found=false reply
// is (nil, nil) -- "try the next source", not an error.
func TestClientSource_AnswersNotFound(t *testing.T) {
	m, _, key := newCredentialTestSession(t, "alice")
	reqIDs := watchCredentialRequestIDs(m, key)
	src := clientCredentialSource{m: m}

	type result struct {
		a   auth.RequestAuthenticator
		err error
	}
	resCh := make(chan result, 1)
	go func() {
		a, err := src.Resolve(t.Context(), auth.CredentialScope{Subject: "alice", Provider: "anthropic"})
		resCh <- result{a, err}
	}()

	var reqID string
	select {
	case reqID = <-reqIDs:
	case <-time.After(2 * time.Second):
		t.Fatal("no engine_credential_request event observed")
	}
	m.HandleCredentialResponse(key, reqID, false, "", "")

	select {
	case r := <-resCh:
		if r.a != nil {
			t.Error("expected nil authenticator for Found=false")
		}
		if r.err != nil {
			t.Errorf("expected nil error, got %v", r.err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Resolve did not return after the client answered")
	}
}

// TestClientSourceNoClient pins that no live session for the subject means
// the source answers (nil, nil) immediately -- nothing to ask, chain
// continues, and a headless/single-user engine (no matching session) is
// never blocked.
func TestClientSourceNoClient(t *testing.T) {
	m := &Manager{sessions: make(map[string]*engineSession)}
	src := clientCredentialSource{m: m}

	start := time.Now()
	a, err := src.Resolve(t.Context(), auth.CredentialScope{Subject: "nobody-connected", Provider: "anthropic"})
	elapsed := time.Since(start)

	if a != nil || err != nil {
		t.Fatalf("expected (nil, nil), got (%v, %v)", a, err)
	}
	if elapsed > 500*time.Millisecond {
		t.Errorf("expected an immediate return with no session, took %s", elapsed)
	}
}

// TestClientSourceTimeout pins that an unanswered request times out and
// returns (nil, nil) -- never blocks a run indefinitely for a server that
// never replies.
func TestClientSourceTimeout(t *testing.T) {
	orig := credentialAskTimeout
	credentialAskTimeout = 50 * time.Millisecond
	defer func() { credentialAskTimeout = orig }()

	m, _, _ := newCredentialTestSession(t, "alice")
	src := clientCredentialSource{m: m}

	start := time.Now()
	a, err := src.Resolve(t.Context(), auth.CredentialScope{Subject: "alice", Provider: "anthropic"})
	elapsed := time.Since(start)

	if a != nil || err != nil {
		t.Fatalf("expected (nil, nil) on timeout, got (%v, %v)", a, err)
	}
	if elapsed < 50*time.Millisecond || elapsed > time.Second {
		t.Errorf("expected the wait to be bounded by credentialAskTimeout (~50ms), took %s", elapsed)
	}
}

// TestCredentialResponse_UnknownRequestIDDropped pins that a
// credential_response for an unknown/expired request id is dropped with a
// log line, exactly as a late elicitation response is -- never a panic or a
// misdelivered reply.
func TestCredentialResponse_UnknownRequestIDDropped(t *testing.T) {
	m, _, key := newCredentialTestSession(t, "alice")
	// No panic, no effect: there is no pending request "does-not-exist".
	m.HandleCredentialResponse(key, "does-not-exist", true, "sk-x", "")
}
