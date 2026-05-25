// Package webhooks implements the engine's HTTP listener for inbound
// webhook routes that extensions register via the asyncreg registry.
//
// Design notes:
//
//   - Listener is OFF by default. It starts when (a) any extension
//     declares a webhook route at init or runtime, or (b) the engine
//     config's `webhooks.enabled` is forced true. It stops when the last
//     route is deregistered AND `enabled` is not forced.
//   - Default bind is 127.0.0.1. Non-loopback binds log a loud Warn so
//     the operator can't accidentally expose the listener to the
//     network without seeing it called out in the log.
//   - Routing is exact-match on (path, method). Two routes registered
//     for the same path with different methods coexist; the engine
//     responds 405 when a path is known but the method is not.
//   - Auth is verified before the handler is dispatched. Failure
//     responds 401 (none/bearer/shared-secret) or 403 (hmac signature
//     mismatch). The engine emits engine_webhook_handler_error with
//     reason="auth" so the operator sees the rejection in the log.
//   - Body size is enforced before parsing. Oversized requests get a
//     413 and emit engine_webhook_handler_error with reason="body_size".
//   - Handler dispatch is bounded by a per-route timeout (default 30s,
//     configurable per route in a future iteration).
//
// The server itself is engine-internal — extensions never touch it
// directly. Extensions declare routes via ion.webhooks.register(...)
// and the engine dispatches.
package webhooks

