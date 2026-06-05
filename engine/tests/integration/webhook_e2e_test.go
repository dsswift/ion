//go:build integration

// End-to-end tests for the webhook HTTP server + extension subprocess
// pipeline. These tests boot a real net.Listener (ephemeral port), load
// the async-canary extension via a real subprocess, and send actual
// http.Get / http.Post requests to verify the full dispatch path:
//
//   net/http listener -> Server.serveHTTP -> lookupRoute -> authenticate
//     -> sessionResolver -> Host.FireAsync -> subprocess SDK handler
//     -> response written back over net.Conn -> http.Response decoded
//
// Each test asserts both the HTTP response shape AND the observability
// event sequence emitted along the way.

package integration

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/webhooks"
)

// e2eEnv bundles the moving parts a webhook end-to-end test needs: a
// loaded async-canary subprocess, a webhook server bound to an
// ephemeral port, an event collector, and a session resolver that
// hands the host a minimal but valid Context.
//
// Cleanup is registered with t.Cleanup so a leaked listener or
// subprocess can't bleed into the next test.
type e2eEnv struct {
	host     *extension.Host
	server   *webhooks.Server
	addr     string
	events   *eventBus
	emitFn   func(types.EngineEvent)
}

// eventBus is the minimal "captures every event" sink the server
// publishes to. Real production code routes through the session
// manager, but we don't need the session machinery here — just a
// faithful collector that the test can poll for assertions.
type eventBus struct {
	mu     sync.Mutex
	events []types.EngineEvent
}

func (b *eventBus) emit(ev types.EngineEvent) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.events = append(b.events, ev)
}

func (b *eventBus) snapshot() []types.EngineEvent {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]types.EngineEvent, len(b.events))
	copy(out, b.events)
	return out
}

func (b *eventBus) ofType(t string) []types.EngineEvent {
	all := b.snapshot()
	var out []types.EngineEvent
	for _, ev := range all {
		if ev.Type == t {
			out = append(out, ev)
		}
	}
	return out
}

// setupWebhookE2E loads the async-canary, commits its init
// declarations, starts a webhooks.Server on an ephemeral port, wires
// it to the host, and returns an e2eEnv with all the moving parts.
//
// The session resolver returns a stub Context with just SessionKey set
// — this matches the real prod behavior for handlers that only call
// dispatchAgent / emit / etc. through subsequent ext/* RPCs (which
// pick up the context via Host.FireAsync's ctxStack push).
func setupWebhookE2E(t *testing.T) *e2eEnv {
	t.Helper()
	requireEsbuild(t)
	// Clean any stale env from a previous run.
	t.Setenv("ASYNC_CANARY_TOKEN", "test-secret")

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })

	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load async-canary: %v", err)
	}

	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	bus := &eventBus{}
	srv := webhooks.New(webhooks.Config{
		Port:          0, // ephemeral
		BindInterface: "127.0.0.1",
		// Short fire timeout so a hung handler fails fast in test.
		FireTimeout: 5 * time.Second,
	})
	srv.SetEmit(bus.emit)
	srv.SetSessionResolver(func(h *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "e2e-test"}, nil
	})
	srv.AddHost(host)
	if err := srv.Start(); err != nil {
		t.Fatalf("server.Start: %v", err)
	}
	t.Cleanup(srv.Stop)

	return &e2eEnv{
		host:   host,
		server: srv,
		addr:   srv.Addr(),
		events: bus,
		emitFn: bus.emit,
	}
}

