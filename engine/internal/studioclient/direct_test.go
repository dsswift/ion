package studioclient

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeServer is an Ion server at its own address: the public endpoints, an
// issuer that runs the device sign-in, and a Studio wire that admits one
// bearer.
type fakeServer struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	polls  int
	forms  []url.Values
	hello  map[string]any
	header string
}

func newFakeServer(t *testing.T) *fakeServer {
	f := &fakeServer{t: t}
	mux := http.NewServeMux()
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	write := func(w http.ResponseWriter, v any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(v) //nolint:errcheck // test reply
	}
	mux.HandleFunc("/auth/config", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"oidc": map[string]any{"issuer": f.srv.URL + "/tenant/v2.0", "audience": "server-app", "scope": "Studio.Access", "clientId": "server-app"},
			"environmentId": "env-9", "label": "Orion Beta", "serverVersion": "0.1.0"})
	})
	mux.HandleFunc("/versionz", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"serverVersion": "0.1.0", "engineVersion": "1.85.3", "engineMinVersion": "0.0.0", "engineMeetsMin": true,
			"formats": []map[string]any{{"id": "transfer-archive", "owner": "server", "version": "3", "rule": "exact", "meaning": "m"}}})
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/tenant/v2.0/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		write(w, map[string]any{"device_authorization_endpoint": f.srv.URL + "/devicecode", "token_endpoint": f.srv.URL + "/token"})
	})
	mux.HandleFunc("/devicecode", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm() //nolint:errcheck // test form
		f.record(r.Form)
		write(w, map[string]any{"device_code": "dc-1", "message": "open the page and enter ABC", "interval": 0, "expires_in": 60})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm() //nolint:errcheck // test form
		f.record(r.Form)
		switch r.Form.Get("grant_type") {
		case "refresh_token":
			if r.Form.Get("refresh_token") != "rt-1" {
				w.WriteHeader(http.StatusBadRequest)
				write(w, map[string]any{"error": "invalid_grant", "error_description": "AADSTS70008: expired\nTrace"})
				return
			}
			write(w, map[string]any{"access_token": "at-1", "refresh_token": "rt-2"})
		default:
			f.mu.Lock()
			f.polls++
			first := f.polls == 1
			f.mu.Unlock()
			if first {
				w.WriteHeader(http.StatusBadRequest)
				write(w, map[string]any{"error": "authorization_pending"})
				return
			}
			write(w, map[string]any{"access_token": "at-0", "refresh_token": "rt-1"})
		}
	})
	mux.HandleFunc("/studio", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.header = r.Header.Get("Authorization")
		f.mu.Unlock()
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		f.serveStudio(r.Context(), conn)
	})
	return f
}

func (f *fakeServer) record(v url.Values) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.forms = append(f.forms, v)
}

func (f *fakeServer) serveStudio(ctx context.Context, conn *websocket.Conn) {
	send := func(v any) {
		data, _ := json.Marshal(v)                    //nolint:errcheck // fixed test payload
		conn.Write(ctx, websocket.MessageText, data) //nolint:errcheck // test reply
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var msg map[string]any
		if json.Unmarshal(data, &msg) != nil {
			f.t.Errorf("a direct session must send plain frames: %s", data)
			return
		}
		switch msg["type"] {
		case "studio_hello":
			f.mu.Lock()
			f.hello = msg
			f.mu.Unlock()
			cred, _ := msg["credential"].(map[string]any) //nolint:errcheck // checked below
			if cred["kind"] != "bearer" || cred["token"] != "at-1" {
				send(map[string]any{"type": "studio_refused", "reason": "unauthorized"})
				conn.Close(websocket.StatusPolicyViolation, "unauthorized") //nolint:errcheck // test teardown
				return
			}
			send(map[string]any{"type": "studio_welcome", "environmentId": "env-9", "label": "Orion Beta", "serverVersion": "0.1.0"})
		case "studio_action":
			var value any
			switch msg["action"] {
			case "environment.server.info":
				value = map[string]any{"serverVersion": "0.1.0", "engineVersion": "1.85.3", "hostname": "orion-0", "platform": "linux", "arch": "x64", "runningConversations": 2,
					"formats": []map[string]any{{"id": "transfer-archive", "owner": "server", "version": "3", "rule": "exact", "meaning": "m"}}}
			case "environment.devices":
				value = []map[string]any{{"clientId": "p", "label": "iPhone", "kind": "mobile", "connected": true}}
			}
			send(map[string]any{"type": "studio_action_result", "id": msg["id"], "ok": true, "value": value})
		}
	}
}