import (
	"context"
	"crypto/subtle"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// DefaultPort is the engine's default webhook listener port. Chosen
// not to collide with common dev ports (3000, 5000, 8000, 8080) and
// far from privileged-port territory.
const DefaultPort = 7421

// DefaultBindInterface is the default listen address. Loopback-only
// so a default-config engine never accidentally exposes routes.
const DefaultBindInterface = "127.0.0.1"

// DefaultMaxBodyBytes is the per-route body cap unless overridden by
// the route's WebhookRoute.MaxBodyBytes field. One megabyte covers
// every realistic webhook payload (Slack, GitHub, Stripe, Twilio …)
// without leaving room for accidentally-huge POSTs.
const DefaultMaxBodyBytes int64 = 1 << 20 // 1 MiB

// DefaultFireTimeout caps a handler invocation. Generous so an
// extension can dispatch an agent inside the handler without 30s
// being a real ceiling; the SDK runtime forwards the response.
const DefaultFireTimeout = 30 * time.Second

// Server is the engine-internal HTTP listener that routes inbound
// requests to the right extension host's registered handler.
//
// A single Server instance handles every host in the session. Routes
// are keyed by (host, path, method) so two hosts can claim the same
// path without conflict (though the wire-protocol shape will respond
// with whichever host registered first — see lookupRoute for the
// resolution order).
//
// Lifecycle:
//   - New() constructs the server but does not listen.
//   - Start() opens the listener on the configured interface/port.
//     Returns an error if the port is busy or bind fails.
//   - Subscribe a host's registry via WatchHost so the server reacts
//     to dynamic registrations from inside that host's lifetime.
//   - Stop() closes the listener; in-flight requests are given a brief
//     drain window via http.Server.Shutdown.
type Server struct {
	cfg Config

	mu       sync.RWMutex
	listener net.Listener
	server   *http.Server
	hosts    []*extension.Host // hosts whose registries we serve
	// emit is the per-session event emitter. The session manager wires
	// it during session_start so the server can publish
	// engine_webhook_* events for observability.
	emit func(types.EngineEvent)
	// fireSession resolves a fresh extension.Context for the host that
	// owns the matched route. Wired by the session manager via
	// SetSessionResolver so the webhooks package doesn't depend on the
	// session package directly.
	resolve SessionResolver
}

// SessionResolver builds a fresh extension.Context for the given host
// at fire time. Wired by the session manager via SetSessionResolver.
// Returns (nil, error) when the session cannot be resolved (e.g. the
// host's session ended); the server responds 503 and emits
// engine_async_fire_dropped.
type SessionResolver func(host *extension.Host) (*extension.Context, error)

// Config holds the engine config block that controls the webhook
// listener. All fields have engine-side defaults so an engine config
// without a `webhooks` block still produces a sensible server when
// extensions register routes.
type Config struct {
	// Port is the TCP port. Zero defaults to DefaultPort.
	Port int
	// BindInterface is the listen address. Empty defaults to
	// DefaultBindInterface (127.0.0.1).
	BindInterface string
	// DefaultMaxBodyBytes caps per-request bodies when the route's own
	// MaxBodyBytes is zero. Zero defaults to DefaultMaxBodyBytes.
	DefaultMaxBodyBytes int64
	// FireTimeout caps a single fire's handler invocation. Zero
	// defaults to DefaultFireTimeout.
	FireTimeout time.Duration
}

// resolved returns Config with all zero-valued fields replaced by
// their defaults. Internal helper for Server initialisation.
func (c Config) resolved() Config {
	out := c
	if out.Port == 0 {
		out.Port = DefaultPort
	}
	if out.BindInterface == "" {
		out.BindInterface = DefaultBindInterface
	}
	if out.DefaultMaxBodyBytes == 0 {
		out.DefaultMaxBodyBytes = DefaultMaxBodyBytes
	}
	if out.FireTimeout == 0 {
		out.FireTimeout = DefaultFireTimeout
	}
	return out
}

// New constructs a Server with the given Config. The server is not
// listening yet; call Start to open the port.
func New(cfg Config) *Server {
	return &Server{cfg: cfg.resolved()}
}

// SetEmit wires the per-session event emitter the server uses to
// publish engine_webhook_* observability events. Safe to call before
// or after Start.
func (s *Server) SetEmit(fn func(types.EngineEvent)) {
	s.mu.Lock()
	s.emit = fn
	s.mu.Unlock()
}

// SetSessionResolver wires the session-resolution callback the server
// invokes at fire time to build a fresh extension.Context for the
// host owning the matched route.
func (s *Server) SetSessionResolver(fn SessionResolver) {
	s.mu.Lock()
	s.resolve = fn
	s.mu.Unlock()
}

// AddHost adds a host whose webhook registry will be served. Idempotent:
// adding the same host twice is a no-op. Called by the session manager
// for each extension host after it loads.
func (s *Server) AddHost(h *extension.Host) {
	if h == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.hosts {
		if existing == h {
			return
		}
	}
	s.hosts = append(s.hosts, h)
	utils.Debug("webhooks", fmt.Sprintf("AddHost: ext=%s total_hosts=%d", h.Name(), len(s.hosts)))
}

// RemoveHost removes a host from the routing pool. Called at session
// teardown or extension dispose. In-flight requests for that host's
// routes resolve to 404 once it's removed.
func (s *Server) RemoveHost(h *extension.Host) {
	if h == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, existing := range s.hosts {
		if existing == h {
			s.hosts = append(s.hosts[:i], s.hosts[i+1:]...)
			utils.Debug("webhooks", fmt.Sprintf("RemoveHost: ext=%s remaining_hosts=%d", h.Name(), len(s.hosts)))
			return
		}
	}
}

// Start opens the configured listener. Returns an error when the bind
// fails (port busy, permission denied). Safe to call concurrently with
// AddHost / RemoveHost — registration mutations are serialized under
// s.mu and the listener goroutine reads them under the same lock.
//
// Logs the bound address loudly so it always shows up in operational
// logs; also Warns if a non-loopback interface is in use.
func (s *Server) Start() error {
	s.mu.Lock()
	if s.server != nil {
		s.mu.Unlock()
		utils.Debug("webhooks", "Start: already running, no-op")
		return nil
	}
	addr := net.JoinHostPort(s.cfg.BindInterface, fmt.Sprintf("%d", s.cfg.Port))
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		s.mu.Unlock()
		utils.Error("webhooks", fmt.Sprintf("Start: bind failed addr=%s err=%v", addr, err))
		return fmt.Errorf("webhooks: bind %s: %w", addr, err)
	}
	srv := &http.Server{
		Addr:              addr,
		Handler:           http.HandlerFunc(s.serveHTTP),
		ReadHeaderTimeout: 5 * time.Second,
	}
	s.listener = ln
	s.server = srv
	s.mu.Unlock()

	utils.Log("webhooks", fmt.Sprintf("Start: listening on %s (default-cap=%d bytes, fire-timeout=%s)",
		addr, s.cfg.DefaultMaxBodyBytes, s.cfg.FireTimeout))
	if s.cfg.BindInterface != "" && s.cfg.BindInterface != "127.0.0.1" && s.cfg.BindInterface != "localhost" && s.cfg.BindInterface != "::1" {
		utils.Warn("webhooks",
			fmt.Sprintf("non-loopback bind interface %q — webhook routes are exposed beyond localhost; verify auth on every route", s.cfg.BindInterface))
	}

	go func() {
		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			utils.Error("webhooks", fmt.Sprintf("server.Serve returned error: %v", err))
		}
	}()
	return nil
}

