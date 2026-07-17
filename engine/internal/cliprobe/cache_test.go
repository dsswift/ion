package cliprobe

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

func TestRegistry_RefreshAndGet(t *testing.T) {
	reg := NewRegistry()
	reg.SetProbeFunc(func(kind string) Probe {
		return Probe{
			Kind:          kind,
			Installed:     true,
			Authenticated: kind == "codex",
			Models:        []types.ModelEntry{{ID: kind + "-model", ProviderID: kind}},
		}
	})
	reg.Refresh([]string{"codex", "grok"})

	codex, ok := reg.Get("codex")
	if !ok || !codex.Installed || !codex.Authenticated {
		t.Fatalf("expected codex probe installed+authed, got %+v ok=%v", codex, ok)
	}
	grok, ok := reg.Get("grok")
	if !ok || grok.Authenticated {
		t.Fatalf("expected grok probe present but not authed, got %+v ok=%v", grok, ok)
	}
	if _, ok := reg.Get("cursor"); ok {
		t.Fatal("expected no cached probe for a kind never refreshed")
	}
}

func TestRegistry_ReprobeOverwrites(t *testing.T) {
	reg := NewRegistry()
	authed := false
	reg.SetProbeFunc(func(kind string) Probe { return Probe{Kind: kind, Installed: true, Authenticated: authed} })
	reg.Refresh([]string{"codex"})
	if p, _ := reg.Get("codex"); p.Authenticated {
		t.Fatal("expected not authed on first probe")
	}
	authed = true
	reg.Refresh([]string{"codex"})
	if p, _ := reg.Get("codex"); !p.Authenticated {
		t.Fatal("expected authed after re-probe")
	}
}
