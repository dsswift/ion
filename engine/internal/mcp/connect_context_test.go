package mcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestConnectContextCancelAbandonsHandshake pins that cancelling the caller's
// context ends a handshake the server never answers, well before
// DefaultMetadataTimeout.
func TestConnectContextCancelAbandonsHandshake(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	hit := make(chan struct{}, 1)
	abandoned := make(chan struct{}, 4)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Go notices a client disconnect only once the body has been read.
		io.Copy(io.Discard, r.Body) //nolint:errcheck // drained only to arm disconnect detection
		select {
		case hit <- struct{}{}:
		default:
		}
		select {
		case <-r.Context().Done():
			select {
			case abandoned <- struct{}{}:
			default:
			}
		case <-time.After(20 * time.Second):
		}
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		<-hit
		cancel()
	}()

	start := time.Now()
	conn, err := ConnectContext(ctx, "silent", types.McpServerConfig{Type: "http", URL: server.URL}, ConnectionOptions{})
	if err == nil {
		conn.Close() //nolint:errcheck // unexpected success; the assertion below fails the test
		t.Fatal("Connect succeeded against a server that never answers")
	}
	if took := time.Since(start); took > 5*time.Second {
		t.Fatalf("cancelled handshake took %v to end; cancellation was ignored", took)
	}
	select {
	case <-abandoned:
	case <-time.After(3 * time.Second):
		t.Fatal("the abandoned handshake left its request open")
	}
}