// Stop closes the listener and waits up to 5s for in-flight handlers
// to drain. Safe to call when the server is not running.
func (s *Server) Stop() {
	s.mu.Lock()
	srv := s.server
	s.server = nil
	s.listener = nil
	s.mu.Unlock()
	if srv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	utils.Log("webhooks", "Stop: shutting down listener")
	if err := srv.Shutdown(ctx); err != nil {
		utils.Warn("webhooks", fmt.Sprintf("Shutdown returned %v (forcing close)", err))
		_ = srv.Close()
	}
}

// Addr returns the bound listen address ("host:port") once the server
// is started, or "" otherwise. Useful for tests that ephemeral-bind
// on port 0 and need to discover the assigned port.
func (s *Server) Addr() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.listener == nil {
		return ""
	}
	return s.listener.Addr().String()
}

// lookupRoute searches every registered host for a route matching the
// given (path, method). Returns the first match; multi-host conflicts
// resolve to "first host registered" semantics. The exact-match path
// rule keeps routing predictable — no wildcards, no precedence layers.
//
// Method matching: if the route's Method is empty, it accepts POST.
// "*" matches every method (a forward-compat seam; not exposed via the
// SDK yet).
func (s *Server) lookupRoute(path, method string) (*extension.Host, extension.WebhookRoute, bool) {
	s.mu.RLock()
	hosts := append([]*extension.Host(nil), s.hosts...)
	s.mu.RUnlock()
	for _, h := range hosts {
		decl, ok := h.AsyncRegistry().ByID(asyncreg.KindWebhook, path)
		if !ok {
			continue
		}
		route, ok := decl.(extension.WebhookRoute)
		if !ok {
			continue
		}
		want := strings.ToUpper(route.Method)
		if want == "" {
			want = "POST"
		}
		got := strings.ToUpper(method)
		if want == got || want == "*" {
			return h, route, true
		}
	}
	return nil, extension.WebhookRoute{}, false
}

