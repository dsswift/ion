package studioclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// pairedServer is a server's TCP listener for a paired client: it publishes
// a nonce, opens sealed frames with the secret of the client named in
// `?client=`, checks the hello's proof, and answers actions.
type pairedServer struct {
	srv    *httptest.Server
	secret []byte
	nonce  string

	mu      sync.Mutex
	hello   map[string]any
	client  string
	chunks  map[string][]byte
	ended   map[string]bool
	refuse  string
	events  []map[string]any
	actions []string
}

func newPairedServer(t *testing.T, secret []byte) *pairedServer {
	f := &pairedServer{secret: secret, nonce: base64.StdEncoding.EncodeToString([]byte("nonce-bytes-0123")), chunks: map[string][]byte{}, ended: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/auth/config", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"nonce": f.nonce, "environmentId": "env-1", "sealedTcp": true}) //nolint:errcheck // test reply
	})
	mux.HandleFunc("/studio", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // test teardown
		conn.SetReadLimit(16 << 20)
		f.mu.Lock()
		f.client = r.URL.Query().Get("client")
		f.mu.Unlock()
		ctx := r.Context()
		send := func(v any) {
			data, _ := json.Marshal(v) //nolint:errcheck // test frame
			sealed, _ := SealFrame(data, f.secret)
			conn.Write(ctx, websocket.MessageText, []byte(sealed)) //nolint:errcheck // test reply
		}
		for {
			_, raw, err := conn.Read(ctx)
			if err != nil {
				return
			}
			opened, isBinary, err := OpenFrame(string(raw), f.secret)
			if err != nil {
				continue
			}
			if isBinary {
				keyLen := int(opened[1])<<8 | int(opened[2])
				key := string(opened[3 : 3+keyLen])
				f.mu.Lock()
				if opened[0] == binaryFileEnd {
					f.ended[key] = true
				} else {
					f.chunks[key] = append(f.chunks[key], opened[3+keyLen:]...)
				}
				done := f.ended[key]
				f.mu.Unlock()
				if done {
					for _, e := range f.events {
						send(e)
					}
					send(map[string]any{"type": "studio_action_result", "id": "fleet-1", "ok": true, "value": map[string]any{"scheduled": true}})
				}
				continue
			}
			var m map[string]any
			json.Unmarshal(opened, &m) //nolint:errcheck // test frame
			switch m["type"] {
			case "studio_hello":
				f.mu.Lock()
				f.hello = m
				f.mu.Unlock()
				send(map[string]any{"type": "studio_welcome", "environmentId": "env-1", "label": "devbox", "serverVersion": "1.2.3"})
			case "studio_action":
				action, _ := m["action"].(string) //nolint:errcheck // test frame
				f.mu.Lock()
				f.actions = append(f.actions, action)
				refuse := f.refuse
				f.mu.Unlock()
				if action == "environment.server.installArtifact" {
					continue // answered once the file has arrived
				}
				if refuse != "" {
					send(map[string]any{"type": "studio_action_result", "id": m["id"], "ok": false, "refusal": map[string]any{"code": refuse, "message": "no"}})
					continue
				}
				send(map[string]any{"type": "studio_action_result", "id": m["id"], "ok": true, "value": map[string]any{"scheduled": true}})
			}
		}
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func TestConnectPaired(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, 32)
	f := newPairedServer(t, secret)
	p := Pairing{ClientID: "client-9", SharedSecret: secret}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	s, err := ConnectPaired(ctx, f.srv.URL, p)
	if err != nil {
		t.Fatalf("ConnectPaired: %v", err)
	}
	defer s.Close()
	if s.Welcome.EnvironmentID != "env-1" || s.Welcome.ServerVersion != "1.2.3" {
		t.Errorf("welcome = %+v", s.Welcome)
	}
	f.mu.Lock()
	hello, client := f.hello, f.client
	f.mu.Unlock()
	if client != "client-9" {
		t.Errorf("?client = %q, want the pairing's client id", client)
	}
	cred, _ := hello["credential"].(map[string]any) //nolint:errcheck // asserted below
	want, _ := AuthProof(f.nonce, secret)           //nolint:errcheck // a valid nonce
	helloID, _ := hello["clientId"].(string)        //nolint:errcheck // asserted below
	if cred["kind"] != "paired" || cred["clientId"] != "client-9" || cred["proof"] != want {
		t.Errorf("credential = %v", cred)
	}
	if !strings.HasPrefix(helloID, "ion-fleet-") || helloID == "client-9" {
		t.Errorf("hello clientId = %q, want this program's own id", helloID)
	}

	if _, err := s.Action(ctx, "environment.server.restart"); err != nil {
		t.Errorf("action: %v", err)
	}
	f.mu.Lock()
	f.refuse = "needs_sudo"
	f.mu.Unlock()
	_, err = s.Action(ctx, "environment.server.restart")
	var actionErr *ActionError
	if !errors.As(err, &actionErr) || !actionErr.Refused || actionErr.Code != "needs_sudo" {
		t.Errorf("refusal = %v", err)
	}
}

func TestConnectPairedWrongSecret(t *testing.T) {
	f := newPairedServer(t, bytes.Repeat([]byte{7}, 32))
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	if _, err := ConnectPaired(ctx, f.srv.URL, Pairing{ClientID: "client-9", SharedSecret: bytes.Repeat([]byte{8}, 32)}); err == nil {
		t.Fatal("a session opened with the wrong secret")
	}
}

// A file goes up as sealed FILE_CHUNK frames and an end marker, while the
// action that asked for it waits; events that arrive first reach the caller.
func TestSendFile(t *testing.T) {
	secret := bytes.Repeat([]byte{7}, 32)
	f := newPairedServer(t, secret)
	f.events = []map[string]any{{"type": "studio_event", "channel": "ion:host-install-progress", "payload": map[string]any{"stage": "requested"}}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s, err := ConnectPaired(ctx, f.srv.URL, Pairing{ClientID: "client-9", SharedSecret: secret})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	build := bytes.Repeat([]byte("build!"), 100_000) // more than two chunks
	id, err := s.StartAction(ctx, "environment.server.installArtifact", map[string]any{"transferId": "t-1", "totalBytes": len(build)})
	if err != nil {
		t.Fatal(err)
	}
	if err := s.SendFile(ctx, "t-1", bytes.NewReader(build)); err != nil {
		t.Fatalf("SendFile: %v", err)
	}
	var seen []string
	if _, err := s.WaitResult(ctx, "environment.server.installArtifact", id, func(e Event) { seen = append(seen, e.Channel) }); err != nil {
		t.Fatalf("WaitResult: %v", err)
	}
	f.mu.Lock()
	got, ended := f.chunks["t-1"], f.ended["t-1"]
	f.mu.Unlock()
	if !ended || !bytes.Equal(got, build) {
		t.Errorf("server received %d bytes (ended %v), want %d", len(got), ended, len(build))
	}
	if len(seen) != 1 || seen[0] != "ion:host-install-progress" {
		t.Errorf("events seen = %v", seen)
	}
}
