package server

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/cliprobe"
	"github.com/dsswift/ion/engine/internal/types"
)

// tokenLoginServer is a server whose claude-code CLI is signed in by a
// long-lived token: authenticated, with no email and no organization.
func tokenLoginServer(t *testing.T, orgID string) (*Server, *[]string) {
	t.Helper()
	srv := newShortPathTestServer(t, &mockBackend{})
	srv.probes.SetProbeFunc(func(kind string) cliprobe.Probe {
		if kind == "claude-code" {
			return cliprobe.Probe{Kind: kind, Installed: true, Authenticated: true, AuthMethod: "oauth_token", Label: "Claude"}
		}
		return cliprobe.Probe{Kind: kind}
	})
	srv.usageFn = func(string) ([]types.ProviderUsageLimit, error) { return []types.ProviderUsageLimit{}, nil }
	models := []string{}
	srv.orgFn = func(authMethod, model string) string {
		if authMethod != "oauth_token" {
			t.Fatalf("organization read for auth method %q", authMethod)
		}
		models = append(models, model)
		return orgID
	}
	return srv, &models
}

func claudeAccount(t *testing.T, accounts []types.ProviderAccountUsage) *types.ProviderAccount {
	t.Helper()
	for _, a := range accounts {
		if a.Backend == "claude-code" {
			if a.Account == nil {
				t.Fatal("claude-code reported no account")
			}
			return a.Account
		}
	}
	t.Fatal("claude-code not reported")
	return nil
}

// A login that names no organization gets the one the CLI's own turn showed.
func TestProviderAccountUsageResolvesATokenLoginOrganization(t *testing.T) {
	srv, models := tokenLoginServer(t, "org-from-cli")
	got := claudeAccount(t, srv.readProviderAccountUsage())
	if got.OrgID != "org-from-cli" || got.Email != "" || got.AuthMethod != "oauth_token" {
		t.Fatalf("account = %+v", got)
	}
	if len(*models) != 1 || (*models)[0] != "" {
		t.Fatalf("organization reads = %v", *models)
	}
}

func TestProviderAccountUsageOrganizationReadFollowsConfig(t *testing.T) {
	srv, models := tokenLoginServer(t, "org-from-cli")
	srv.config = &types.EngineRuntimeConfig{Providers: map[string]types.ProviderConfig{
		"anthropic": {AccountOrgRead: &types.AccountOrgReadConfig{Model: "example-model"}},
	}}
	claudeAccount(t, srv.readProviderAccountUsage())
	if len(*models) != 1 || (*models)[0] != "example-model" {
		t.Fatalf("organization reads with a configured model = %v", *models)
	}

	off := false
	srv.config.Providers["anthropic"] = types.ProviderConfig{AccountOrgRead: &types.AccountOrgReadConfig{Enabled: &off}}
	got := claudeAccount(t, srv.readProviderAccountUsage())
	if got.OrgID != "" || len(*models) != 1 {
		t.Fatalf("read ran while turned off: account %+v, reads %v", got, *models)
	}
}

// A login whose auth status names its organization is never asked again.
func TestProviderAccountUsageSkipsOrganizationReadWhenNamed(t *testing.T) {
	srv, models := tokenLoginServer(t, "org-from-cli")
	srv.probes.SetProbeFunc(func(kind string) cliprobe.Probe {
		if kind == "claude-code" {
			return cliprobe.Probe{Kind: kind, Installed: true, Authenticated: true, AuthMethod: "claude.ai", Email: "user@example.com", OrgID: "org-1"}
		}
		return cliprobe.Probe{Kind: kind}
	})
	if got := claudeAccount(t, srv.readProviderAccountUsage()); got.OrgID != "org-1" || len(*models) != 0 {
		t.Fatalf("account %+v, reads %v", got, *models)
	}
}
