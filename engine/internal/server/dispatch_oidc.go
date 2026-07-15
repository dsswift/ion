// dispatch_oidc.go — operator OIDC identity commands.
//
// The engine is the authoritative owner of the operator's OIDC identity
// (see internal/auth/identity.go). These handlers expose the lifecycle over
// the wire: a consumer starts a login and receives only what it must
// surface to the user (an authorization URL, or a device code); the engine
// completes the exchange, persists the grant, and broadcasts the resulting
// identity snapshot to every connected client. No consumer ever handles
// the token itself.
package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"time"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// serveContext returns a context cancelled when the server shuts down,
// bounding background flows (device-code polling) to the server lifetime.
func (s *Server) serveContext() context.Context {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-s.done
		cancel()
	}()
	return ctx
}

// SetIdentityManager installs the operator identity manager. Nil (the
// default) means no identity provider is configured; the oidc_* commands
// then answer with a clear configuration error.
func (s *Server) SetIdentityManager(m *auth.IdentityManager) {
	s.mu.Lock()
	s.identity = m
	s.mu.Unlock()
}

// identityManager returns the installed identity manager under the read lock.
func (s *Server) identityManager() *auth.IdentityManager {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.identity
}

// dispatchOidcBeginLogin starts an interactive (PKCE) or headless (device
// code) login. The flow's user-facing half is delivered to the requesting
// client as an engine_oidc_login_url event; completion broadcasts an
// engine_oidc_identity snapshot to all clients.
func (s *Server) dispatchOidcBeginLogin(conn net.Conn, cmd *protocol.ClientCommand) {
	m := s.identityManager()
	if m == nil {
		s.sendResult(conn, cmd, fmt.Errorf("no OIDC identity provider configured (set auth.identityProvider in engine.json)"), nil)
		return
	}

	switch cmd.OidcFlow {
	case "device":
		login, err := m.BeginDeviceLogin()
		if err != nil {
			utils.LogWithFields(utils.LevelError, "server.oidc", "device login start failed", map[string]any{"error": err.Error()})
			s.sendResult(conn, cmd, err, nil)
			return
		}
		s.emitOidcEventTo(conn, cmd.Key, types.EngineEvent{
			Type:                types.EventOidcLoginURL,
			OidcUserCode:        login.UserCode,
			OidcVerificationURI: login.VerifyURI,
		})
		s.sendResult(conn, cmd, nil, map[string]any{
			"userCode":        login.UserCode,
			"verificationUri": login.VerifyURI,
			"expiresIn":       login.ExpiresIn,
		})

		// Poll to completion in the background; the engine never blocks a
		// dispatch on user action. Wait honors the device-code expiry.
		go func() {
			identity, err := login.Wait(s.serveContext())
			if err != nil {
				utils.LogWithFields(utils.LevelInfo, "server.oidc", "device login did not complete", map[string]any{"error": err.Error()})
				return
			}
			utils.LogWithFields(utils.LevelInfo, "server.oidc", "device login completed", map[string]any{"user": identity.AttributionValue()})
			s.broadcastOidcIdentity()
		}()

	case "", "pkce":
		login, err := m.BeginLogin()
		if err != nil {
			utils.LogWithFields(utils.LevelError, "server.oidc", "interactive login start failed", map[string]any{"error": err.Error()})
			s.sendResult(conn, cmd, err, nil)
			return
		}
		s.emitOidcEventTo(conn, cmd.Key, types.EngineEvent{
			Type:                 types.EventOidcLoginURL,
			OidcAuthorizationURL: login.AuthorizationURL,
		})
		s.sendResult(conn, cmd, nil, map[string]any{
			"authorizationUrl": login.AuthorizationURL,
		})

		go func() {
			select {
			case identity := <-login.Done:
				utils.LogWithFields(utils.LevelInfo, "server.oidc", "interactive login completed", map[string]any{"user": identity.AttributionValue()})
				s.broadcastOidcIdentity()
			case err := <-login.Err:
				utils.LogWithFields(utils.LevelInfo, "server.oidc", "interactive login did not complete", map[string]any{"error": err.Error()})
			}
		}()

	default:
		s.sendResult(conn, cmd, fmt.Errorf("unknown oidcFlow %q (want \"pkce\" or \"device\")", cmd.OidcFlow), nil)
	}
}