// waitForEvent polls the bus for an event with the given type up to
// the deadline. Returns the first match or fails the test. Used to
// avoid racey assert-immediately patterns when the engine emits
// events asynchronously.
func waitForEvent(t *testing.T, bus *eventBus, evType string, deadline time.Duration) types.EngineEvent {
	t.Helper()
	expire := time.Now().Add(deadline)
	for time.Now().Before(expire) {
		matches := bus.ofType(evType)
		if len(matches) > 0 {
			return matches[0]
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("event %q never arrived within %s; saw: %v", evType, deadline, summariseEvents(bus.snapshot()))
	return types.EngineEvent{}
}

// summariseEvents returns just the type strings for diagnostic output
// when an expected event never arrived.
func summariseEvents(events []types.EngineEvent) []string {
	out := make([]string, len(events))
	for i, ev := range events {
		out[i] = ev.Type
	}
	return out
}

// ─── HTTP end-to-end: happy path with bearer auth ───

// TestWebhookE2E_BearerAuthHappyPath drives a real HTTP request
// through the listener with a correct bearer token, then asserts
// every observability event fired in the expected order and the
// response is the handler's actual JSON.
func TestWebhookE2E_BearerAuthHappyPath(t *testing.T) {
	env := setupWebhookE2E(t)

	body := `{"name":"e2e"}`
	req, _ := http.NewRequest("POST", "http://"+env.addr+"/test/hello", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer test-secret")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Trace", "abc")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP request failed: %v", err)
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, body = %q", resp.StatusCode, string(respBody))
	}
	// Handler-set header must round-trip.
	if got := resp.Header.Get("X-Async-Canary"); got != "ok" {
		t.Errorf("X-Async-Canary header = %q, want ok", got)
	}
	var parsed struct {
		Greeted string `json:"greeted"`
		Echo    string `json:"echo"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		t.Fatalf("decode body: %v (raw=%q)", err, string(respBody))
	}
	if parsed.Greeted != "e2e" {
		t.Errorf("greeted = %q, want e2e", parsed.Greeted)
	}
	if parsed.Echo != body {
		t.Errorf("echo = %q, want %q", parsed.Echo, body)
	}

	// Observability: received → authenticated → responded, in order.
	received := waitForEvent(t, env.events, "engine_webhook_received", time.Second)
	if received.AsyncKind != "webhook" || received.AsyncID != "/test/hello" || received.AsyncMethod != "POST" {
		t.Errorf("engine_webhook_received fields wrong: %+v", received)
	}
	if received.AsyncRequestID == "" {
		t.Error("expected AsyncRequestID on received")
	}
	authed := waitForEvent(t, env.events, "engine_webhook_authenticated", time.Second)
	if authed.AsyncRequestID != received.AsyncRequestID {
		t.Errorf("request id should match across received/authenticated: %s vs %s",
			received.AsyncRequestID, authed.AsyncRequestID)
	}
	responded := waitForEvent(t, env.events, "engine_webhook_responded", time.Second)
	if responded.AsyncStatus != 200 {
		t.Errorf("responded status = %d, want 200", responded.AsyncStatus)
	}
	if responded.AsyncDurationMs < 0 {
		t.Errorf("durationMs should be >= 0, got %d", responded.AsyncDurationMs)
	}

	// And critically: NO handler_error event was emitted on the happy
	// path. A spurious error event would silently mask real failures
	// in downstream consumers.
	if errs := env.events.ofType("engine_webhook_handler_error"); len(errs) != 0 {
		t.Errorf("unexpected handler_error events on happy path: %+v", errs)
	}
}

// ─── HTTP end-to-end: bearer auth failure modes ───

func TestWebhookE2E_BearerAuthWrongToken(t *testing.T) {
	env := setupWebhookE2E(t)

	req, _ := http.NewRequest("POST", "http://"+env.addr+"/test/hello", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer WRONG")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("HTTP request: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}

	errEv := waitForEvent(t, env.events, "engine_webhook_handler_error", time.Second)
	if errEv.AsyncReason != "auth" {
		t.Errorf("reason = %q, want auth", errEv.AsyncReason)
	}
	if errEv.AsyncStatus != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", errEv.AsyncStatus)
	}

	// No authenticated / responded event should have fired.
	if events := env.events.ofType("engine_webhook_authenticated"); len(events) != 0 {
		t.Errorf("auth failed but engine_webhook_authenticated fired: %+v", events)
	}
	if events := env.events.ofType("engine_webhook_responded"); len(events) != 0 {
		t.Errorf("auth failed but engine_webhook_responded fired: %+v", events)
	}
}

func TestWebhookE2E_BearerAuthMissingHeader(t *testing.T) {
	env := setupWebhookE2E(t)

	resp, err := http.Post("http://"+env.addr+"/test/hello", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
}

// ─── HTTP end-to-end: 404 and 405 routing ───

func TestWebhookE2E_UnknownPath404(t *testing.T) {
	env := setupWebhookE2E(t)

	resp, err := http.Get("http://" + env.addr + "/nope")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	errEv := waitForEvent(t, env.events, "engine_webhook_handler_error", time.Second)
	if errEv.AsyncReason != "not_found" {
		t.Errorf("reason = %q, want not_found", errEv.AsyncReason)
	}
}

func TestWebhookE2E_KnownPathWrongMethod405(t *testing.T) {
	env := setupWebhookE2E(t)

	// /test/hello is registered for POST; sending GET must yield 405.
	resp, err := http.Get("http://" + env.addr + "/test/hello")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", resp.StatusCode)
	}
	errEv := waitForEvent(t, env.events, "engine_webhook_handler_error", time.Second)
	if errEv.AsyncReason != "method_not_allowed" {
		t.Errorf("reason = %q, want method_not_allowed", errEv.AsyncReason)
	}
}

// ─── HTTP end-to-end: body size cap ───

func TestWebhookE2E_BodyTooLarge413(t *testing.T) {
	env := setupWebhookE2E(t)

	// /test/hello inherits the engine default (1 MiB). Send 2 MiB.
	bigBody := bytes.Repeat([]byte("x"), 2<<20)
	req, _ := http.NewRequest("POST", "http://"+env.addr+"/test/hello", bytes.NewReader(bigBody))
	req.Header.Set("Authorization", "Bearer test-secret")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", resp.StatusCode)
	}
	errEv := waitForEvent(t, env.events, "engine_webhook_handler_error", time.Second)
	if errEv.AsyncReason != "body_size" {
		t.Errorf("reason = %q, want body_size", errEv.AsyncReason)
	}
}

// ─── HTTP end-to-end: dynamic-registered route ───

// TestWebhookE2E_DynamicRouteServesHTTP confirms that a route
// registered at runtime (via the async_canary_register_dynamic_webhook
// tool) actually appears in the HTTP listener's route table and
// responds to real requests. This is the layered version of
// TestAsyncCanary_DynamicWebhookRegistration that goes all the way
// through net/http rather than calling FireAsync directly.
func TestWebhookE2E_DynamicRouteServesHTTP(t *testing.T) {
	env := setupWebhookE2E(t)

	// Trigger the canary tool that does runtime ion.webhooks.register.
	tool := findTool(t, env.host, "async_canary_register_dynamic_webhook")
	ctx := &extension.Context{SessionKey: "e2e-test"}
	result, err := tool.Execute(map[string]any{}, ctx)
	if err != nil || result == nil || result.IsError {
		t.Fatalf("register tool failed: result=%+v err=%v", result, err)
	}

	// The new /test/dynamic route should now be reachable via HTTP.
	resp, err := http.Post("http://"+env.addr+"/test/dynamic", "text/plain", strings.NewReader(""))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d body=%q", resp.StatusCode, string(body))
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "dynamic" {
		t.Fatalf("body = %q, want dynamic", string(body))
	}
}

// ─── HTTP end-to-end: HMAC and shared-secret auth ───

// TestWebhookE2E_HmacAndSharedSecretAuth registers two extra routes
// via the new register-with-auth canary tool, then exercises each
// auth flavor with a real HTTP request. We bypass the canary's
// module-scope bearer-only route and use a fresh host so the test is
// self-contained.
func TestWebhookE2E_HmacAndSharedSecretAuth(t *testing.T) {
	requireEsbuild(t)
	t.Setenv("ASYNC_CANARY_TOKEN", "ignored")
	t.Setenv("ASYNC_CANARY_HMAC_SECRET", "hmac-key")
	t.Setenv("ASYNC_CANARY_SHARED_SECRET", "shared-value")

	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })
	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load async-canary: %v", err)
	}
	if errs := host.CommitPendingAsyncDecls(); len(errs) != 0 {
		t.Fatalf("commit errors: %v", errs)
	}

	bus := &eventBus{}
	srv := webhooks.New(webhooks.Config{Port: 0, BindInterface: "127.0.0.1", FireTimeout: 5 * time.Second})
	srv.SetEmit(bus.emit)
	srv.SetSessionResolver(func(h *extension.Host) (*extension.Context, error) {
		return &extension.Context{SessionKey: "auth-e2e"}, nil
	})
	srv.AddHost(host)
	if err := srv.Start(); err != nil {
		t.Fatalf("server.Start: %v", err)
	}
	t.Cleanup(srv.Stop)
	addr := srv.Addr()

	// Register an HMAC route and a shared-secret route via canary tools.
	if _, err := findTool(t, host, "async_canary_register_hmac_route").Execute(map[string]any{}, &extension.Context{SessionKey: "auth-e2e"}); err != nil {
		t.Fatalf("register hmac route: %v", err)
	}
	if _, err := findTool(t, host, "async_canary_register_shared_secret_route").Execute(map[string]any{}, &extension.Context{SessionKey: "auth-e2e"}); err != nil {
		t.Fatalf("register shared-secret route: %v", err)
	}

	// ── HMAC: correct signature succeeds ──
	body := []byte(`{"event":"push"}`)
	mac := hmac.New(sha256.New, []byte("hmac-key"))
	mac.Write(body)
	sig := hex.EncodeToString(mac.Sum(nil))

	req, _ := http.NewRequest("POST", "http://"+addr+"/test/hmac", bytes.NewReader(body))
	req.Header.Set("X-Signature", "sha256="+sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("hmac POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("hmac status = %d", resp.StatusCode)
	}

	// ── HMAC: wrong signature → 403 ──
	req2, _ := http.NewRequest("POST", "http://"+addr+"/test/hmac", bytes.NewReader(body))
	req2.Header.Set("X-Signature", "sha256=0000000000000000000000000000000000000000000000000000000000000000")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("hmac wrong-sig POST: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusForbidden {
		t.Fatalf("hmac wrong-sig status = %d, want 403", resp2.StatusCode)
	}

	// ── Shared secret: correct header succeeds ──
	req3, _ := http.NewRequest("POST", "http://"+addr+"/test/shared", strings.NewReader(""))
	req3.Header.Set("X-Token", "shared-value")
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		t.Fatalf("shared POST: %v", err)
	}
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusOK {
		t.Fatalf("shared status = %d", resp3.StatusCode)
	}

	// ── Shared secret: wrong header → 401 ──
	req4, _ := http.NewRequest("POST", "http://"+addr+"/test/shared", strings.NewReader(""))
	req4.Header.Set("X-Token", "WRONG")
	resp4, err := http.DefaultClient.Do(req4)
	if err != nil {
		t.Fatalf("shared wrong POST: %v", err)
	}
	defer resp4.Body.Close()
	if resp4.StatusCode != http.StatusUnauthorized {
		t.Fatalf("shared wrong status = %d, want 401", resp4.StatusCode)
	}
}

// ─── Listener lifecycle ───

func TestWebhookE2E_StopReleasesPort(t *testing.T) {
	requireEsbuild(t)
	t.Setenv("ASYNC_CANARY_TOKEN", "x")
	host := extension.NewHost()
	t.Cleanup(func() { host.Dispose() })
	entry := asyncCanaryEntry(t)
	if err := host.Load(entry, &extension.ExtensionConfig{
		ExtensionDir:     filepath.Dir(entry),
		WorkingDirectory: t.TempDir(),
	}); err != nil {
		t.Fatalf("load: %v", err)
	}
	_ = host.CommitPendingAsyncDecls()

	srv := webhooks.New(webhooks.Config{Port: 0, BindInterface: "127.0.0.1"})
	srv.SetEmit(func(types.EngineEvent) {})
	srv.SetSessionResolver(func(h *extension.Host) (*extension.Context, error) {
		return &extension.Context{}, nil
	})
	srv.AddHost(host)
	if err := srv.Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}

	addr := srv.Addr()
	// Sanity: port is listening.
	if _, err := net.DialTimeout("tcp", addr, 200*time.Millisecond); err != nil {
		t.Fatalf("expected port to accept connections: %v", err)
	}
	srv.Stop()
	// After Stop, the port should be released — give it a moment to
	// reach a clean shutdown state and then verify.
	time.Sleep(50 * time.Millisecond)
	conn, err := net.DialTimeout("tcp", addr, 200*time.Millisecond)
	if err == nil {
		_ = conn.Close()
		t.Fatalf("port still accepting connections after Stop()")
	}
}

// ─── Registry mutation -> route table reflow ───

// TestWebhookE2E_DeregisteredRouteReturns404 confirms that
// host.DeregisterWebhookDecl removes the route from the HTTP
// listener's view too. Without this guarantee a "soft remove" would
// leave a ghost endpoint live.
func TestWebhookE2E_DeregisteredRouteReturns404(t *testing.T) {
	env := setupWebhookE2E(t)

	// Sanity: /test/hello works.
	req, _ := http.NewRequest("POST", "http://"+env.addr+"/test/hello", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer test-secret")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("pre-check: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("pre-check status = %d", resp.StatusCode)
	}

	// Deregister.
	if !env.host.DeregisterWebhookDecl("/test/hello") {
		t.Fatal("DeregisterWebhookDecl returned false")
	}

	// /test/hello should now 404.
	req2, _ := http.NewRequest("POST", "http://"+env.addr+"/test/hello", strings.NewReader("{}"))
	req2.Header.Set("Authorization", "Bearer test-secret")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("post-deregister: %v", err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusNotFound {
		t.Fatalf("after deregister status = %d, want 404", resp2.StatusCode)
	}
}

// ensureUnusedRegistryReference keeps the asyncreg import live even
// when individual tests don't use it directly. Trivial; keeps go vet
// happy under future edits.
var _ = asyncreg.KindWebhook