// serveHTTP is the engine's main handler. Implements the dispatch
// pipeline: route lookup → auth → body-size cap → session resolve →
// fire → response write, with full observability emission per step.
//
// Errors at each stage write a structured response (401/403/404/405/
// 413/500/503) and emit engine_webhook_handler_error (or
// engine_async_fire_dropped for resolve failures). The happy path
// emits engine_webhook_received → engine_webhook_authenticated →
// engine_webhook_responded.
func (s *Server) serveHTTP(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	requestID := utils.RandomID()
	host, route, found := s.lookupRoute(r.URL.Path, r.Method)
	if !found {
		// Distinguish path-unknown (404) from method-mismatch (405).
		if s.pathExistsAnyMethod(r.URL.Path) {
			s.respond(w, http.StatusMethodNotAllowed, "method not allowed", nil)
			s.emitWebhookError(requestID, "", r.Method, r.URL.Path, http.StatusMethodNotAllowed, "method_not_allowed", start)
			return
		}
		s.respond(w, http.StatusNotFound, "no route registered", nil)
		s.emitWebhookError(requestID, "", r.Method, r.URL.Path, http.StatusNotFound, "not_found", start)
		return
	}
	utils.Debug("webhooks", fmt.Sprintf("serveHTTP: req=%s path=%s method=%s host=%s",
		requestID, r.URL.Path, r.Method, host.Name()))
	s.emitWebhookReceived(requestID, route, r)

	// Body-size enforcement happens before auth so a giant unauth'd
	// POST doesn't get to spend RAM on its way to a 401.
	maxBytes := route.MaxBodyBytes
	if maxBytes == 0 {
		maxBytes = s.cfg.DefaultMaxBodyBytes
	}
	body, err := readBodyCapped(r.Body, maxBytes)
	if err != nil {
		s.respond(w, http.StatusRequestEntityTooLarge, "body too large", nil)
		s.emitWebhookError(requestID, route.Path, r.Method, route.Path, http.StatusRequestEntityTooLarge, "body_size", start)
		utils.Log("webhooks", fmt.Sprintf("serveHTTP: req=%s body too large (max=%d): %v", requestID, maxBytes, err))
		return
	}

	if authErr := authenticate(route.Auth, r, body, s.resolveToken(host, route)); authErr != nil {
		code := authErr.Status
		if code == 0 {
			code = http.StatusUnauthorized
		}
		s.respond(w, code, authErr.Message, nil)
		s.emitWebhookError(requestID, route.Path, r.Method, route.Path, code, "auth", start)
		utils.Log("webhooks", fmt.Sprintf("serveHTTP: req=%s auth rejected: %s (status=%d)", requestID, authErr.Message, code))
		return
	}
	s.emitWebhookAuthenticated(requestID, route, r)

	s.mu.RLock()
	resolve := s.resolve
	s.mu.RUnlock()
	if resolve == nil {
		s.respond(w, http.StatusServiceUnavailable, "session resolver not configured", nil)
		s.emitAsyncFireDropped(string(asyncreg.KindWebhook), route.Path, "no_resolver")
		utils.Error("webhooks", fmt.Sprintf("serveHTTP: req=%s no session resolver wired", requestID))
		return
	}
	ctx, err := resolve(host)
	if err != nil || ctx == nil {
		s.respond(w, http.StatusServiceUnavailable, "session not available", nil)
		s.emitAsyncFireDropped(string(asyncreg.KindWebhook), route.Path, "no_session")
		utils.Log("webhooks", fmt.Sprintf("serveHTTP: req=%s session resolve failed: %v", requestID, err))
		return
	}

	payload := buildRequestPayload(r, route, body)
	timeout := s.cfg.FireTimeout
	raw, err := host.FireAsync(asyncreg.KindWebhook, route.Path, ctx, payload, timeout)
	if err != nil {
		s.respond(w, http.StatusInternalServerError, fmt.Sprintf("handler error: %v", err), nil)
		s.emitWebhookError(requestID, route.Path, r.Method, route.Path, http.StatusInternalServerError, "handler_failed", start)
		utils.Log("webhooks", fmt.Sprintf("serveHTTP: req=%s handler failed: %v", requestID, err))
		return
	}

	// Decode handler response: {status, body, headers}. Missing fields
	// default to 200 / empty / no headers.
	status, respBody, respHeaders := decodeHandlerResponse(raw)
	for k, v := range respHeaders {
		w.Header().Set(k, v)
	}
	if w.Header().Get("Content-Type") == "" {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	}
	w.WriteHeader(status)
	if respBody != "" {
		_, _ = io.WriteString(w, respBody)
	}
	s.emitWebhookResponded(requestID, route, r, status, start)
	utils.Debug("webhooks", fmt.Sprintf("serveHTTP: req=%s responded status=%d body_len=%d elapsed=%s",
		requestID, status, len(respBody), time.Since(start)))
}

// pathExistsAnyMethod returns true when the given path is registered
// under any method on any host. Used to distinguish 404 from 405.
func (s *Server) pathExistsAnyMethod(path string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, h := range s.hosts {
		if _, ok := h.AsyncRegistry().ByID(asyncreg.KindWebhook, path); ok {
			return true
		}
	}
	return false
}

