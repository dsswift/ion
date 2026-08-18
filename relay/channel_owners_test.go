package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/golang-jwt/jwt/v5"
)

// ---- Channel isolation store unit tests ----

func TestChannelOwnerStore_Bind(t *testing.T) {
	dir := t.TempDir()
	s := newChannelOwnerStore(dir)

	// First bind should succeed.
	if !s.Bind("chan-1", "subject-A") {
		t.Fatal("first Bind should succeed")
	}

	// Second bind with same subject should succeed (idempotent).
	if !s.Bind("chan-1", "subject-A") {
		t.Fatal("re-bind with same subject should succeed")
	}

	// Bind with different subject should fail.
	if s.Bind("chan-1", "subject-B") {
		t.Fatal("bind with different subject should fail")
	}
}

func TestChannelOwnerStore_Owner(t *testing.T) {
	s := newChannelOwnerStore("")

	_, ok := s.Owner("nonexistent")
	if ok {
		t.Fatal("Owner of nonexistent channel should return false")
	}

	s.Bind("chan-x", "subject-X")
	owner, ok := s.Owner("chan-x")
	if !ok {
		t.Fatal("Owner should return true after Bind")
	}
	if owner != "subject-X" {
		t.Errorf("Owner: got %q, want %q", owner, "subject-X")
	}
}

func TestChannelOwnerStore_Persistence(t *testing.T) {
	dir := t.TempDir()

	// First store: bind a channel.
	s1 := newChannelOwnerStore(dir)
	s1.Bind("persist-chan", "subject-persist")

	// Verify file was written.
	path := filepath.Join(dir, "owner-persist-chan.json")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("expected owner file to be written to disk")
	}

	// Second store: load from disk.
	s2 := newChannelOwnerStore(dir)
	owner, ok := s2.Owner("persist-chan")
	if !ok {
		t.Fatal("expected channel to be loaded from disk")
	}
	if owner != "subject-persist" {
		t.Errorf("loaded owner: got %q, want %q", owner, "subject-persist")
	}
}

// TestChannelOwnerStore_LoadFailureIsLoggedAndIsolated pins that a corrupt
// owner file is logged (never a silent binding-drop) and does not take down
// the other bindings in the same directory. A silently-dropped binding makes
// a channel rebindable by a different subject, so the failure must surface.
func TestChannelOwnerStore_LoadFailureIsLoggedAndIsolated(t *testing.T) {
	dir := t.TempDir()

	// One good binding written through the normal path.
	seed := newChannelOwnerStore(dir)
	seed.Bind("good-chan", "subject-good")

	// One corrupt file that will fail json.Unmarshal.
	corrupt := filepath.Join(dir, "owner-corrupt-chan.json")
	if err := os.WriteFile(corrupt, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write corrupt: %v", err)
	}

	testLogger, buf := captureLogger()
	orig := logger
	logger = testLogger
	t.Cleanup(func() { logger = orig })

	// Reload: the corrupt file must be logged and skipped; the good binding survives.
	s := newChannelOwnerStore(dir)
	if _, ok := s.Owner("good-chan"); !ok {
		t.Error("good binding dropped by a corrupt sibling file")
	}
	if _, ok := s.Owner("corrupt-chan"); ok {
		t.Error("corrupt file should not have produced a binding")
	}
	if !strings.Contains(string(buf.Bytes()), "unmarshal failed") {
		t.Errorf("corrupt owner file must be logged, not silently skipped; log=%q", string(buf.Bytes()))
	}
}

func TestValidChannelID(t *testing.T) {
	valid := []string{"abc", "chan-1", "chan_2", "Device.42", "a", strings.Repeat("x", 128)}
	for _, id := range valid {
		if !validChannelID(id) {
			t.Errorf("expected %q to be valid", id)
		}
	}
	invalid := []string{
		"",                       // empty
		".",                      // leading dot / traversal
		"..",                     // traversal
		"../escape",              // traversal with separator
		"a/b",                    // path separator
		"a\\b",                   // windows separator
		"a b",                    // space
		"chan\x00",               // control
		".hidden",                // leading dot
		strings.Repeat("x", 129), // too long
	}
	for _, id := range invalid {
		if validChannelID(id) {
			t.Errorf("expected %q to be rejected", id)
		}
	}
}

func TestChannelOwnerStore_MemoryOnly(t *testing.T) {
	// dir="" means memory-only; no files written.
	s := newChannelOwnerStore("")
	s.Bind("m-chan", "subject-M")
	owner, ok := s.Owner("m-chan")
	if !ok || owner != "subject-M" {
		t.Error("memory-only store should track ownership in-memory")
	}
}

