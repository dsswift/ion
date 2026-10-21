package session

import (
	"context"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestResolveRunAsPrincipalUnset(t *testing.T) {
	p, err := resolveRunAsPrincipal(context.Background(), nil, nil)
	if err != nil || p != nil {
		t.Fatalf("unset run-as = %v, %v; want nil, nil", p, err)
	}
}

func TestResolveRunAsPrincipalLiteral(t *testing.T) {
	cfg := &types.RunAsPrincipalConfig{Mode: types.RunAsModePrincipal, Principal: &types.SessionPrincipal{Subject: "local:josh", Provider: "os", Kind: "local", DisplayName: "Josh"}}
	p, err := resolveRunAsPrincipal(context.Background(), cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	if p.Subject != "local:josh" || p.Kind != "local" || p.DisplayName != "Josh" {
		t.Fatalf("principal = %+v", p)
	}
	if p == cfg.Principal {
		t.Fatal("the resolved principal must be a copy, not the config pointer")
	}
	cfg.Principal.Kind = ""
	p, err = resolveRunAsPrincipal(context.Background(), cfg, nil)
	if err != nil || p.Kind != "operator" {
		t.Fatalf("kind defaults to operator; got %+v, %v", p, err)
	}
}

func TestResolveRunAsPrincipalInvalid(t *testing.T) {
	_, err := resolveRunAsPrincipal(context.Background(), &types.RunAsPrincipalConfig{Mode: "person"}, nil)
	if err == nil || !strings.Contains(err.Error(), "mode must be") {
		t.Fatalf("error = %v", err)
	}
}

func TestResolveRunAsPrincipalWorkloadNeedsMachineIdentity(t *testing.T) {
	cfg := &types.RunAsPrincipalConfig{Mode: types.RunAsModeWorkload}
	_, err := resolveRunAsPrincipal(context.Background(), cfg, nil)
	if err == nil || !strings.Contains(err.Error(), "auth.identityProvider") {
		t.Fatalf("no auth config: %v", err)
	}
	authCfg := &types.AuthConfig{IdentityProvider: "entra", OAuth: map[string]types.OAuthConfig{"entra": {ClientID: "x"}}}
	_, err = resolveRunAsPrincipal(context.Background(), cfg, authCfg)
	if err == nil || !strings.Contains(err.Error(), "not a machineIdentity entry") {
		t.Fatalf("operator provider: %v", err)
	}
}