// respond writes a minimal text/plain response. Used for engine-level
// errors (404, 405, 413, 401, 403, 503, 500) — handler-supplied
// responses bypass this and write directly.
func (s *Server) respond(w http.ResponseWriter, status int, body string, _ map[string]string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

// readBodyCapped reads up to maxBytes from r and returns the body. A
// body larger than maxBytes returns an error so the caller can respond
// 413 without ever materialising the full payload.
//
// maxBytes <= 0 disables the cap (the route opted out — discouraged but
// allowed for advanced use). The cap is applied at the io.Reader layer
// so memory usage stays bounded.
func readBodyCapped(r io.ReadCloser, maxBytes int64) ([]byte, error) {
	defer func() { _ = r.Close() }()
	if maxBytes <= 0 {
		return io.ReadAll(r)
	}
	limited := io.LimitReader(r, maxBytes+1)
	buf, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(buf)) > maxBytes {
		return nil, fmt.Errorf("body exceeds %d byte cap", maxBytes)
	}
	return buf, nil
}

// resolveToken returns a function the auth layer calls when it needs
// the secret value for the given route. The function dispatches an
// engine/resolve_token RPC into the subprocess so the extension's
// `() => string` callback runs there.
//
// Returns "" on resolution failure — auth treats empty tokens as a
// rejected request via constant-time compare against the empty string.
func (s *Server) resolveToken(host *extension.Host, route extension.WebhookRoute) func() string {
	return func() string {
		if route.Auth.TokenRefName == "" {
			return ""
		}
		raw, err := host.ResolveToken(route.Auth.TokenRefName)
		if err != nil {
			utils.Log("webhooks", fmt.Sprintf("resolveToken: ext=%s ref=%s failed: %v",
				host.Name(), route.Auth.TokenRefName, err))
			return ""
		}
		return raw
	}
}

// authError carries an HTTP status code and human-readable message
// for a failed authentication. The serve loop maps Status to the
// response code.
type authError struct {
	Status  int
	Message string
}

// authenticate validates the request against the route's WebhookAuth
// declaration. Returns nil on success or *authError on failure.
//
// Auth strategies:
//   - none: always succeeds.
//   - bearer: requires Authorization: Bearer <token>.
//   - shared-secret: requires HeaderName == TokenRefName-resolved value.
//   - hmac-signature: HeaderName carries hex-encoded HMAC-SHA256 of the
//     raw body using TokenRefName-resolved secret as key.
//
// All comparisons use crypto/subtle.ConstantTimeCompare so timing
// attacks cannot leak the expected value.
func authenticate(auth extension.WebhookAuth, r *http.Request, body []byte, resolveToken func() string) *authError {
	switch auth.Kind {
	case extension.AuthNone:
		return nil
	case extension.AuthBearer:
		got := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		expected := resolveToken()
		if expected == "" {
			return &authError{Status: http.StatusUnauthorized, Message: "auth: token not configured"}
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			return &authError{Status: http.StatusUnauthorized, Message: "auth: bearer token mismatch"}
		}
		return nil
	case extension.AuthSharedSecret:
		got := r.Header.Get(auth.HeaderName)
		expected := resolveToken()
		if expected == "" {
			return &authError{Status: http.StatusUnauthorized, Message: "auth: secret not configured"}
		}
		if subtle.ConstantTimeCompare([]byte(got), []byte(expected)) != 1 {
			return &authError{Status: http.StatusUnauthorized, Message: "auth: shared-secret header mismatch"}
		}
		return nil
	case extension.AuthHmacSignature:
		got := r.Header.Get(auth.HeaderName)
		secret := resolveToken()
		if secret == "" {
			return &authError{Status: http.StatusUnauthorized, Message: "auth: hmac key not configured"}
		}
		if !verifyHmacSha256(body, []byte(secret), got) {
			return &authError{Status: http.StatusForbidden, Message: "auth: hmac signature mismatch"}
		}
		return nil
	default:
		return &authError{Status: http.StatusInternalServerError, Message: fmt.Sprintf("auth: unknown kind %q", auth.Kind)}
	}
}
