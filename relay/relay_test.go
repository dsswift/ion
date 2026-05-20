package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer " + apiKey},
		},
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

// readExpected reads one message with a timeout. Returns the data or fails the test.
func readExpected(t *testing.T, conn *websocket.Conn, label string) []byte {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatalf("%s: read error: %v", label, err)
	}
	return data
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer wrong-key"},
		},
	})
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
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, url, nil)
	if err == nil {
		t.Fatal("expected dial to fail without auth header")
	}
	if resp != nil && resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", resp.StatusCode)
	}
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
	ctx := context.Background()
	ionConn.Write(ctx, websocket.MessageText, []byte(`{"msg":"hello from ion"}`))
	data := readExpected(t, mobileConn, "mobile")
	if string(data) != `{"msg":"hello from ion"}` {
		t.Errorf("mobile got: %s", data)
	}

	// Mobile -> Ion
	mobileConn.Write(ctx, websocket.MessageText, []byte(`{"msg":"hello from mobile"}`))
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
	ctx := context.Background()
	ion1.Write(ctx, websocket.MessageText, []byte("for-chan-a"))

	// Mobile1 on chan-a should receive it.
	data := readExpected(t, mobile1, "mobile1")
	if string(data) != "for-chan-a" {
		t.Errorf("mobile1 got: %s", data)
	}

	// ion2 on chan-b should NOT receive it (timeout expected).
	readCtx, readCancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer readCancel()
	_, _, err := ion2.Read(readCtx)
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
	mobileConn.Close(websocket.StatusNormalClosure, "bye")

	// Ion should get peer-disconnected.
	data := readExpected(t, ionConn, "ion-disconnect")
	if !strings.Contains(string(data), "peer-disconnected") {
		t.Errorf("expected peer-disconnected, got: %s", data)
	}
}

func TestInvalidRoleRejected(t *testing.T) {
	server, _ := startTestRelay(t, "test-key")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc?role=invalid"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer test-key"},
		},
	})
	if err == nil {
		t.Fatal("expected dial to fail with invalid role")
	}
	if resp != nil && resp.StatusCode != http.StatusBadRequest {
		t.Errorf("expected 400, got %d", resp.StatusCode)
	}
}

// --- New tests for migration coverage ---

func TestOriginRejected(t *testing.T) {
	server, _ := startTestRelay(t, "test-key")

	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/v1/channel/abc?role=ion"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	_, resp, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": []string{"Bearer test-key"},
			"Origin":        []string{"http://evil.com"},
		},
	})
	if err == nil {
		t.Fatal("expected dial to fail when Origin header is present")
	}
	if resp != nil && resp.StatusCode != http.StatusForbidden {
		t.Errorf("expected 403, got %d", resp.StatusCode)
	}
}

func TestOriginAbsentAllowed(t *testing.T) {
	server, _ := startTestRelay(t, "test-key")

	// dialWS does not set Origin (simulating native client).
	conn := dialWS(t, server, "origin-ok", "ion", "test-key")

	// Verify the connection works by writing and checking no error.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := conn.Write(ctx, websocket.MessageText, []byte(`{"ping":true}`))
	if err != nil {
		t.Fatalf("write failed on connection without Origin: %v", err)
	}
}

func TestRoleReconnectionReplacesPrevious(t *testing.T) {
	apiKey := "test-key-reconn"
	server, _ := startTestRelay(t, apiKey)

	// Connect first ion.
	ion1 := dialWS(t, server, "chan-reconn", "ion", apiKey)

	// Connect mobile so we can test forwarding.
	mobile := dialWS(t, server, "chan-reconn", "mobile", apiKey)

	// Consume ion1's peer-reconnected.
	readExpected(t, ion1, "ion1-ctrl")

	// Connect second ion (same channel). This should close ion1.
	ion2 := dialWS(t, server, "chan-reconn", "ion", apiKey)

	// ion1 should be closed — read should fail.
	readCtx, readCancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer readCancel()
	_, _, err := ion1.Read(readCtx)
	if err == nil {
		t.Error("expected ion1 read to fail after replacement")
	}

	// Wait briefly for the relay to process all control messages before sending.
	time.Sleep(200 * time.Millisecond)

	// Send from ion2 to mobile.
	ctx := context.Background()
	ion2.Write(ctx, websocket.MessageText, []byte("from-ion2"))

	// Read all pending messages from mobile, looking for "from-ion2".
	// Mobile may receive control messages (peer-disconnected, peer-reconnected)
	// before the forwarded message. Read them all.
	found := false
	for i := 0; i < 5; i++ {
		msgCtx, msgCancel := context.WithTimeout(context.Background(), 2*time.Second)
		_, data, readErr := mobile.Read(msgCtx)
		msgCancel()
		if readErr != nil {
			t.Fatalf("mobile read %d failed: %v", i, readErr)
		}
		if string(data) == "from-ion2" {
			found = true
			break
		}
		// Must be a control message; continue.
		if !strings.Contains(string(data), "relay:") {
			t.Fatalf("unexpected non-control message: %s", data)
		}
	}
	if !found {
		t.Error("mobile never received 'from-ion2'")
	}
}

