package mcp

// mcp_token_test.go — behavior pins for operator-token forwarding and the
// SSE header fix.
//
// Test matrix:
//  1. HTTP Send stamps Authorization from the userToken resolver, and
//     re-resolves on every request (rotation between sends is honored).
//  2. HTTP Send without a resolver leaves headers purely static (opt-in
//     contract).
//  3. The forwarded token overrides a static Authorization header.
//  4. SSE transport delivers configured static headers on BOTH the event
//     stream GET and the message POST (regression: SSE previously dropped
//     all headers).
//  5. SSE Send stamps the forwarded operator token.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestHTTPTransport_ForwardsUserTokenPerRequest(t *testing.T) {
	var gotAuth atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	var counter atomic.Int64
	tr, err := newHTTPTransport(server.URL, map[string]string{"X-Static": "s"}, func() (string, error) {
		return fmt.Sprintf("tok-%d", counter.Add(1)), nil
	})
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close()

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","method":"x"}`)); err != nil {
		t.Fatalf("Send 1: %v", err)
	}
	if gotAuth.Load() != "Bearer tok-1" {
		t.Errorf("first send Authorization = %q", gotAuth.Load())
	}

	// Second send must re-resolve: a rotated token reaches the wire.
	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","method":"y"}`)); err != nil {
		t.Fatalf("Send 2: %v", err)
	}
	if gotAuth.Load() != "Bearer tok-2" {
		t.Errorf("second send Authorization = %q; token must be resolved per request", gotAuth.Load())
	}
}

func TestHTTPTransport_NoResolverKeepsStaticHeadersOnly(t *testing.T) {
	var gotAuth, gotStatic atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		gotStatic.Store(r.Header.Get("X-Static"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	tr, err := newHTTPTransport(server.URL, map[string]string{"X-Static": "s", "Authorization": "Bearer static-token"}, nil)
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close()

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","method":"x"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotStatic.Load() != "s" {
		t.Errorf("X-Static = %q", gotStatic.Load())
	}
	if gotAuth.Load() != "Bearer static-token" {
		t.Errorf("static Authorization = %q; must pass through untouched without forwarding", gotAuth.Load())
	}
}

func TestHTTPTransport_ForwardedTokenOverridesStaticAuthorization(t *testing.T) {
	var gotAuth atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth.Store(r.Header.Get("Authorization"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	tr, err := newHTTPTransport(server.URL, map[string]string{"Authorization": "Bearer stale-static"}, func() (string, error) {
		return "fresh-operator", nil
	})
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close()

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","method":"x"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if gotAuth.Load() != "Bearer fresh-operator" {
		t.Errorf("Authorization = %q; forwarded operator token must win over static", gotAuth.Load())
	}
}

func TestSSETransport_AppliesHeadersToStreamAndSend(t *testing.T) {
	var streamAuth, sendAuth, sendStatic atomic.Value
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// The event-stream GET.
		streamAuth.Store(r.Header.Get("X-Static"))
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("/message", func(w http.ResponseWriter, r *http.Request) {
		sendAuth.Store(r.Header.Get("Authorization"))
		sendStatic.Store(r.Header.Get("X-Static"))
		w.WriteHeader(http.StatusOK)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	tr, err := newSSETransport(
		types.McpServerConfig{Type: "sse", URL: server.URL},
		map[string]string{"X-Static": "s"},
		func() (string, error) { return "op-token", nil },
	)
	if err != nil {
		t.Fatalf("newSSETransport: %v", err)
	}
	defer tr.Close()

	// Give the stream reader a moment to issue its GET.
	deadline := time.Now().Add(2 * time.Second)
	for streamAuth.Load() == nil && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if streamAuth.Load() != "s" {
		t.Errorf("event-stream GET X-Static = %v; SSE previously dropped all configured headers", streamAuth.Load())
	}

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","method":"x"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}
	if sendStatic.Load() != "s" {
		t.Errorf("message POST X-Static = %v", sendStatic.Load())
	}
	if sendAuth.Load() != "Bearer op-token" {
		t.Errorf("message POST Authorization = %v; forwarded operator token missing", sendAuth.Load())
	}
}