// dispatchOidcLogout signs the operator out and broadcasts the signed-out
// identity snapshot.
func (s *Server) dispatchOidcLogout(conn net.Conn, cmd *protocol.ClientCommand) {
	m := s.identityManager()
	if m == nil {
		s.sendResult(conn, cmd, fmt.Errorf("no OIDC identity provider configured (set auth.identityProvider in engine.json)"), nil)
		return
	}
	if err := m.SignOut(); err != nil {
		utils.LogWithFields(utils.LevelError, "server.oidc", "sign-out failed", map[string]any{"error": err.Error()})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	s.sendResult(conn, cmd, nil, nil)
	s.broadcastOidcIdentity()
}

// dispatchOidcIdentity answers with the current identity snapshot,
// delivered as an engine_oidc_identity event to the requester plus a
// result payload for the await-result pattern.
func (s *Server) dispatchOidcIdentity(conn net.Conn, cmd *protocol.ClientCommand) {
	m := s.identityManager()
	if m == nil {
		s.sendResult(conn, cmd, fmt.Errorf("no OIDC identity provider configured (set auth.identityProvider in engine.json)"), nil)
		return
	}
	evt := s.oidcIdentityEvent()
	s.emitOidcEventTo(conn, cmd.Key, evt)
	s.sendResult(conn, cmd, nil, map[string]any{
		"signedIn": evt.OidcSignedIn != nil && *evt.OidcSignedIn,
		"subject":  evt.OidcSubject,
		"username": evt.OidcUsername,
		"name":     evt.OidcDisplayName,
		"provider": evt.OidcProvider,
	})
}

// dispatchOidcToken mints a short-lived access token for the requested
// scope and returns it in the result payload -- requester-only delivery,
// never broadcast. This is the seam that lets a trusted local client (the
// desktop shipping its own logs, a custom CLI) authenticate downstream
// calls without owning the grant: the refresh token never leaves the
// engine; clients pull ephemeral access tokens on demand.
func (s *Server) dispatchOidcToken(conn net.Conn, cmd *protocol.ClientCommand) {
	m := s.identityManager()
	if m == nil {
		s.sendResult(conn, cmd, fmt.Errorf("no OIDC identity provider configured (set auth.identityProvider in engine.json)"), nil)
		return
	}
	// Bounded context (NOT serveContext: that helper parks a goroutine
	// until shutdown, and this handler runs per client flush).
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	token, err := m.GetTokenWithAudience(ctx, cmd.OidcScope, cmd.OidcAudience)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "server.oidc", "client token mint failed", map[string]any{
			"tag":   cmd.OidcScope,
			"error": err.Error(),
		})
		s.sendResult(conn, cmd, err, nil)
		return
	}
	utils.LogWithFields(utils.LevelInfo, "server.oidc", "client token minted", map[string]any{"tag": cmd.OidcScope})
	s.sendResult(conn, cmd, nil, map[string]any{"accessToken": token})
}

// oidcIdentityEvent builds the complete identity snapshot event.
func (s *Server) oidcIdentityEvent() types.EngineEvent {
	m := s.identityManager()
	signedIn := false
	evt := types.EngineEvent{Type: types.EventOidcIdentity}
	if m != nil {
		if id := m.Identity(); id != nil {
			signedIn = true
			evt.OidcProvider = id.Provider
			evt.OidcSubject = id.Subject
			evt.OidcUsername = id.Username
			evt.OidcDisplayName = id.Name
		}
	}
	evt.OidcSignedIn = &signedIn
	return evt
}

// broadcastOidcIdentity broadcasts the current identity snapshot to every
// connected client. Called on each identity state transition. Also
// restamps the ambient attribution carriers (egress records + telemetry
// events) so the "user" field tracks sign-in/sign-out live.
func (s *Server) broadcastOidcIdentity() {
	evt := s.oidcIdentityEvent()

	attribution := ""
	if m := s.identityManager(); m != nil {
		attribution = m.Identity().AttributionValue() // nil-safe: nil identity → ""
	}
	utils.SetEgressUser(attribution)
	telemetry.SetUserIdentity(attribution)
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.oidc", "identity event marshal failed", map[string]any{"error": err.Error()})
		return
	}
	line := protocol.SerializeServerEvent("", json.RawMessage(raw))
	s.broadcast(line, evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.oidc", "identity snapshot broadcast", map[string]any{
		"signed_in": evt.OidcSignedIn != nil && *evt.OidcSignedIn,
		"user":      evt.OidcUsername,
	})
}

// emitOidcEventTo delivers an OIDC event to a single client connection
// (requester-scoped, like emitPlanContent -- a login URL is only the
// requesting consumer's to surface).
func (s *Server) emitOidcEventTo(conn net.Conn, key string, evt types.EngineEvent) {
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.oidc", "oidc event marshal failed", map[string]any{"error": err.Error()})
		return
	}
	line := protocol.SerializeServerEvent(key, json.RawMessage(raw))
	s.writeToClient(conn, line)
}