func TestReadPublic(t *testing.T) {
	f := newFakeServer(t)
	p, err := ReadPublic(context.Background(), f.srv.URL+"/")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Ready || p.Auth.Label != "Orion Beta" || p.Auth.OIDC == nil || p.Auth.OIDC.ClientID != "server-app" || p.Versionz.ServerVersion != "0.1.0" {
		t.Fatalf("public = %+v", p)
	}
	r := p.Report("load: not signed in")
	if !r.Engine.Running || r.Engine.Version != "1.85.3" || r.Components.StudioServer.Version != "0.1.0" || r.Kind != "server" || r.Problems[0] != "load: not signed in" {
		t.Errorf("report = %+v", r)
	}
	if fs, ok := r.Format("server", "transfer-archive"); !ok || fs.Running != "3" {
		t.Errorf("transfer = %+v", fs)
	}
}

// The fleet signs in with the server's own published client: a device code
// the person enters in a browser, polled until it is used, and a refresh
// token that mints each bearer and rotates.
func TestSignInWithDeviceCode_ThenRefresh(t *testing.T) {
	old := minPollInterval
	minPollInterval = 10 * time.Millisecond
	t.Cleanup(func() { minPollInterval = old })
	f := newFakeServer(t)
	p, err := ReadPublic(context.Background(), f.srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	var prompted string
	s, err := SignInWithDeviceCode(context.Background(), *p.Auth.OIDC, func(m string) { prompted = m })
	if err != nil {
		t.Fatal(err)
	}
	if prompted != "open the page and enter ABC" || s.RefreshToken != "rt-1" || s.TokenEndpoint != f.srv.URL+"/token" || s.Scope != "api://server-app/Studio.Access" {
		t.Fatalf("sign-in = %+v prompt %q", s, prompted)
	}
	f.mu.Lock()
	if got := f.forms[0].Get("scope"); got != "api://server-app/Studio.Access offline_access" {
		t.Errorf("device code scope = %q", got)
	}
	if f.polls != 2 {
		t.Errorf("a pending sign-in must be polled again: %d polls", f.polls)
	}
	f.mu.Unlock()

	bearer, rotated, err := s.Refresh(context.Background())
	if err != nil || bearer != "at-1" || rotated.RefreshToken != "rt-2" {
		t.Fatalf("refresh = %q %+v %v", bearer, rotated, err)
	}
	if _, _, err := rotated.Refresh(context.Background()); err == nil || !strings.Contains(err.Error(), "sign in again") || strings.Contains(err.Error(), "Trace") {
		t.Errorf("a spent refresh token must say to sign in again, in one line: %v", err)
	}
}

func TestReadDirectStatus_BearerOnTheUpgradeAndInTheHello(t *testing.T) {
	f := newFakeServer(t)
	st, err := ReadDirectStatus(context.Background(), f.srv.URL, "at-1")
	if err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	header, hello := f.header, f.hello
	f.mu.Unlock()
	if header != "Bearer at-1" || hello["view"] != "thin" || !strings.HasPrefix(hello["clientId"].(string), "ion-fleet-") { //nolint:errcheck // a missing clientId fails the prefix check
		t.Errorf("header %q hello %v", header, hello)
	}
	r := st.Report()
	if r.Hostname != "orion-0" || r.RunningConversations == nil || *r.RunningConversations != 2 || len(r.Devices) != 1 {
		t.Errorf("report = %+v", r)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := ReadDirectStatus(ctx, f.srv.URL, "wrong"); err == nil || !strings.Contains(err.Error(), "unauthorized") {
		t.Errorf("a refused bearer must say so: %v", err)
	}
	if _, err := studioURL("ftp://x"); err == nil {
		t.Error("only http and https addresses")
	}
	if u, _ := studioURL("https://orion.example.org/"); u != "wss://orion.example.org/studio" { //nolint:errcheck // asserted by the value
		t.Errorf("studio url = %s", u)
	}
}
