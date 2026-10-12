package cliprobe

import (
	"context"
	"errors"
	"testing"
	"time"
)

// The verified shape of the CLI's debug log around a response, trimmed, with
// the result envelope the turn prints after it.
const claudeOrgLog = `[log_1, request-id: "req_1"] post https://api.anthropic.com/v1/messages?beta=true succeeded with status 200 in 1106ms
[log_1] response start {
  url: "https://api.anthropic.com/v1/messages?beta=true",
  status: 200,
  headers: {
    "anthropic-organization-id": "0a1b2c3d-0000-4000-8000-000000000001",
    "anthropic-ratelimit-unified-5h-status": "allowed",
  },
}
{"type":"result","subtype":"success","is_error":false,"result":"ok"}`

func TestParseClaudeOrg(t *testing.T) {
	got, err := parseClaudeOrg([]byte(claudeOrgLog))
	if err != nil || got != "0a1b2c3d-0000-4000-8000-000000000001" {
		t.Fatalf("org = %q, err = %v", got, err)
	}
	if _, err := parseClaudeOrg([]byte(`{"type":"result","is_error":true,"result":"not logged in"}`)); err == nil {
		t.Fatal("a log with no organization header parsed")
	}
}

// stubClaudeOrg swaps the finder and the runner; the returned func reports
// how many turns ran and with which models.
func stubClaudeOrg(t *testing.T, run func(model string) ([]byte, error)) *[]string {
	t.Helper()
	prevFinder, prevRunner := claudeFinder, claudeOrgRunner
	t.Cleanup(func() { claudeFinder, claudeOrgRunner = prevFinder, prevRunner })
	claudeFinder = func() (string, error) { return "/bin/claude", nil }
	models := []string{}
	claudeOrgRunner = func(_ context.Context, _ string, model string) ([]byte, error) {
		models = append(models, model)
		return run(model)
	}
	return &models
}

func TestClaudeOrgResolverHoldsAnAnswer(t *testing.T) {
	models := stubClaudeOrg(t, func(string) ([]byte, error) { return []byte(claudeOrgLog), nil })
	now := time.Unix(1_800_000_000, 0)
	r := NewClaudeOrgResolver()
	r.now = func() time.Time { return now }

	if got := r.Resolve("oauth_token", ""); got != "0a1b2c3d-0000-4000-8000-000000000001" {
		t.Fatalf("org = %q", got)
	}
	now = now.Add(claudeOrgFresh - time.Minute)
	r.Resolve("oauth_token", "")
	if len(*models) != 1 || (*models)[0] != DefaultClaudeOrgModel {
		t.Fatalf("turns while the answer was fresh = %v", *models)
	}

	now = now.Add(2 * time.Minute)
	r.Resolve("oauth_token", "example-model")
	if len(*models) != 2 || (*models)[1] != "example-model" {
		t.Fatalf("turns after the answer went stale = %v", *models)
	}

	// A different auth method is a different login: read at once.
	r.Resolve("console", "")
	if len(*models) != 3 {
		t.Fatalf("turns after the auth method changed = %v", *models)
	}
}

func TestClaudeOrgResolverWaitsAfterAFailure(t *testing.T) {
	fail := true
	models := stubClaudeOrg(t, func(string) ([]byte, error) {
		if fail {
			return []byte("Invalid API key"), errors.New("exit status 1")
		}
		return []byte(claudeOrgLog), nil
	})
	now := time.Unix(1_800_000_000, 0)
	r := NewClaudeOrgResolver()
	r.now = func() time.Time { return now }

	if got := r.Resolve("oauth_token", ""); got != "" {
		t.Fatalf("org after a failed read = %q", got)
	}
	fail = false
	now = now.Add(claudeOrgRetry - time.Minute)
	if got := r.Resolve("oauth_token", ""); got != "" || len(*models) != 1 {
		t.Fatalf("read again inside the retry wait: org %q, turns %v", got, *models)
	}
	now = now.Add(2 * time.Minute)
	if got := r.Resolve("oauth_token", ""); got == "" || len(*models) != 2 {
		t.Fatalf("no read after the retry wait: org %q, turns %v", got, *models)
	}
}

// A turn that ends badly after its first response still names the organization.
func TestClaudeOrgReadSurvivesAFailedTurn(t *testing.T) {
	stubClaudeOrg(t, func(string) ([]byte, error) { return []byte(claudeOrgLog), errors.New("exit status 1") })
	if got := NewClaudeOrgResolver().Resolve("oauth_token", ""); got == "" {
		t.Fatal("the organization in the log was not used")
	}
}