func TestChannelCleanupAfterBothDisconnect(t *testing.T) {
	apiKey := "test-key-cleanup"
	server, hub := startTestRelay(t, apiKey)

	ion := dialWS(t, server, "chan-cleanup", "ion", apiKey)
	mobile := dialWS(t, server, "chan-cleanup", "mobile", apiKey)

	// Consume peer-reconnected on ion.
	readExpected(t, ion, "ion-ctrl")

	if hub.ChannelCount() != 1 {
		t.Fatalf("expected 1 channel, got %d", hub.ChannelCount())
	}

	// Close both sides.
	ion.Close(websocket.StatusNormalClosure, "bye")
	mobile.Close(websocket.StatusNormalClosure, "bye")

	// Wait for the relay goroutines to process the disconnects.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.ChannelCount() == 0 {
			return // success
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected 0 channels after both disconnect, got %d", hub.ChannelCount())
}

func TestConcurrentWrites(t *testing.T) {
	apiKey := "test-key-concurrent"
	server, _ := startTestRelay(t, apiKey)

	ion := dialWS(t, server, "chan-conc", "ion", apiKey)
	mobile := dialWS(t, server, "chan-conc", "mobile", apiKey)

	// Consume peer-reconnected on ion.
	readExpected(t, ion, "ion-ctrl")

	const n = 50
	var wg sync.WaitGroup
	wg.Add(n)

	// Spawn N goroutines each sending a message from ion.
	for i := range n {
		go func(idx int) {
			defer wg.Done()
			msg := fmt.Sprintf(`{"idx":%d}`, idx)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := ion.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
				t.Errorf("concurrent write %d failed: %v", idx, err)
			}
		}(i)
	}
	wg.Wait()

	// Read all N messages on mobile.
	received := 0
	for received < n {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_, _, err := mobile.Read(ctx)
		cancel()
		if err != nil {
			t.Fatalf("mobile read failed after %d messages: %v", received, err)
		}
		received++
	}
	if received != n {
		t.Errorf("expected %d messages, got %d", n, received)
	}
}

func TestBinaryMessageForwarding(t *testing.T) {
	apiKey := "test-key-binary"
	server, _ := startTestRelay(t, apiKey)

	ion := dialWS(t, server, "chan-bin", "ion", apiKey)
	mobile := dialWS(t, server, "chan-bin", "mobile", apiKey)

	// Consume peer-reconnected on ion.
	readExpected(t, ion, "ion-ctrl")

	// Send binary data from ion.
	binaryData := []byte{0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD}
	ctx := context.Background()
	if err := ion.Write(ctx, websocket.MessageBinary, binaryData); err != nil {
		t.Fatalf("binary write failed: %v", err)
	}

	// Mobile should receive it as binary.
	readCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	msgType, data, err := mobile.Read(readCtx)
	if err != nil {
		t.Fatalf("mobile read failed: %v", err)
	}
	if msgType != websocket.MessageBinary {
		t.Errorf("expected MessageBinary, got %v", msgType)
	}
	if string(data) != string(binaryData) {
		t.Errorf("binary data mismatch: got %v, want %v", data, binaryData)
	}
}

func TestLargeMessageForwarding(t *testing.T) {
	apiKey := "test-key-large"
	server, _ := startTestRelay(t, apiKey)

	ion := dialWS(t, server, "chan-large", "ion", apiKey)
	mobile := dialWS(t, server, "chan-large", "mobile", apiKey)

	// Increase client-side read limit to match the server's 12MB limit.
	mobile.SetReadLimit(12 * 1024 * 1024)

	// Consume peer-reconnected on ion.
	readExpected(t, ion, "ion-ctrl")

	// Send a message larger than the old 1MB limit.
	largeMsg := make([]byte, 2*1024*1024) // 2MB
	for i := range largeMsg {
		largeMsg[i] = byte(i % 256)
	}

	ctx := context.Background()
	if err := ion.Write(ctx, websocket.MessageBinary, largeMsg); err != nil {
		t.Fatalf("large write failed: %v", err)
	}

	readCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, data, err := mobile.Read(readCtx)
	if err != nil {
		t.Fatalf("mobile read failed: %v", err)
	}
	if len(data) != len(largeMsg) {
		t.Errorf("large message size mismatch: got %d, want %d", len(data), len(largeMsg))
	}
	// Spot-check a few bytes.
	for _, idx := range []int{0, 1000, 1048575, 1048576, len(largeMsg) - 1} {
		if data[idx] != largeMsg[idx] {
			t.Errorf("byte mismatch at index %d: got %d, want %d", idx, data[idx], largeMsg[idx])
		}
	}
}

func TestCompressionNegotiation(t *testing.T) {
	apiKey := "test-key-compress"
	server, _ := startTestRelay(t, apiKey)

	// dialWS enables CompressionContextTakeover. If negotiation fails or
	// corrupts data, this test will catch it.
	ion := dialWS(t, server, "chan-compress", "ion", apiKey)
	mobile := dialWS(t, server, "chan-compress", "mobile", apiKey)

	// Consume peer-reconnected on ion.
	readExpected(t, ion, "ion-ctrl")

	// Send a highly compressible message (repetitive JSON keys).
	msg := `{"event":"streaming","data":"` + strings.Repeat("abcdef1234", 500) + `"}`

	ctx := context.Background()
	if err := ion.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
		t.Fatalf("compressed write failed: %v", err)
	}

	data := readExpected(t, mobile, "mobile-compressed")
	if string(data) != msg {
		t.Errorf("compressed message mismatch: got %d bytes, want %d bytes", len(data), len(msg))
	}
}