// ---- Channel isolation integration (HTTP 403 before WebSocket upgrade) ----

// startOIDCRelay builds a test relay server with OIDC enabled.
// The returned closeFn must be called to clean up.
func startOIDCRelay(t *testing.T, oidcCfg *OIDCConfig) (*httptest.Server, *Hub, *channelOwnerStore) {
	t.Helper()
	hub := NewHub()
	owners := newChannelOwnerStore(t.TempDir())
	auth := NewAuthMiddleware("", oidcCfg)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/auth/config", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"oidc":true,"psk":false,"capabilities":{"mobileForwardAck":true}}`))
	})
	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.Validate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		if role != "ion" && role != "mobile" {
			http.Error(w, "bad role", http.StatusBadRequest)
			return
		}
		if identity != nil {
			if !owners.Bind(channelID, identity.Subject) {
				http.Error(w, "forbidden", http.StatusForbidden)
				return
			}
		}
		hub.HandleWebSocket(w, r, channelID, role, nil, identity)
	})
	mux.HandleFunc("GET /v1/channel/{channelId}/status", func(w http.ResponseWriter, r *http.Request) {
		identity, ok := auth.Validate(r)
		if !ok {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		channelID := r.PathValue("channelId")
		// Mirror production least-privilege presence: live presence only for a
		// channel the subject already owns; unbound or other-owned returns
		// empty presence (never a live-presence oracle).
		if identity != nil {
			owner, owned := owners.Owner(channelID)
			if !owned || owner != identity.Subject {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"ion":false,"mobile":false}`))
				return
			}
		}
		ion, mobile := hub.ChannelStatus(channelID)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ion":` + boolStr(ion) + `,"mobile":` + boolStr(mobile) + `}`))
	})

	srv := httptest.NewServer(mux)
	t.Cleanup(func() { hub.CloseAll(); srv.Close() })
	return srv, hub, owners
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// dialWSWithToken dials the relay WebSocket with a JWT bearer.
// Fails the test on dial error. Returns the connection.
func dialWSWithToken(t *testing.T, srv *httptest.Server, channelID, role, token string) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/channel/" + channelID + "?role=" + role
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, resp, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}},
	})
	return conn, resp, err
}

func TestChannelIsolation_AcceptsSameSubject(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	relaySrv, _, _ := startOIDCRelay(t, oidcCfg)

	// Subject-A connects as ion.
	claims := standardClaims(oidcSrv.URL, "test-audience")
	claims["oid"] = "subject-A"
	token := makeJWT(t, key, claims)

	conn, _, err := dialWSWithToken(t, relaySrv, "iso-chan", "ion", token)
	if err != nil {
		t.Fatalf("subject-A ion: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	// Subject-A connects as mobile (same subject — should succeed).
	conn2, _, err := dialWSWithToken(t, relaySrv, "iso-chan", "mobile", token)
	if err != nil {
		t.Fatalf("subject-A mobile: %v", err)
	}
	t.Cleanup(func() { conn2.CloseNow() })
}

func TestChannelIsolation_DeniesDifferentSubject(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	relaySrv, _, _ := startOIDCRelay(t, oidcCfg)

	// Subject-A binds the channel.
	claimsA := standardClaims(oidcSrv.URL, "test-audience")
	claimsA["oid"] = "subject-A"
	tokenA := makeJWT(t, key, claimsA)

	conn, _, err := dialWSWithToken(t, relaySrv, "deny-chan", "ion", tokenA)
	if err != nil {
		t.Fatalf("subject-A connect: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })

	// Subject-B tries to connect — should get 403.
	claimsB := standardClaims(oidcSrv.URL, "test-audience")
	claimsB["oid"] = "subject-B"
	claimsB["sub"] = "subject-B"
	tokenB := makeJWT(t, key, claimsB)

	_, resp, err := dialWSWithToken(t, relaySrv, "deny-chan", "mobile", tokenB)
	if err == nil {
		t.Fatal("expected subject-B to be denied (403)")
	}
	if resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403, got %v", resp)
	}
}

func TestChannelIsolation_PSKSkipsIsolation(t *testing.T) {
	// PSK connections bypass channel isolation entirely.
	// startTestRelay uses PSK-only, no channel isolation.
	server, _ := startTestRelay(t, "psk-key")

	// Two different PSK clients connecting to the same channel should work.
	conn1 := dialWS(t, server, "psk-chan", "ion", "psk-key")
	conn2 := dialWS(t, server, "psk-chan", "mobile", "psk-key")

	// Consume the peer-reconnected message on ion.
	readExpected(t, conn1, "ion-ctrl")

	// Forward a message to verify both are connected.
	ctx := context.Background()
	if err := conn1.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		t.Fatalf("write: %v", err)
	}
	data := readExpected(t, conn2, "mobile")
	if string(data) != "hello" {
		t.Errorf("got %q, want %q", data, "hello")
	}
}

func TestChannelIsolation_PersistenceAcrossRestart(t *testing.T) {
	dir := t.TempDir()

	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)

	// First relay instance: bind the channel.
	oidcCfg1, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	store1 := newChannelOwnerStore(dir)
	store1.Bind("restart-chan", "subject-A")

	// Simulate restart: second store loads from same dir.
	oidcCfg2, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig (2): %v", err)
	}
	_ = oidcCfg1
	_ = oidcCfg2

	store2 := newChannelOwnerStore(dir)
	owner, ok := store2.Owner("restart-chan")
	if !ok {
		t.Fatal("expected ownership to persist across restart")
	}
	if owner != "subject-A" {
		t.Errorf("persisted owner: got %q, want %q", owner, "subject-A")
	}

	// Subject-B should still be denied.
	if store2.Bind("restart-chan", "subject-B") {
		t.Error("subject-B should be denied after restart")
	}
}

