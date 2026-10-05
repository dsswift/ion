package server

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/types"
)

// provider_account_usage reports each installed CLI's signed-in account with
// the limits its CLI reads, keeps an account whose limits could not be read,
// and reports a signed-out CLI with no account.
func TestProviderAccountUsage(t *testing.T) {
	srv := newShortPathTestServer(t, &mockBackend{})
	srv.probes.SetProbeFunc(func(kind string) cliprobe.Probe {
		switch kind {
		case "claude-code":
			return cliprobe.Probe{Kind: kind, Installed: true, Authenticated: true, AuthMethod: "claude.ai", PlanType: "max", Email: "user@example.com", OrgID: "org-1", OrgName: "Example Org", Label: "Claude Max"}
		case "codex":
			return cliprobe.Probe{Kind: kind, Installed: true, Authenticated: true, AuthMethod: "chatgpt", Email: "dev@example.com"}
		case "grok":
			return cliprobe.Probe{Kind: kind, Installed: true}
		}
		return cliprobe.Probe{Kind: kind}
	})
	srv.probes.Refresh([]string{"claude-code", "codex", "grok", "cursor"})
	srv.usageFn = func(kind string) ([]types.ProviderUsageLimit, error) {
		switch kind {
		case "claude-code":
			return []types.ProviderUsageLimit{
				{Kind: types.UsageLimitSession, Percent: 16, ResetsAt: "2026-10-03T17:20:00Z"},
				{Kind: types.UsageLimitWeeklyModel, Label: "Example Model", Percent: 76},
			}, nil
		case "codex":
			return nil, errors.New("codex did not answer")
		}
		return nil, cliprobe.ErrNoUsage
	}

	conn := dialServer(t, srv)
	defer conn.Close()
	sendJSON(t, conn, map[string]any{"cmd": "provider_account_usage", "requestId": "u1"})
	lines := readLinesUntil(t, conn, 5*time.Second, func(l string) bool { return strings.Contains(l, `"cmd":"result"`) })
	result := findResult(t, lines)
	if result == nil || !result.OK {
		t.Fatalf("no ok result, lines: %v", lines)
	}
	raw, err := json.Marshal(result.Data)
	if err != nil {
		t.Fatal(err)
	}
	var data struct {
		Accounts []types.ProviderAccountUsage `json:"accounts"`
	}
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatalf("decode result data: %v", err)
	}
	byBackend := map[string]types.ProviderAccountUsage{}
	for _, a := range data.Accounts {
		byBackend[a.Backend] = a
	}
	claude := byBackend["claude-code"]
	if claude.Account == nil || claude.Account.Provider != "anthropic" || claude.Account.Email != "user@example.com" || claude.Account.OrgID != "org-1" {
		t.Fatalf("claude account = %+v", claude.Account)
	}
	if len(claude.Limits) != 2 || claude.Limits[1].Label != "Example Model" || claude.Limits[0].Percent != 16 {
		t.Fatalf("claude limits = %+v", claude.Limits)
	}
	codex := byBackend["codex"]
	if codex.Account == nil || codex.Error == "" || len(codex.Limits) != 0 {
		t.Fatalf("codex entry = %+v", codex)
	}
	grok, ok := byBackend["grok"]
	if !ok || grok.Account != nil {
		t.Fatalf("grok entry = %+v (present %v)", grok, ok)
	}
	if _, ok := byBackend["cursor"]; ok {
		t.Fatal("a CLI that is not installed was reported")
	}
}
