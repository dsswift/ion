package mcp

// http_streamable_test.go — regression pins for the two StreamableHTTP defects
// that made a conforming remote MCP server unusable.
//
// Both were found against the live https://api.mobbin.com/mcp after a
// successful OAuth login: the token was valid and the server was reachable, yet
// every session logged "mcp connect failed" and the server's tools never
// appeared.
//
//  1. Accept header. The transport advertised only application/json. The spec
//     requires both application/json and text/event-stream, because the server
//     chooses per request which to answer with. A server that enforces this
//     rejects the request outright — Mobbin answers 406 "Client must accept
//     both application/json and text/event-stream".
//  2. SSE-framed responses. Even with the header fixed, a reply framed as an
//     event stream failed json.Valid and was silently discarded, so the caller
//     waited on a response that had already arrived and the call died at its
//     timeout with no diagnostic.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// TestHTTPTransport_AcceptsBothMediaTypes pins the Accept header. It fails on
// the unfixed transport, which sent "application/json" alone.
func TestHTTPTransport_AcceptsBothMediaTypes(t *testing.T) {
	var gotAccept atomic.Value
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAccept.Store(r.Header.Get("Accept"))
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	tr, err := newHTTPTransport(server.URL, nil, nil)
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close() //nolint:errcheck // test cleanup

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}

	accept, _ := gotAccept.Load().(string) //nolint:errcheck // empty string fails the assertions below
	if !strings.Contains(accept, "application/json") {
		t.Errorf("Accept = %q, must advertise application/json", accept)
	}
	if !strings.Contains(accept, "text/event-stream") {
		t.Errorf("Accept = %q, must advertise text/event-stream; a spec-enforcing server answers 406 without it", accept)
	}
}

