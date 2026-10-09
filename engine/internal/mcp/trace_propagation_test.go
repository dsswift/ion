package mcp

import (
	"context"
	"net/http"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	testTrace = "4bf92f3577b34da6a3ce929d0e0e4736"
	testSpan  = "00f067aa0ba902b7"
)

func traceCtx() context.Context {
	return utils.WithSpanID(utils.WithTraceID(context.Background(), testTrace), testSpan)
}

// A stdio server connected under a run starts with the run's TRACEPARENT;
// one connected outside a run inherits the plain environment.
func TestCommandEnvCarriesTraceparent(t *testing.T) {
	want := "TRACEPARENT=00-" + testTrace + "-" + testSpan + "-01"
	env := commandEnv(traceCtx(), types.McpServerConfig{Command: "srv", Env: map[string]string{"FOO": "bar"}})
	var sawTrace, sawFoo bool
	for _, kv := range env {
		sawTrace = sawTrace || kv == want
		sawFoo = sawFoo || kv == "FOO=bar"
	}
	if !sawTrace || !sawFoo {
		t.Fatalf("env missing TRACEPARENT or FOO: trace=%v foo=%v", sawTrace, sawFoo)
	}
	if env := commandEnv(context.Background(), types.McpServerConfig{Command: "srv"}); env != nil {
		t.Errorf("no trace and no Env must inherit (nil), got %d entries", len(env))
	}
	transport, err := commandTransport(traceCtx(), types.McpServerConfig{Command: "srv"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, kv := range transport.Command.Env {
		found = found || kv == want
	}
	if !found {
		t.Errorf("command transport env lacks %s", want)
	}
}

type captureRoundTripper struct{ req *http.Request }

func (c *captureRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	c.req = req
	return &http.Response{StatusCode: http.StatusOK, Body: http.NoBody, Request: req}, nil
}

// An MCP HTTP request made under a run's context carries that run's
// traceparent; one made outside a run does not.
func TestMCPHeaderRoundTripperTraceparent(t *testing.T) {
	capture := &captureRoundTripper{}
	rt := &mcpHeaderRoundTripper{base: capture, serverName: "srv", headers: map[string]string{"X-Static": "1"}}

	req, err := http.NewRequestWithContext(traceCtx(), http.MethodPost, "http://mcp.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rt.RoundTrip(req); err != nil {
		t.Fatal(err)
	}
	if got := capture.req.Header.Get("traceparent"); got != "00-"+testTrace+"-"+testSpan+"-01" {
		t.Errorf("traceparent = %q", got)
	}
	if capture.req.Header.Get("X-Static") != "1" {
		t.Errorf("static header dropped")
	}

	bare, err := http.NewRequest(http.MethodPost, "http://mcp.test/", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rt.RoundTrip(bare); err != nil {
		t.Fatal(err)
	}
	if got := capture.req.Header.Get("traceparent"); got != "" {
		t.Errorf("request outside a run sent traceparent %q", got)
	}
}
