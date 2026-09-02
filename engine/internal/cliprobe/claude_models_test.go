package cliprobe

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// The Anthropic /v1/models payload is richer than the OpenAI-style list the
// generic discovery path decodes. This is a trimmed copy of the real response
// for a subscription account, covering a brand-new model (claude-opus-5) that
// the embedded catalog does not carry — the exact case the stale catalog
// fallback hid from the picker.
const anthropicModelsPayload = `{
  "data": [
    {
      "type": "model",
      "id": "claude-opus-5",
      "display_name": "Claude Opus 5",
      "max_input_tokens": 1000000,
      "max_tokens": 128000,
      "capabilities": {
        "image_input": {"supported": true},
        "thinking": {
          "supported": true,
          "types": {"enabled": {"supported": false}, "adaptive": {"supported": true}}
        },
        "effort": {
          "supported": true,
          "low": {"supported": true},
          "medium": {"supported": true},
          "high": {"supported": true},
          "xhigh": {"supported": true},
          "max": {"supported": true}
        }
      }
    },
    {
      "type": "model",
      "id": "claude-haiku-4-5-20251001",
      "display_name": "Claude Haiku 4.5",
      "max_input_tokens": 200000,
      "max_tokens": 64000,
      "capabilities": {
        "image_input": {"supported": true},
        "thinking": {"supported": false}
      }
    }
  ],
  "has_more": false
}`

// withStubbedToken points readClaudeOAuthToken at a fixed, non-expired token and
// restores it after the test.
func withStubbedToken(t *testing.T, token string, expMs int64) {
	t.Helper()
	restore := readClaudeOAuthToken
	readClaudeOAuthToken = func() (string, int64, error) { return token, expMs, nil }
	t.Cleanup(func() { readClaudeOAuthToken = restore })
}

// withModelsServer stands up an httptest server serving the given body and
// points claudeModelsBaseURL at it.
func withModelsServer(t *testing.T, status int, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("authorization"); got != "Bearer test-oauth-token" {
			t.Errorf("authorization header = %q, want the OAuth bearer token", got)
		}
		if r.URL.Path != "/v1/models" {
			t.Errorf("path = %q, want /v1/models", r.URL.Path)
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	restore := claudeModelsBaseURL
	claudeModelsBaseURL = srv.URL
	t.Cleanup(func() {
		claudeModelsBaseURL = restore
		srv.Close()
	})
	return srv
}

// The live Anthropic list must be decoded into ModelEntry values with context
// window, output cap, and thinking/effort capabilities mapped from Anthropic's
// own field names — so a brand-new model absent from the embedded catalog still
// surfaces fully in the picker.
func TestFetchClaudeSubscriptionModels_MapsLivePayload(t *testing.T) {
	withStubbedToken(t, "test-oauth-token", time.Now().Add(time.Hour).UnixMilli())
	withModelsServer(t, 200, anthropicModelsPayload)

	models, err := fetchClaudeSubscriptionModels(context.Background())
	if err != nil {
		t.Fatalf("fetch failed: %v", err)
	}
	byID := make(map[string]bool)
	var opus struct {
		ctx, out         int
		images, thinking bool
		mode             string
		efforts          []string
		found            bool
	}
	for _, m := range models {
		byID[m.ID] = true
		if m.ProviderID != "anthropic" {
			t.Errorf("model %q ProviderID = %q, want anthropic", m.ID, m.ProviderID)
		}
		if m.ID == "claude-opus-5" {
			opus.ctx, opus.out = m.ContextWindow, m.MaxOutputTokens
			opus.images, opus.thinking = m.SupportsImages, m.SupportsThinking
			opus.mode, opus.efforts = m.ThinkingMode, m.ThinkingEfforts
			opus.found = true
		}
	}
	// The brand-new model the stale catalog hid.
	if !byID["claude-opus-5"] {
		t.Fatal("claude-opus-5 (a live model absent from the embedded catalog) missing from fetch")
	}
	if !opus.found {
		t.Fatal("claude-opus-5 entry not captured")
	}
	if opus.ctx != 1000000 {
		t.Errorf("claude-opus-5 ContextWindow = %d, want 1000000 (max_input_tokens)", opus.ctx)
	}
	if opus.out != 128000 {
		t.Errorf("claude-opus-5 MaxOutputTokens = %d, want 128000 (max_tokens)", opus.out)
	}
	if !opus.images || !opus.thinking {
		t.Errorf("claude-opus-5 capabilities images=%v thinking=%v, want both true", opus.images, opus.thinking)
	}
	if opus.mode != "adaptive" {
		t.Errorf("claude-opus-5 ThinkingMode = %q, want adaptive", opus.mode)
	}
	wantEfforts := []string{"low", "medium", "high", "xhigh", "max"}
	if len(opus.efforts) != len(wantEfforts) {
		t.Errorf("claude-opus-5 ThinkingEfforts = %v, want %v", opus.efforts, wantEfforts)
	} else {
		for i := range wantEfforts {
			if opus.efforts[i] != wantEfforts[i] {
				t.Errorf("claude-opus-5 ThinkingEfforts = %v, want %v", opus.efforts, wantEfforts)
				break
			}
		}
	}
}

// An expired token must not be sent — the CLI refreshes it on its own next use,
// and a re-probe picks up the fresh one. The fetch errors before any request.
func TestFetchClaudeSubscriptionModels_ExpiredToken(t *testing.T) {
	withStubbedToken(t, "test-oauth-token", time.Now().Add(-time.Minute).UnixMilli())
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	restore := claudeModelsBaseURL
	claudeModelsBaseURL = srv.URL
	t.Cleanup(func() { claudeModelsBaseURL = restore; srv.Close() })

	if _, err := fetchClaudeSubscriptionModels(context.Background()); err == nil {
		t.Fatal("expected an error for an expired token")
	}
	if called {
		t.Error("an expired token must not reach the network")
	}
}

// A non-200 response yields an error and no entries, so the caller falls open to
// the embedded catalog rather than blanking the picker.
func TestFetchClaudeSubscriptionModels_Non200(t *testing.T) {
	withStubbedToken(t, "test-oauth-token", time.Now().Add(time.Hour).UnixMilli())
	withModelsServer(t, 401, `{"type":"error"}`)

	models, err := fetchClaudeSubscriptionModels(context.Background())
	if err == nil {
		t.Fatal("expected an error for a 401 response")
	}
	if len(models) != 0 {
		t.Errorf("models = %+v, want none on error", models)
	}
}

// A missing credential errors before any request.
func TestFetchClaudeSubscriptionModels_MissingCredential(t *testing.T) {
	restore := readClaudeOAuthToken
	readClaudeOAuthToken = func() (string, int64, error) { return "", 0, errors.New("no credential") }
	t.Cleanup(func() { readClaudeOAuthToken = restore })

	if _, err := fetchClaudeSubscriptionModels(context.Background()); err == nil {
		t.Fatal("expected an error when the credential is missing")
	}
}

func TestParseClaudeCred(t *testing.T) {
	token, exp, ok := parseClaudeCred([]byte(`{"claudeAiOauth":{"accessToken":"tok","expiresAt":123}}`))
	if !ok || token != "tok" || exp != 123 {
		t.Fatalf("parseClaudeCred = (%q, %d, %v), want (tok, 123, true)", token, exp, ok)
	}
	if _, _, ok := parseClaudeCred([]byte(`{"claudeAiOauth":{"accessToken":""}}`)); ok {
		t.Error("empty access token must not parse as ok")
	}
	if _, _, ok := parseClaudeCred([]byte(`not json`)); ok {
		t.Error("malformed json must not parse as ok")
	}
}