// mobbinStyleServer stands up an MCP server that behaves the way
// api.mobbin.com does: it REJECTS a request that does not accept both media
// types, and replies with SSE framing.
func mobbinStyleServer(t *testing.T) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		accept := r.Header.Get("Accept")
		if !strings.Contains(accept, "application/json") || !strings.Contains(accept, "text/event-stream") {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotAcceptable)
			if _, err := w.Write([]byte(`{"jsonrpc":"2.0","error":{"code":-32000,"message":"Not Acceptable: Client must accept both application/json and text/event-stream"},"id":null}`)); err != nil {
				t.Errorf("write 406: %v", err)
			}
			return
		}

		var req struct {
			ID     int64  `json:"id"`
			Method string `json:"method"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}

		result := map[string]any{}
		switch req.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": mcpProtocolVersion,
				"capabilities":    map[string]any{"tools": map[string]any{"listChanged": true}},
				"serverInfo":      map[string]any{"name": "mobbin", "version": "1.0.0"},
			}
		case "tools/list":
			result = map[string]any{"tools": []map[string]any{
				{"name": "search_screens", "description": "Search screens", "inputSchema": map[string]any{"type": "object"}},
				{"name": "search_flows", "description": "Search flows", "inputSchema": map[string]any{"type": "object"}},
				{"name": "search_sections", "description": "Search sections", "inputSchema": map[string]any{"type": "object"}},
			}}
		}

		payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": req.ID, "result": result})
		if err != nil {
			t.Errorf("marshal result: %v", err)
			return
		}

		// SSE framing, exactly as Mobbin replies.
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if _, err := fmt.Fprintf(w, "event: message\ndata: %s\n\n", payload); err != nil {
			t.Errorf("write sse frame: %v", err)
		}
	}))
}

// TestConnect_StreamableHTTPWithSSEFramedResponses is the end-to-end regression:
// a full Connect against a server that enforces the Accept header and replies
// with SSE framing. On the unfixed transport this fails with a 406; with only
// the header fixed it hangs and fails at the metadata timeout.
func TestConnect_StreamableHTTPWithSSEFramedResponses(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	resetStoresForTest()

	// Keep the failure mode fast if the fix regresses: without a short timeout a
	// dropped response would stall this test for the full 30s default.
	originalTimeout := DefaultMetadataTimeout
	DefaultMetadataTimeout = 5 * time.Second
	t.Cleanup(func() { DefaultMetadataTimeout = originalTimeout })

	server := mobbinStyleServer(t)
	defer server.Close()

	conn, err := Connect("mobbin", types.McpServerConfig{Type: "http", URL: server.URL})
	if err != nil {
		t.Fatalf("Connect against a spec-enforcing SSE-framing server: %v", err)
	}
	defer func() {
		if closeErr := conn.Close(); closeErr != nil {
			t.Errorf("close: %v", closeErr)
		}
	}()

	tools := conn.Tools()
	if len(tools) != 3 {
		t.Fatalf("discovered %d tools, want 3: %+v", len(tools), tools)
	}
	names := map[string]bool{}
	for _, tool := range tools {
		names[tool.Name] = true
	}
	for _, want := range []string{"search_screens", "search_flows", "search_sections"} {
		if !names[want] {
			t.Errorf("tool %q missing from discovery: %+v", want, tools)
		}
	}
}

// TestDecodeHTTPResponseFrames covers the body shapes the transport can receive.
func TestDecodeHTTPResponseFrames(t *testing.T) {
	cases := []struct {
		label       string
		contentType string
		body        string
		wantFrames  int
		wantFirstID string
	}{
		{
			label:       "plain json",
			contentType: "application/json",
			body:        `{"jsonrpc":"2.0","id":1,"result":{}}`,
			wantFrames:  1,
			wantFirstID: `"id":1`,
		},
		{
			label:       "sse single frame",
			contentType: "text/event-stream",
			body:        "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{}}\n\n",
			wantFrames:  1,
			wantFirstID: `"id":2`,
		},
		{
			label:       "sse multiple frames",
			contentType: "text/event-stream",
			body:        "data: {\"jsonrpc\":\"2.0\",\"id\":3}\n\ndata: {\"jsonrpc\":\"2.0\",\"id\":4}\n\n",
			wantFrames:  2,
			wantFirstID: `"id":3`,
		},
		{
			// Some servers use SSE framing under a generic content type, so the
			// header is a hint rather than a gate.
			label:       "sse framing with no content type",
			contentType: "",
			body:        "data: {\"jsonrpc\":\"2.0\",\"id\":5}\n\n",
			wantFrames:  1,
			wantFirstID: `"id":5`,
		},
		{
			label:       "sse with framing-only lines",
			contentType: "text/event-stream",
			body:        ": keepalive comment\nevent: message\nid: 99\nretry: 3000\ndata: {\"jsonrpc\":\"2.0\",\"id\":6}\n\n",
			wantFrames:  1,
			wantFirstID: `"id":6`,
		},
		{
			label:       "empty body",
			contentType: "application/json",
			body:        "",
			wantFrames:  0,
		},
		{
			label:       "html error page is not a frame",
			contentType: "text/html",
			body:        "<html><body>gateway error</body></html>",
			wantFrames:  0,
		},
		{
			label:       "sse frame carrying non-json is skipped",
			contentType: "text/event-stream",
			body:        "data: not json at all\n\n",
			wantFrames:  0,
		},
	}

	for _, tc := range cases {
		t.Run(tc.label, func(t *testing.T) {
			frames := decodeHTTPResponseFrames(tc.contentType, []byte(tc.body))
			if len(frames) != tc.wantFrames {
				t.Fatalf("decoded %d frames, want %d: %v", len(frames), tc.wantFrames, frames)
			}
			if tc.wantFirstID != "" && !strings.Contains(string(frames[0]), tc.wantFirstID) {
				t.Errorf("first frame = %s, want it to contain %s", frames[0], tc.wantFirstID)
			}
		})
	}
}

// TestDecodeHTTPResponseFrames_LargeSSEFrame pins that a payload beyond
// bufio.Scanner's default 64 KB token limit still decodes. A tools/list from a
// server with many tools exceeds it, and the default limit would silently drop
// the frame — the same class of failure this file exists to prevent.
func TestDecodeHTTPResponseFrames_LargeSSEFrame(t *testing.T) {
	big := strings.Repeat("x", 200*1024)
	payload, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"pad": big}})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	body := "event: message\ndata: " + string(payload) + "\n\n"

	frames := decodeHTTPResponseFrames("text/event-stream", []byte(body))
	if len(frames) != 1 {
		t.Fatalf("decoded %d frames, want 1; a >64KB data line must not be dropped", len(frames))
	}
	if len(frames[0]) < 200*1024 {
		t.Errorf("frame was truncated: %d bytes", len(frames[0]))
	}
}

// TestHTTPTransport_ReceivesEveryFrameFromOneResponse pins that a response
// carrying several frames delivers all of them, not just the first.
func TestHTTPTransport_ReceivesEveryFrameFromOneResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if _, err := fmt.Fprint(w,
			"data: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{}}\n\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/message\"}\n\n",
		); err != nil {
			t.Errorf("write frames: %v", err)
		}
	}))
	defer server.Close()

	tr, err := newHTTPTransport(server.URL, nil, nil)
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close() //nolint:errcheck // test cleanup

	if err := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`)); err != nil {
		t.Fatalf("Send: %v", err)
	}

	for i := 0; i < 2; i++ {
		got, receiveErr := tr.Receive()
		if receiveErr != nil {
			t.Fatalf("Receive %d: %v", i+1, receiveErr)
		}
		if !json.Valid(got) {
			t.Errorf("frame %d is not valid JSON: %s", i+1, got)
		}
	}
}

// TestHTTPTransport_406SurfacesServerMessage pins that a rejection carries the
// server's own explanation. This is what turned an opaque failure into a
// diagnosable one during the live investigation.
func TestHTTPTransport_406RedactsServerBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotAcceptable)
		if _, err := w.Write([]byte(`{"error":{"message":"Not Acceptable: Client must accept both application/json and text/event-stream"}}`)); err != nil {
			t.Errorf("write body: %v", err)
		}
	}))
	defer server.Close()

	tr, err := newHTTPTransport(server.URL, nil, nil)
	if err != nil {
		t.Fatalf("newHTTPTransport: %v", err)
	}
	defer tr.Close() //nolint:errcheck // test cleanup

	sendErr := tr.Send(json.RawMessage(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	if sendErr == nil {
		t.Fatal("expected an error for a 406 response")
	}
	if !strings.Contains(sendErr.Error(), "406") {
		t.Errorf("error should carry the status, got %q", sendErr)
	}
	if !strings.Contains(sendErr.Error(), "bodyBytes=102") {
		t.Errorf("error should carry only a safe body size, got %q", sendErr)
	}
	if strings.Contains(sendErr.Error(), "must accept both") {
		t.Errorf("error must not copy arbitrary response content, got %q", sendErr)
	}
}