// ---- Status endpoint subject gating in OIDC mode ----

func TestStatusEndpoint_SubjectGating(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	relaySrv, _, owners := startOIDCRelay(t, oidcCfg)

	// Manually bind channel to subject-A without a WebSocket connection.
	owners.Bind("status-chan", "subject-A")

	makeStatusRequest := func(token string) *http.Response {
		req, _ := http.NewRequest("GET", relaySrv.URL+"/v1/channel/status-chan/status", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("status request: %v", err)
		}
		return resp
	}

	// Subject-A should see the status.
	claimsA := standardClaims(oidcSrv.URL, "test-audience")
	claimsA["oid"] = "subject-A"
	tokenA := makeJWT(t, key, claimsA)
	respA := makeStatusRequest(tokenA)
	defer respA.Body.Close()
	if respA.StatusCode != http.StatusOK {
		t.Errorf("subject-A: expected 200, got %d", respA.StatusCode)
	}

	// Subject-B owns nothing on this channel. Least-privilege: it must not
	// receive a live-presence oracle. The response is an empty-presence 200,
	// never the real hub booleans and never a 403 that itself leaks existence.
	claimsB := jwt.MapClaims{
		"iss": oidcSrv.URL,
		"aud": "test-audience",
		"sub": "subject-B",
		"oid": "subject-B",
		"exp": time.Now().Add(time.Hour).Unix(),
		"nbf": time.Now().Add(-time.Minute).Unix(),
		"iat": time.Now().Add(-time.Minute).Unix(),
	}
	tokenB := makeJWT(t, key, claimsB)
	respB := makeStatusRequest(tokenB)
	defer respB.Body.Close()
	if respB.StatusCode != http.StatusOK {
		t.Errorf("subject-B: expected empty-presence 200, got %d", respB.StatusCode)
	}
	bodyB, _ := io.ReadAll(respB.Body)
	if strings.Contains(string(bodyB), "true") {
		t.Errorf("subject-B must not see live presence on a channel it does not own; got %q", string(bodyB))
	}
}

// TestStatusEndpoint_UnboundChannelNoOracle pins that an authenticated subject
// cannot read live presence on an UNBOUND channel (one nobody owns yet) — the
// cross-tenant presence oracle the least-privilege gate closes.
func TestStatusEndpoint_UnboundChannelNoOracle(t *testing.T) {
	key := genRSAKey(t)
	oidcSrv := startFakeOIDCServer(t, &key.PublicKey)
	oidcCfg, err := NewOIDCConfig(oidcSrv.URL, "test-audience", "")
	if err != nil {
		t.Fatalf("NewOIDCConfig: %v", err)
	}
	relaySrv, _, _ := startOIDCRelay(t, oidcCfg)

	// No Bind call — "unbound-chan" is owned by nobody.
	claims := standardClaims(oidcSrv.URL, "test-audience")
	claims["oid"] = "prober"
	token := makeJWT(t, key, claims)

	req, _ := http.NewRequest("GET", relaySrv.URL+"/v1/channel/unbound-chan/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("status request: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if strings.Contains(string(body), "true") {
		t.Errorf("unbound channel must not reveal live presence to a non-owner; got %q", string(body))
	}
}
