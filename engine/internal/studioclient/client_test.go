package studioclient

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// fakeRelay plays a relay and the Studio server behind it: it answers a
// pair_request on a pairing channel, then serves the sealed Studio wire on
// the pairing's own channel the way a real server does.
type fakeRelay struct {
	t      *testing.T
	srv    *httptest.Server
	bearer string
	server KeyPair
	mu     sync.Mutex
	secret []byte
	hello  map[string]any
}

func newFakeRelay(t *testing.T, bearer string) *fakeRelay {
	server, err := GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRelay{t: t, bearer: bearer, server: server}
	f.srv = httptest.NewServer(http.HandlerFunc(f.handle))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeRelay) handle(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1/auth/config" {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"oidc":true,"psk":false,"issuer":"https://issuer.example.org/","audience":"relay-app","requiredScope":"Relay.Access"}`)) //nolint:errcheck // test response
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+f.bearer {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	channel := strings.TrimPrefix(r.URL.Path, "/v1/channel/")
	if r.URL.Query().Get("role") != "mobile" {
		http.Error(w, "role", http.StatusBadRequest)
		return
	}
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow() //nolint:errcheck // test socket teardown
	ctx := r.Context()
	conn.Write(ctx, websocket.MessageText, []byte(`{"type":"relay:peer_joined"}`)) //nolint:errcheck // a control frame the client must skip
	if strings.HasPrefix(channel, "pairing:") {
		f.servePairing(ctx, conn)
		return
	}
	f.mu.Lock()
	secret := f.secret
	f.mu.Unlock()
	if secret == nil || channel != ChannelID(secret) {
		conn.Close(websocket.StatusPolicyViolation, "unknown channel") //nolint:errcheck // test refusal
		return
	}
	f.serveStudio(ctx, conn, secret)
}

func (f *fakeRelay) servePairing(ctx context.Context, conn *websocket.Conn) {
	_, data, err := conn.Read(ctx)
	if err != nil {
		return
	}
	var req PairRequest
	if json.Unmarshal(data, &req) != nil || req.Type != "pair_request" || req.Code != strings.Repeat("a", 32) {
		conn.Write(ctx, websocket.MessageText, []byte(`{"type":"pair_response","ok":false,"error":"not_found"}`)) //nolint:errcheck // test refusal
		return
	}
	peer, _ := base64.StdEncoding.DecodeString(req.PeerPublicKey) //nolint:errcheck // a malformed key fails the derivation below
	secret, err := f.server.SharedSecret(peer)
	if err != nil {
		return
	}
	f.mu.Lock()
	f.secret = secret
	f.mu.Unlock()
	resp, _ := json.Marshal(map[string]any{ //nolint:errcheck // fixed test payload
		"type": "pair_response", "ok": true, "clientId": "client-1", "scopes": []string{"conversations:read"},
		"ourPublicKey": base64.StdEncoding.EncodeToString(f.server.Public),
		"relays":       []map[string]any{{"url": f.url(), "auth": map[string]any{"mode": "psk", "key": f.bearer}}},
	})
	conn.Write(ctx, websocket.MessageText, resp) //nolint:errcheck // test reply
}

func (f *fakeRelay) serveStudio(ctx context.Context, conn *websocket.Conn, secret []byte) {
	send := func(v any) {
		data, _ := json.Marshal(v)                             //nolint:errcheck // fixed test payload
		sealed, _ := SealFrame(data, secret)                   //nolint:errcheck // test sealing
		conn.Write(ctx, websocket.MessageText, []byte(sealed)) //nolint:errcheck // test reply
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		opened, _, err := OpenFrame(string(data), secret)
		if err != nil {
			f.t.Errorf("server could not open a client frame: %v", err)
			return
		}
		var msg map[string]any
		json.Unmarshal(opened, &msg) //nolint:errcheck // shape asserted below
		switch msg["type"] {
		case "studio_hello":
			f.mu.Lock()
			f.hello = msg
			f.mu.Unlock()
			send(map[string]any{"type": "studio_welcome", "protocolVersion": 1, "environmentId": "env-1", "label": "devbox", "platform": "darwin",
				"serverVersion": "0.2.0", "engineVersion": "1.90.0", "scopes": []string{"conversations:read"},
				"relays": []map[string]any{{"url": "wss://relay.example.org", "auth": map[string]any{"mode": "relay-oidc"}}}})
		case "studio_action":
			var value any
			switch msg["action"] {
			case "environment.server.info":
				value = map[string]any{"serverVersion": "0.2.0", "engineVersion": "1.90.0", "hostname": "devbox", "platform": "darwin", "arch": "x64",
					"bundle":           map[string]any{"root": "/r", "version": map[string]any{"server": "0.2.0", "engine": "1.89.0", "node": "v22"}},
					"engineMinVersion": "0.0.0", "engineMeetsMin": true, "runningConversations": 3, "hostApp": nil,
					"formats": []map[string]any{{"id": "transfer-archive", "owner": "server", "version": "3", "rule": "exact", "meaning": "m"}}}
			case "environment.devices":
				value = []map[string]any{
					{"clientId": "client-1", "label": "ion fleet on ops", "kind": "desktop", "pairedAt": 1, "lastSeen": 2, "connected": true, "connectedAt": 2, "admin": false, "self": true},
					{"clientId": "phone-1", "label": "iPhone", "kind": "mobile", "pairedAt": 1, "lastSeen": 2, "connected": true, "connectedAt": 2, "admin": false, "self": false},
					{"clientId": "desk-1", "label": "", "kind": "desktop", "pairedAt": 1, "lastSeen": 2, "connected": false, "connectedAt": nil, "admin": true, "self": false},
				}
			case "environment.systemMetrics.watch":
				value = map[string]any{"watching": false, "latest": map[string]any{"sampledAt": 5, "host": map[string]any{"cpuCount": 4, "memoryTotalBytes": 100, "memoryAvailableBytes": 40}, "processes": []map[string]any{{"cpuPercent": 7.5, "rssBytes": 10}}}}
			}
			send(map[string]any{"type": "studio_action_result", "id": msg["id"], "ok": true, "value": value})
		}
	}
}

func (f *fakeRelay) url() string { return strings.Replace(f.srv.URL, "http://", "ws://", 1) }

func TestPairOverRelay_ThenReadStatus(t *testing.T) {
	f := newFakeRelay(t, "psk-1")
	ctx := context.Background()
	req, kp, err := NewPairRequest(strings.Repeat("a", 32), "fleet", "device-1")
	if err != nil {
		t.Fatal(err)
	}
	p, err := PairOverRelay(ctx, PairingRelay{URL: f.url(), Channel: strings.Repeat("b", 32)}, "psk-1", req, kp)
	if err != nil {
		t.Fatalf("pair: %v", err)
	}
	if p.ClientID != "client-1" || len(p.Relays) != 1 || p.Relays[0].Auth.Key != "psk-1" {
		t.Fatalf("pairing = %+v", p)
	}
	bearer, err := RelayBearer(ctx, p.Relays[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	st, err := ReadStatus(ctx, p.Relays[0], bearer, p)
	if err != nil {
		t.Fatalf("read status: %v", err)
	}
	f.mu.Lock()
	hello := f.hello
	f.mu.Unlock()
	cred, _ := hello["credential"].(map[string]any) //nolint:errcheck // asserted below
	// The hello names this program, not the pairing: a pairing shared with
	// Studio must not displace Studio's own connection.
	helloID, _ := hello["clientId"].(string) //nolint:errcheck // asserted below
	if hello["view"] != "thin" || !strings.HasPrefix(helloID, "ion-fleet-") || cred["clientId"] != "client-1" || cred["kind"] != "paired" || cred["proof"] != RelayProof(p.SharedSecret) {
		t.Errorf("hello = %v", hello)
	}
	r := st.Report()
	if r.Hostname != "devbox" || r.Kind != "server" || !r.Engine.Running || !r.Engine.PendingRestart || r.Engine.InstalledVersion != "1.89.0" {
		t.Errorf("report = %+v", r)
	}
	if r.RunningConversations == nil || *r.RunningConversations != 3 || r.Metrics == nil || r.Metrics.IonCPUPercent != 7.5 {
		t.Errorf("running=%v metrics=%+v", r.RunningConversations, r.Metrics)
	}
	if f, ok := r.Format("server", "transfer-archive"); !ok || f.Running != "3" {
		t.Errorf("transfer = %+v", f)
	}
	if len(r.Relays) != 1 || r.Relays[0] != "wss://relay.example.org" {
		t.Errorf("relays = %v", r.Relays)
	}
	// The fleet's own pairing is not one of the host's devices.
	if paired, connected := studiostatus.DeviceCounts(r.Devices); paired != 2 || connected != 1 {
		t.Errorf("devices = %+v", r.Devices)
	}
	if got := studiostatus.DeviceSummary(r.Devices); got != "2 paired, 1 connected now: iPhone (connected), unnamed desktop" {
		t.Errorf("summary = %q", got)
	}
}

func TestPairOverRelay_RefusedCodeAndWrongKey(t *testing.T) {
	f := newFakeRelay(t, "psk-1")
	ctx := context.Background()
	req, kp, err := NewPairRequest(strings.Repeat("c", 32), "fleet", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := PairOverRelay(ctx, PairingRelay{URL: f.url(), Channel: strings.Repeat("b", 32)}, "psk-1", req, kp); err == nil || !strings.Contains(err.Error(), "not_found") {
		t.Errorf("an unknown code must be refused with the server's reason, got %v", err)
	}
	if _, err := PairOverRelay(ctx, PairingRelay{URL: f.url(), Channel: strings.Repeat("b", 32)}, "wrong", req, kp); err == nil || !strings.Contains(err.Error(), "401") {
		t.Errorf("a wrong relay key must be named, got %v", err)
	}
}

type fakeTokens struct {
	issuer string
	scopes []string
}

func (f *fakeTokens) Issuer(context.Context) (string, error) { return f.issuer, nil }
func (f *fakeTokens) Token(_ context.Context, scope, _ string) (string, error) {
	f.scopes = append(f.scopes, scope)
	return "token-for-" + scope, nil
}

func TestRelayBearer_RelayOIDC(t *testing.T) {
	f := newFakeRelay(t, "unused")
	ctx := context.Background()
	tokens := &fakeTokens{issuer: "https://issuer.example.org"}
	bearer, err := RelayBearer(ctx, Relay{URL: f.url(), Auth: RelayAuth{Mode: "relay-oidc", Issuer: "https://issuer.example.org/"}}, tokens)
	if err != nil || bearer != "token-for-api://relay-app/Relay.Access" {
		t.Fatalf("bearer = %q err = %v", bearer, err)
	}
	if _, err := RelayBearer(ctx, Relay{URL: f.url(), Auth: RelayAuth{Mode: "relay-oidc", Issuer: "https://other.example.org"}}, tokens); err == nil {
		t.Error("an operator from another tenant must be refused before the join")
	}
	if _, err := RelayBearer(ctx, Relay{URL: f.url(), Auth: RelayAuth{Mode: "relay-oidc"}}, &fakeTokens{}); err == nil {
		t.Error("a signed-out operator must be refused")
	}
}

func TestParsePairingLink(t *testing.T) {
	code, channel := strings.Repeat("0", 32), strings.Repeat("f", 32)
	l, err := ParsePairingLink("ion-studio://pair?code=" + code + "&url=http%3A%2F%2Fdevbox.local%3A7331%2F&env=devbox&relay=wss%3A%2F%2Frelay.example.org&channel=" + channel + "&relayKey=k")
	if err != nil {
		t.Fatal(err)
	}
	if l.Code != code || l.URL != "http://devbox.local:7331" || l.Label != "devbox" || l.Relay == nil || l.Relay.Channel != channel || l.Relay.Key != "k" {
		t.Errorf("link = %+v relay=%+v", l, l.Relay)
	}
	for _, bad := range []string{"https://example.org", "ion-studio://pair?code=zz&url=http://h", "ion-studio://pair?code=" + code} {
		if _, err := ParsePairingLink(bad); err == nil {
			t.Errorf("%q must not parse", bad)
		}
	}
}

func TestComposeOIDCScope(t *testing.T) {
	for _, c := range [][3]string{{"abc", "Relay.Access", "api://abc/Relay.Access"}, {"api://abc", "Relay.Access", "api://abc/Relay.Access"}, {"abc", "api://x/y", "api://x/y"}} {
		if got := ComposeOIDCScope(c[0], c[1]); got != c[2] {
			t.Errorf("ComposeOIDCScope(%q,%q) = %q, want %q", c[0], c[1], got, c[2])
		}
	}
}

func TestPairOverHTTP(t *testing.T) {
	server, err := GenerateKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req PairRequest
		if r.URL.Path != "/auth/pair" || json.NewDecoder(r.Body).Decode(&req) != nil || req.Type != "" {
			http.Error(w, `{"error":"bad"}`, http.StatusBadRequest)
			return
		}
		if req.Code != strings.Repeat("a", 32) {
			w.WriteHeader(http.StatusGone)
			w.Write([]byte(`{"error":"expired"}`)) //nolint:errcheck // test response
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"clientId": "c-http", "ourPublicKey": base64.StdEncoding.EncodeToString(server.Public), "scopes": []string{"conversations:read"}}) //nolint:errcheck // test response
	}))
	t.Cleanup(srv.Close)
	req, kp, err := NewPairRequest(strings.Repeat("a", 32), "fleet", "d")
	if err != nil {
		t.Fatal(err)
	}
	p, err := PairOverHTTP(context.Background(), srv.URL, req, kp)
	if err != nil || p.ClientID != "c-http" {
		t.Fatalf("pairing = %+v err = %v", p, err)
	}
	want, err := server.SharedSecret(kp.Public)
	if err != nil || string(want) != string(p.SharedSecret) {
		t.Error("both ends must derive the same secret")
	}
	req.Code = strings.Repeat("e", 32)
	if _, err := PairOverHTTP(context.Background(), srv.URL, req, kp); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Errorf("an expired link must say so, got %v", err)
	}
}
