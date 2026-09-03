package extension

import (
	"github.com/dsswift/ion/engine/internal/auth"
	"testing"
)

func TestFireIdentityChangedDeliversCompleteSnapshot(t *testing.T) {
	sdk := NewSDK()
	var got IdentityChangedInfo
	sdk.On(HookIdentityChanged, func(_ *Context, payload interface{}) (interface{}, error) {
		got = payload.(IdentityChangedInfo)
		return nil, nil
	})
	identity := &auth.ContextIdentity{Kind: "operator", Provider: "test", Subject: "subject"}
	if err := sdk.FireIdentityChanged(&Context{}, IdentityChangedInfo{Identity: identity, Reason: "initial"}); err != nil {
		t.Fatalf("fire: %v", err)
	}
	if got.Identity == nil || got.Identity.Subject != "subject" || got.Reason != "initial" {
		t.Fatalf("unexpected payload: %#v", got)
	}
}
