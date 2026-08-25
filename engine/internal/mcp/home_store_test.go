package mcp

import (
	"testing"
	"time"
)

// TestStoresFollowHomeChanges pins isolation for tests and embedded consumers
// that change HOME between engine operations. Reusing the old singleton would
// expose a token from the previous storage root as authentication for a new
// home, which made the MCP server snapshot report false credentials.
func TestStoresFollowHomeChanges(t *testing.T) {
	firstHome := t.TempDir()
	t.Setenv("HOME", firstHome)
	getOAuthStore().SetToken("srv", &OAuthToken{
		AccessToken: "access",
		TokenType:   "bearer",
		ExpiresAt:   time.Now().Add(time.Hour),
	})
	getClientStore().Set("srv", &ClientRegistration{ClientID: "client"})

	secondHome := t.TempDir()
	t.Setenv("HOME", secondHome)
	if getOAuthStore().GetToken("srv") != nil {
		t.Fatal("OAuth store reused credentials from the previous HOME")
	}
	if getClientStore().Get("srv") != nil {
		t.Fatal("client store reused registration from the previous HOME")
	}
}
