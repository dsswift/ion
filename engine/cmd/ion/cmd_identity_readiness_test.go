package main

import (
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestConfiguredWorkloadStartupRejectsInvalidIdentity(t *testing.T) {
	cfg := &types.AuthConfig{IdentityProvider: "machine", OAuth: map[string]types.OAuthConfig{"machine": {
		MachineIdentity: &types.MachineIdentityConfig{Source: "client_secret", ClientSecretFile: "/missing-secret"},
	}}}
	_, verification, err := configureIdentityReadiness(cfg)
	if err == nil || verification != nil {
		t.Fatalf("configureIdentityReadiness = %#v, %v", verification, err)
	}
	if !strings.Contains(err.Error(), "read client secret file") {
		t.Fatalf("error = %v", err)
	}
}

func TestOptionalOperatorStartupNeedsNoWorkloadProof(t *testing.T) {
	cfg := &types.AuthConfig{IdentityProvider: "operator", OAuth: map[string]types.OAuthConfig{"operator": {ClientID: "client"}}}
	manager, verification, err := configureIdentityReadiness(cfg)
	if err != nil || manager == nil || verification != nil {
		t.Fatalf("configureIdentityReadiness = manager=%#v verification=%#v err=%v", manager, verification, err)
	}
}
