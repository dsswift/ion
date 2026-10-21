package extension

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/asyncreg"
)

func TestAsyncFireEnvelopeSessionKeyFollowsContext(t *testing.T) {
	engine := NewHost()
	engine.SetScope(HostScopeEngine, ManifestScopeBoth)
	env := engine.buildAsyncFireEnvelope(asyncreg.KindSchedule, "tick", &Context{SessionKey: "headless:ext:1"}, nil)
	if env.SessionKey != "headless:ext:1" {
		t.Fatalf("engine host fire carried %q, want the headless session the resolver minted", env.SessionKey)
	}

	bound := NewHost()
	bound.SetSessionKey("tab-1")
	env = bound.buildAsyncFireEnvelope(asyncreg.KindWebhook, "/hook", &Context{}, nil)
	if env.SessionKey != "tab-1" {
		t.Fatalf("session host fire carried %q, want its bound key", env.SessionKey)
	}
}
