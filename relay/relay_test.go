package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func startTestRelay(t *testing.T, apiKey string) (*httptest.Server, *Hub) {
	t.Helper()
	hub := NewHub()
	auth := NewAuthMiddleware(apiKey)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /v1/channel/{channelId}", func(w http.ResponseWriter, r *http.Request) {
		if !auth.Validate(r) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		channelID := r.PathValue("channelId")
		role := r.URL.Query().Get("role")
		if role != "coda" && role != "mobile" {
			http.Error(w, "role must be 'coda' or 'mobile'", http.StatusBadRequest)
			return
		}
		hub.HandleWebSocket(w, r, channelID, role, nil)
	})

	server := httptest.NewServer(mux)
	t.Cleanup(func() {
		hub.CloseAll()
		server.Close()
	})
	return server, hub
}

func dialWS(t *testing.T, server *httptest.Server, channelID, role, apiKey string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/" + channelID + "?role=" + role
	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)
	conn, resp, err := websocket.DefaultDialer.Dial(url, header)
	if err != nil {
		t.Fatalf("dial failed: %v (resp: %v)", err, resp)
	}
	t.Cleanup(func() { conn.Close() })
	return conn
}

func TestHealthEndpoint(t *testing.T) {
	server, _ := startTestRelay(t, "test-key")
	resp, err := http.Get(server.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("expected 200, got %d", resp.StatusCode)
	}
}

func TestAuthRejectsInvalidKey(t *testing.T) {
	server, _ := startTestRelay(t, "correct-key")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc123?role=coda"
	header := http.Header{}
	header.Set("Authorization", "Bearer wrong-key")

	_, resp, err := websocket.DefaultDialer.Dial(url, header)
	if err == nil {
		t.Fatal("expected dial to fail with invalid key")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

func TestAuthRejectsMissingKey(t *testing.T) {
	server, _ := startTestRelay(t, "correct-key")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc123?role=coda"
	_, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if err == nil {
		t.Fatal("expected dial to fail without auth header")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
}

// readExpected reads one message with a timeout. Returns the data or fails the test.
func readExpected(t *testing.T, conn *websocket.Conn, label string) []byte {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := conn.ReadMessage()
	if err != nil {
		t.Fatalf("%s: read error: %v", label, err)
	}
	return data
}

func TestBidirectionalForwarding(t *testing.T) {
	apiKey := "test-key-fwd"
	server, _ := startTestRelay(t, apiKey)

	// Connect coda first (no peer, so no control message sent).
	codaConn := dialWS(t, server, "chan1", "coda", apiKey)

	// Connect mobile second. This triggers relay:peer-reconnected to coda.
	mobileConn := dialWS(t, server, "chan1", "mobile", apiKey)

	// Consume the peer-reconnected message that coda receives.
	ctrl := readExpected(t, codaConn, "coda-ctrl")
	if !strings.Contains(string(ctrl), "peer-reconnected") {
		t.Fatalf("expected peer-reconnected, got: %s", ctrl)
	}

	// CODA -> Mobile
	codaConn.WriteMessage(websocket.TextMessage, []byte(`{"msg":"hello from coda"}`))
	data := readExpected(t, mobileConn, "mobile")
	if string(data) != `{"msg":"hello from coda"}` {
		t.Errorf("mobile got: %s", data)
	}

	// Mobile -> CODA
	mobileConn.WriteMessage(websocket.TextMessage, []byte(`{"msg":"hello from mobile"}`))
	data = readExpected(t, codaConn, "coda")
	if string(data) != `{"msg":"hello from mobile"}` {
		t.Errorf("coda got: %s", data)
	}
}

func TestChannelIsolation(t *testing.T) {
	apiKey := "test-key-iso"
	server, _ := startTestRelay(t, apiKey)

	// Channel A: coda then mobile.
	coda1 := dialWS(t, server, "chan-a", "coda", apiKey)
	mobile1 := dialWS(t, server, "chan-a", "mobile", apiKey)

	// Consume coda1's peer-reconnected notification.
	readExpected(t, coda1, "coda1-ctrl")

	// Channel B: coda only, no peer.
	coda2 := dialWS(t, server, "chan-b", "coda", apiKey)

	// Send from coda1 on chan-a.
	coda1.WriteMessage(websocket.TextMessage, []byte("for-chan-a"))

	// Mobile1 on chan-a should receive it.
	data := readExpected(t, mobile1, "mobile1")
	if string(data) != "for-chan-a" {
		t.Errorf("mobile1 got: %s", data)
	}

	// Coda2 on chan-b should NOT receive it (timeout expected).
	coda2.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err := coda2.ReadMessage()
	if err == nil {
		t.Error("coda2 should not have received a message from chan-a")
	}
}

func TestPeerDisconnectNotification(t *testing.T) {
	apiKey := "test-key-disc"
	server, _ := startTestRelay(t, apiKey)

	// Connect coda first, then mobile.
	codaConn := dialWS(t, server, "chan-disc", "coda", apiKey)
	mobileConn := dialWS(t, server, "chan-disc", "mobile", apiKey)

	// Consume the peer-reconnected notification on coda.
	ctrl := readExpected(t, codaConn, "coda-ctrl")
	if !strings.Contains(string(ctrl), "peer-reconnected") {
		t.Fatalf("expected peer-reconnected, got: %s", ctrl)
	}

	// Close mobile.
	mobileConn.Close()

	// CODA should get peer-disconnected.
	data := readExpected(t, codaConn, "coda-disconnect")
	if !strings.Contains(string(data), "peer-disconnected") {
		t.Errorf("expected peer-disconnected, got: %s", data)
	}
}

func TestInvalidRoleRejected(t *testing.T) {
	server, _ := startTestRelay(t, "test-key")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc?role=invalid"
	header := http.Header{}
	header.Set("Authorization", "Bearer test-key")
	_, resp, err := websocket.DefaultDialer.Dial(url, header)
	if err == nil {
		t.Fatal("expected dial to fail with invalid role")
	}
	if resp != nil && resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}
