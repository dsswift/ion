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
		if role != "ion" && role != "mobile" {
			http.Error(w, "role must be 'ion' or 'mobile'", http.StatusBadRequest)
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

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc123?role=ion"
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

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc123?role=ion"
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

	// Connect ion first (no peer, so no control message sent).
	ionConn := dialWS(t, server, "chan1", "ion", apiKey)

	// Connect mobile second. This triggers relay:peer-reconnected to ion.
	mobileConn := dialWS(t, server, "chan1", "mobile", apiKey)

	// Consume the peer-reconnected message that ion receives.
	ctrl := readExpected(t, ionConn, "ion-ctrl")
	if !strings.Contains(string(ctrl), "peer-reconnected") {
		t.Fatalf("expected peer-reconnected, got: %s", ctrl)
	}

	// Ion -> Mobile
	ionConn.WriteMessage(websocket.TextMessage, []byte(`{"msg":"hello from ion"}`))
	data := readExpected(t, mobileConn, "mobile")
	if string(data) != `{"msg":"hello from ion"}` {
		t.Errorf("mobile got: %s", data)
	}

	// Mobile -> Ion
	mobileConn.WriteMessage(websocket.TextMessage, []byte(`{"msg":"hello from mobile"}`))
	data = readExpected(t, ionConn, "ion")
	if string(data) != `{"msg":"hello from mobile"}` {
		t.Errorf("ion got: %s", data)
	}
}

func TestChannelIsolation(t *testing.T) {
	apiKey := "test-key-iso"
	server, _ := startTestRelay(t, apiKey)

	// Channel A: ion then mobile.
	ion1 := dialWS(t, server, "chan-a", "ion", apiKey)
	mobile1 := dialWS(t, server, "chan-a", "mobile", apiKey)

	// Consume ion1's peer-reconnected notification.
	readExpected(t, ion1, "ion1-ctrl")

	// Channel B: ion only, no peer.
	ion2 := dialWS(t, server, "chan-b", "ion", apiKey)

	// Send from ion1 on chan-a.
	ion1.WriteMessage(websocket.TextMessage, []byte("for-chan-a"))

	// Mobile1 on chan-a should receive it.
	data := readExpected(t, mobile1, "mobile1")
	if string(data) != "for-chan-a" {
		t.Errorf("mobile1 got: %s", data)
	}

	// ion2 on chan-b should NOT receive it (timeout expected).
	ion2.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
	_, _, err := ion2.ReadMessage()
	if err == nil {
		t.Error("ion2 should not have received a message from chan-a")
	}
}

func TestPeerDisconnectNotification(t *testing.T) {
	apiKey := "test-key-disc"
	server, _ := startTestRelay(t, apiKey)

	// Connect ion first, then mobile.
	ionConn := dialWS(t, server, "chan-disc", "ion", apiKey)
	mobileConn := dialWS(t, server, "chan-disc", "mobile", apiKey)

	// Consume the peer-reconnected notification on ion.
	ctrl := readExpected(t, ionConn, "ion-ctrl")
	if !strings.Contains(string(ctrl), "peer-reconnected") {
		t.Fatalf("expected peer-reconnected, got: %s", ctrl)
	}

	// Close mobile.
	mobileConn.Close()

	// Ion should get peer-disconnected.
	data := readExpected(t, ionConn, "ion-disconnect")
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
