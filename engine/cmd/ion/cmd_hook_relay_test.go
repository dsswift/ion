package main

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const relayAllow = `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}`

func TestRunHookRelay_PassesTheDecisionThrough(t *testing.T) {
	var gotBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		gotBody = string(raw)
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, relayAllow)
	}))
	defer srv.Close()

	var out, errOut bytes.Buffer
	code := runHookRelay(srv.URL, strings.NewReader(`{"tool_name":"Read"}`), &out, &errOut, srv.Client())
	if code != 0 {
		t.Fatalf("exit %d, stderr %q", code, errOut.String())
	}
	if gotBody != `{"tool_name":"Read"}` {
		t.Errorf("engine received %q", gotBody)
	}
	if out.String() != relayAllow {
		t.Errorf("stdout %q, want the engine's decision verbatim", out.String())
	}
}

// Every way of not getting a decision must exit with the one status the CLI
// treats as a refusal. Any other status lets the tool run.
func TestRunHookRelay_FailsClosed(t *testing.T) {
	down := httptest.NewServer(http.NotFoundHandler())
	downURL := down.URL
	down.Close()

	status := func(code int, body string) *httptest.Server {
		return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(code)
			io.WriteString(w, body)
		}))
	}
	forbidden := status(http.StatusForbidden, "unknown token")
	defer forbidden.Close()
	malformed := status(http.StatusOK, "not a decision")
	defer malformed.Close()
	empty := status(http.StatusOK, "")
	defer empty.Close()

	for name, url := range map[string]string{
		"engine unreachable": downURL,
		"non-200":            forbidden.URL,
		"malformed body":     malformed.URL,
		"empty body":         empty.URL,
	} {
		t.Run(name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			code := runHookRelay(url, strings.NewReader(`{"tool_name":"Write"}`), &out, &errOut, http.DefaultClient)
			if code != hookRelayBlockExit {
				t.Fatalf("exit %d, want %d (the only status the CLI treats as a refusal)", code, hookRelayBlockExit)
			}
			if out.Len() != 0 {
				t.Errorf("a refused call must print no decision, got %q", out.String())
			}
			if !strings.HasPrefix(errOut.String(), hookRelayUnreachable) {
				t.Errorf("stderr must lead with the model-facing reason, got %q", errOut.String())
			}
		})
	}
}
