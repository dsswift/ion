package cliprobe

import (
	"context"
	"errors"
	"testing"
)

// The claude-code probe must report REAL auth state from
// `claude auth status --json`, never infer it from the binary existing on disk.
// Inferring it painted a green "ready" badge over a provider that could not
// serve a request, and let routing select a signed-out CLI.
//
// These payloads are the verified real output of Claude Code 2.1.206.
func TestProbeClaudeCodeAuthStatus(t *testing.T) {
	const signedIn = `{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  "email": "user@example.com",
  "orgId": "52b202f0-6b76-4800-adc3-b870c8572cc6",
  "orgName": "user@example.com's Organization",
  "subscriptionType": "max"
}`
	const signedOut = `{
  "loggedIn": false,
  "authMethod": "none",
  "apiProvider": "firstParty"
}`

	tests := []struct {
		name      string
		out       string
		runErr    error
		wantAuthd bool
		wantEmail string
		wantLabel string
		wantPlan  string
	}{
		{
			name:      "signed in reports authenticated with account details",
			out:       signedIn,
			wantAuthd: true,
			wantEmail: "user@example.com",
			wantLabel: "Claude Max",
			wantPlan:  "max",
		},
		{
			// Red on the unfixed probe, which returned Authenticated=true
			// whenever the binary existed. The CLI exits non-zero here while
			// still writing the payload, so a run error must not suppress it.
			name:      "signed out reports not authenticated",
			out:       signedOut,
			runErr:    errors.New("exit status 1"),
			wantAuthd: false,
		},
		{
			name:      "console auth reports the console label",
			out:       `{"loggedIn":true,"authMethod":"console","apiProvider":"firstParty","email":"dev@example.com"}`,
			wantAuthd: true,
			wantEmail: "dev@example.com",
			wantLabel: "Anthropic Console",
		},
		{
			name:      "subscription absent falls back to the bare label",
			out:       `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"unknown"}`,
			wantAuthd: true,
			wantLabel: "Claude",
			wantPlan:  "unknown",
		},
		{
			name:      "malformed json fails closed",
			out:       `{"loggedIn": tru`,
			wantAuthd: false,
		},
		{
			name:      "empty output fails closed",
			out:       "",
			runErr:    errors.New("exec: not started"),
			wantAuthd: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			restoreRunner := claudeAuthRunner
			claudeAuthRunner = func(context.Context, string) ([]byte, error) {
				return []byte(tt.out), tt.runErr
			}
			// Stub the binary lookup too, so these assertions run everywhere —
			// including CI runners with no claude installed. Skipping there would
			// leave the false-authentication regression unenforced exactly where
			// it matters.
			restoreFinder := claudeFinder
			claudeFinder = func() (string, error) { return "/usr/local/bin/claude", nil }
			defer func() {
				claudeAuthRunner = restoreRunner
				claudeFinder = restoreFinder
			}()

			p := probeClaudeCode()
			if p.Kind != "claude-code" {
				t.Errorf("Kind = %q, want claude-code", p.Kind)
			}
			if !p.Installed {
				t.Error("Installed = false, want true when the binary resolves")
			}
			if p.Authenticated != tt.wantAuthd {
				t.Errorf("Authenticated = %v, want %v", p.Authenticated, tt.wantAuthd)
			}
			if tt.wantEmail != "" && p.Email != tt.wantEmail {
				t.Errorf("Email = %q, want %q", p.Email, tt.wantEmail)
			}
			if tt.wantLabel != "" && p.Label != tt.wantLabel {
				t.Errorf("Label = %q, want %q", p.Label, tt.wantLabel)
			}
			if tt.wantPlan != "" && p.PlanType != tt.wantPlan {
				t.Errorf("PlanType = %q, want %q", p.PlanType, tt.wantPlan)
			}
			if !tt.wantAuthd && p.Label != "" {
				t.Errorf("Label = %q, want empty when signed out", p.Label)
			}
		})
	}
}

// A missing binary reports not-installed and not-authenticated, and never runs
// the auth command.
func TestProbeClaudeCodeNotInstalled(t *testing.T) {
	restoreRunner := claudeAuthRunner
	ran := false
	claudeAuthRunner = func(context.Context, string) ([]byte, error) {
		ran = true
		return nil, nil
	}
	restoreFinder := claudeFinder
	claudeFinder = func() (string, error) { return "", errors.New("claude CLI not found") }
	defer func() {
		claudeAuthRunner = restoreRunner
		claudeFinder = restoreFinder
	}()

	p := probeClaudeCode()
	if p.Installed {
		t.Error("Installed = true, want false when the binary does not resolve")
	}
	if p.Authenticated {
		t.Error("Authenticated = true, want false when the binary does not resolve")
	}
	if ran {
		t.Error("auth status was invoked despite the binary not resolving")
	}
}

// claudeLabel is the display-label mapping; pinned directly so the table above
// stays focused on auth state.
func TestClaudeLabel(t *testing.T) {
	tests := []struct {
		name string
		st   claudeAuthStatus
		want string
	}{
		{"signed out is empty", claudeAuthStatus{LoggedIn: false, SubscriptionType: "max"}, ""},
		{"max plan", claudeAuthStatus{LoggedIn: true, AuthMethod: "claude.ai", SubscriptionType: "max"}, "Claude Max"},
		{"pro plan", claudeAuthStatus{LoggedIn: true, AuthMethod: "claude.ai", SubscriptionType: "pro"}, "Claude Pro"},
		{"underscore plan is humanized", claudeAuthStatus{LoggedIn: true, AuthMethod: "claude.ai", SubscriptionType: "team_premium"}, "Claude Team Premium"},
		{"empty plan", claudeAuthStatus{LoggedIn: true, AuthMethod: "claude.ai"}, "Claude"},
		{"console", claudeAuthStatus{LoggedIn: true, AuthMethod: "console"}, "Anthropic Console"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := claudeLabel(tt.st); got != tt.want {
				t.Errorf("claudeLabel() = %q, want %q", got, tt.want)
			}
		})
	}
}

// planLabel is shared by the claude-code and codex label builders; it replaced
// two deprecated strings.Title calls, so its humanizing behavior is pinned here
// for both callers.
func TestPlanLabel(t *testing.T) {
	tests := []struct {
		name   string
		prefix string
		plan   string
		want   string
	}{
		{"empty plan is the bare prefix", "Claude", "", "Claude"},
		{"unknown plan is the bare prefix", "ChatGPT", "unknown", "ChatGPT"},
		{"single word is capitalized", "Claude", "max", "Claude Max"},
		{"underscores become spaced words", "ChatGPT", "team_premium", "ChatGPT Team Premium"},
		{"already-capitalized input is preserved", "Claude", "Pro", "Claude Pro"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := planLabel(tt.prefix, tt.plan); got != tt.want {
				t.Errorf("planLabel(%q, %q) = %q, want %q", tt.prefix, tt.plan, got, tt.want)
			}
		})
	}
}
