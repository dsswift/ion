package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/types"
)

type contextIdentityProviderStub struct {
	identity *auth.ContextIdentity
}

func (s *contextIdentityProviderStub) ContextIdentity() *auth.ContextIdentity { return s.identity }

func TestContextIdentityFreshDefensiveCopy(t *testing.T) {
	previous := auth.CurrentContextIdentityProvider()
	t.Cleanup(func() { auth.SetContextIdentityProvider(previous) })
	provider := &contextIdentityProviderStub{identity: &auth.ContextIdentity{
		Kind: "operator", Provider: "oidc", Subject: "subject",
		Claims: map[string]any{"nested": map[string]any{"value": "original"}},
	}}
	auth.SetContextIdentityProvider(provider)

	sdk := NewSDK()
	var received []*Context
	sdk.On(HookSessionStart, func(ctx *Context, _ interface{}) (interface{}, error) {
		received = append(received, ctx)
		ctx.Identity.Claims["nested"].(map[string]any)["value"] = "changed"
		return nil, nil
	})
	sdk.On(HookSessionStart, func(ctx *Context, _ interface{}) (interface{}, error) {
		received = append(received, ctx)
		return nil, nil
	})

	base := &Context{SessionKey: "session", Cwd: "/work"}
	sdk.fire(HookSessionStart, base, nil)
	if len(received) != 2 {
		t.Fatalf("received %d contexts, want 2", len(received))
	}
	if base.Identity != nil {
		t.Fatal("base context identity was mutated")
	}
	if got := received[1].Identity.Claims["nested"].(map[string]any)["value"]; got != "original" {
		t.Errorf("second handler nested claim = %v, want original", got)
	}
	if got := provider.identity.Claims["nested"].(map[string]any)["value"]; got != "original" {
		t.Errorf("provider nested claim = %v, want original", got)
	}
}

func TestContextIdentityStampsToolsAndCommands(t *testing.T) {
	previous := auth.CurrentContextIdentityProvider()
	t.Cleanup(func() { auth.SetContextIdentityProvider(previous) })
	auth.SetContextIdentityProvider(&contextIdentityProviderStub{identity: &auth.ContextIdentity{Kind: "operator", Provider: "oidc"}})

	sdk := NewSDK()
	sdk.RegisterTool(ToolDefinition{Name: "identity", Execute: func(_ interface{}, ctx *Context) (*types.ToolResult, error) {
		if ctx.Identity == nil || ctx.Identity.Kind != "operator" {
			t.Errorf("tool identity = %#v, want operator", ctx.Identity)
		}
		return &types.ToolResult{}, nil
	}})
	tool := sdk.Tools()[0]
	if _, err := tool.Execute(nil, &Context{}); err != nil {
		t.Fatalf("tool execute: %v", err)
	}

	sdk.RegisterCommand("identity", CommandDefinition{Execute: func(_ string, ctx *Context) error {
		if ctx.Identity == nil || ctx.Identity.Provider != "oidc" {
			t.Errorf("command identity = %#v, want oidc", ctx.Identity)
		}
		return nil
	}})
	if err := sdk.Commands()["identity"].Execute("", &Context{}); err != nil {
		t.Fatalf("command execute: %v", err)
	}
}

func TestBuildHookEnvelopeIdentity(t *testing.T) {
	h := NewHost()
	identity := &auth.ContextIdentity{Kind: "workload", Provider: "aws", Claims: map[string]any{"enabled": true}}
	envelope := h.buildHookEnvelope(&Context{Cwd: "/work", Identity: identity}, nil)
	ctx := envelope["_ctx"].(map[string]interface{})
	if got, ok := ctx["identity"].(*auth.ContextIdentity); !ok || got != identity {
		t.Errorf("identity = %#v, want supplied identity", ctx["identity"])
	}
	absent := h.buildHookEnvelope(&Context{Cwd: "/work"}, nil)["_ctx"].(map[string]interface{})
	if _, ok := absent["identity"]; ok {
		t.Error("absent identity must be omitted")
	}
}
