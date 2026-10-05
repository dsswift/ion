//go:build !windows

package studioclient

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The local connection dials the data directory's socket, says hello with the
// local credential, and runs an action.
func TestConnectLocal_SaysHelloWithTheLocalCredential(t *testing.T) {
	// A Unix socket path has a short limit; the default temp dir on macOS is over it.
	dir, err := os.MkdirTemp("/tmp", "ion-local-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) }) //nolint:errcheck // test cleanup
	listener, err := net.Listen("unix", filepath.Join(dir, LocalSocketName))
	if err != nil {
		t.Fatal(err)
	}
	hellos := make(chan map[string]any, 1)
	actions := make(chan map[string]any, 1)
	mux := http.NewServeMux()
	mux.HandleFunc("/studio", func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow() //nolint:errcheck // test teardown
		send := func(v any) {
			data, _ := json.Marshal(v)                           //nolint:errcheck // fixed test payload
			conn.Write(r.Context(), websocket.MessageText, data) //nolint:errcheck // test reply
		}
		for {
			_, data, err := conn.Read(r.Context())
			if err != nil {
				return
			}
			var msg map[string]any
			if json.Unmarshal(data, &msg) != nil {
				continue
			}
			switch msg["type"] {
			case "studio_hello":
				hellos <- msg
				send(map[string]any{"type": "studio_welcome", "environmentId": "env-local", "label": "this machine", "scopes": []string{"admin"}})
			case "studio_action":
				actions <- msg
				send(map[string]any{"type": "studio_action_result", "id": msg["id"], "ok": true, "value": map[string]any{"accepted": true}})
			}
		}
	})
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go server.Serve(listener) //nolint:errcheck // ends with the listener
	t.Cleanup(func() { server.Close() }) //nolint:errcheck // test teardown

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	session, err := ConnectLocal(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	hello := <-hellos
	if cred, _ := hello["credential"].(map[string]any); cred["kind"] != "local" || hello["view"] != "thin" { //nolint:errcheck // a missing credential fails the comparison
		t.Errorf("hello = %v", hello)
	}
	if session.Welcome.EnvironmentID != "env-local" {
		t.Errorf("welcome = %+v", session.Welcome)
	}
	if _, err := session.Action(ctx, "fleet.deploy.report", map[string]any{"id": "d"}); err != nil {
		t.Fatal(err)
	}
	if action := <-actions; action["action"] != "fleet.deploy.report" {
		t.Errorf("action = %v", action)
	}
	if _, err := ConnectLocal(ctx, t.TempDir()); err == nil {
		t.Error("a data directory with no server must fail to connect")
	}
}
