package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// loginState tracks in-flight provider logins so provider_login_cancel can
// abort one. Guarded by loginMu.
var (
	activeLogins = make(map[string]context.CancelFunc)
	loginMu      sync.Mutex
)

// logoutDispatchTimeout bounds the logout driver call at the dispatch level so a
// wedged CLI can never block the RefreshProviderProbes call sequenced after it
// (and thus never starve the engine_providers_updated refresh nudge). It is a
// backstop above cliprobe.Logout's own self-timeout: any driver — including a
// custom one — is bounded here as long as it honors the context.
const logoutDispatchTimeout = 60 * time.Second

// loginDriver returns the login func (default: real CLI login; overridable in
// tests via SetLoginFunc).
func (s *Server) loginDriver() cliprobe.LoginFunc {
	if s.loginFn != nil {
		return s.loginFn
	}
	return cliprobe.Login
}

// logoutDriver returns the logout func.
func (s *Server) logoutDriver() cliprobe.LogoutFunc {
	if s.logoutFn != nil {
		return s.logoutFn
	}
	return cliprobe.Logout
}

// SetLoginFuncs overrides the login/logout drivers (tests only).
func (s *Server) SetLoginFuncs(login cliprobe.LoginFunc, logout cliprobe.LogoutFunc) {
	s.loginFn = login
	s.logoutFn = logout
}

// dispatchProviderLogin starts an interactive login for the provider's
// delegated CLI. The engine never blocks the dispatch: it returns immediately
// and drives the flow in the background, broadcasting engine_provider_login
// stage events. On completion it refreshes the provider probes so the provider
// shows authed.
func (s *Server) dispatchProviderLogin(conn net.Conn, cmd *protocol.ClientCommand) {
	provider := cmd.Provider
	kind, ok := ionconfig.CliBackendKind(provider)
	if !ok {
		s.sendResult(conn, cmd, fmt.Errorf("provider %q has no delegated CLI to log in to", provider), nil)
		return
	}

	ctx, cancel := context.WithCancel(s.serveContext())
	loginMu.Lock()
	if prev, exists := activeLogins[provider]; exists {
		prev() // cancel a prior in-flight login for this provider
	}
	activeLogins[provider] = cancel
	loginMu.Unlock()

	emit := func(st cliprobe.LoginStage) {
		s.broadcastProviderLogin(types.ProviderLoginUpdate{
			Provider:        provider,
			Backend:         kind,
			Stage:           st.Stage,
			AuthURL:         st.AuthURL,
			UserCode:        st.UserCode,
			VerificationURL: st.VerificationURL,
			LoginError:      st.Error,
			LoginID:         st.LoginID,
		})
	}

	go func() {
		defer func() {
			cancel()
			loginMu.Lock()
			delete(activeLogins, provider)
			loginMu.Unlock()
		}()
		err := s.loginDriver()(ctx, kind, emit)
		if err != nil {
			utils.LogWithFields(utils.LevelInfo, "server.provider_login", "login ended", map[string]any{"provider": provider, "kind": kind, "error": err.Error()})
			return
		}
		utils.LogWithFields(utils.LevelInfo, "server.provider_login", "login completed", map[string]any{"provider": provider, "kind": kind})
		// Re-probe so the provider now reports authed, then nudge clients to
		// refresh their model/provider list.
		s.RefreshProviderProbes()
	}()

	s.sendResult(conn, cmd, nil, map[string]any{"started": true, "backend": kind})
}

// dispatchProviderLoginCancel aborts an in-flight login for a provider.
func (s *Server) dispatchProviderLoginCancel(conn net.Conn, cmd *protocol.ClientCommand) {
	loginMu.Lock()
	cancel, ok := activeLogins[cmd.Provider]
	loginMu.Unlock()
	if ok {
		cancel()
	}
	s.sendResult(conn, cmd, nil, map[string]any{"cancelled": ok})
}

// dispatchProviderLogout clears the provider CLI's stored credential and
// re-probes so the provider reflects the signed-out state.
func (s *Server) dispatchProviderLogout(conn net.Conn, cmd *protocol.ClientCommand) {
	kind, ok := ionconfig.CliBackendKind(cmd.Provider)
	if !ok {
		s.sendResult(conn, cmd, fmt.Errorf("provider %q has no delegated CLI", cmd.Provider), nil)
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(s.serveContext(), logoutDispatchTimeout)
		defer cancel()
		if err := s.logoutDriver()(ctx, kind); err != nil {
			utils.LogWithFields(utils.LevelInfo, "server.provider_login", "logout ended", map[string]any{"provider": cmd.Provider, "kind": kind, "error": err.Error()})
		}
		s.RefreshProviderProbes()
	}()
	s.sendResult(conn, cmd, nil, map[string]any{"ok": true})
}

// broadcastProviderLogin marshals and broadcasts an engine_provider_login event
// to every connected client.
func (s *Server) broadcastProviderLogin(update types.ProviderLoginUpdate) {
	evt := types.EngineEvent{Type: types.EventProviderLogin, ProviderLogin: &update}
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.provider_login", "event marshal failed", map[string]any{"error": err.Error()})
		return
	}
	line := protocol.SerializeServerEvent("", json.RawMessage(raw))
	s.broadcast(line, evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.provider_login", "stage", map[string]any{"provider": update.Provider, "backend": update.Backend, "stage": update.Stage})
}

// broadcastProvidersUpdated emits the advisory engine_providers_updated event to
// every connected client. It carries no payload: consumers re-query list_models
// to pull the authoritative provider + model listing. Called after a probe
// refresh so a login/logout, refresh_models, or startup probe becomes visible
// without the consumer polling. See types.EventProvidersUpdated for semantics.
func (s *Server) broadcastProvidersUpdated() {
	evt := types.EngineEvent{Type: types.EventProvidersUpdated}
	raw, err := json.Marshal(evt)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "server.provider_login", "providers-updated marshal failed", map[string]any{"error": err.Error()})
		return
	}
	line := protocol.SerializeServerEvent("", json.RawMessage(raw))
	s.broadcast(line, evt.Type)
	utils.LogWithFields(utils.LevelInfo, "server.provider_login", "providers updated broadcast", nil)
}
