package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// ---------------------------------------------------------------------------
// newChildBackend tests
// ---------------------------------------------------------------------------

func TestNewChildBackend_ApiParent(t *testing.T) {
	mgr := NewManager(backend.NewApiBackend())
	child := mgr.newChildBackend()
	if _, ok := child.(*backend.ApiBackend); !ok {
		t.Errorf("expected *ApiBackend child, got %T", child)
	}
}

func TestNewChildBackend_CliParent(t *testing.T) {
	mgr := NewManager(backend.NewCliBackend())
	child := mgr.newChildBackend()
	if _, ok := child.(*backend.CliBackend); !ok {
		t.Errorf("expected *CliBackend child, got %T", child)
	}
}

func TestNewChildBackend_MockParent(t *testing.T) {
	mgr := NewManager(newMockBackend())
	child := mgr.newChildBackend()
	// Mock is neither CliBackend nor ApiBackend; should default to ApiBackend
	if _, ok := child.(*backend.ApiBackend); !ok {
		t.Errorf("expected *ApiBackend child for unknown parent, got %T", child)
	}
}

func TestNewChildBackend_HybridParent(t *testing.T) {
	parent := backend.NewHybridBackend()
	mgr := NewManager(parent)
	child := mgr.newChildBackend()
	hybridChild, ok := child.(*backend.HybridBackend)
	if !ok {
		t.Fatalf("expected *HybridBackend child for hybrid parent, got %T", child)
	}
	if hybridChild == parent {
		t.Fatalf("expected fresh child instance, got same pointer as parent")
	}
}

func TestNewChildBackend_HybridParent_PropagatesAuthResolver(t *testing.T) {
	parent := backend.NewHybridBackend()
	r := auth.NewResolver(nil)
	parent.SetAuthResolver(r)

	mgr := NewManager(parent)
	child := mgr.newChildBackend().(*backend.HybridBackend)
	if got := child.InnerApi().AuthResolver(); got != r {
		t.Fatalf("expected child's inner ApiBackend to inherit parent's auth resolver, got %v", got)
	}
}

// ---------------------------------------------------------------------------
// resolvedBackend tests
// ---------------------------------------------------------------------------

// registerSessionTestModels seeds the model registry for resolvedBackend
// tests. Models registered here must have a ProviderID; ContextWindow is
// only used by other code paths and isn't asserted on.
func registerSessionTestModels(t *testing.T) {
	t.Helper()
	providers.RegisterModel("claude-session-test", types.ModelInfo{
		ProviderID:    "anthropic",
		ContextWindow: 200000,
	})
	providers.RegisterModel("gpt-session-test", types.ModelInfo{
		ProviderID:    "openai",
		ContextWindow: 128000,
	})
}

func TestResolvedBackend_PlainCli_PassesThrough(t *testing.T) {
	registerSessionTestModels(t)
	cli := backend.NewCliBackend()
	mgr := NewManager(cli)
	// Even for a non-Anthropic model, resolvedBackend returns m.backend
	// unchanged because m.backend is not a HybridBackend.
	if got := mgr.resolvedBackend("gpt-session-test"); got != cli {
		t.Fatalf("expected plain CliBackend to pass through unchanged, got %T", got)
	}
}

func TestResolvedBackend_PlainApi_PassesThrough(t *testing.T) {
	registerSessionTestModels(t)
	api := backend.NewApiBackend()
	mgr := NewManager(api)
	// Even for a claude-* model, resolvedBackend returns m.backend
	// unchanged because m.backend is not a HybridBackend.
	if got := mgr.resolvedBackend("claude-session-test"); got != api {
		t.Fatalf("expected plain ApiBackend to pass through unchanged, got %T", got)
	}
}

func TestResolvedBackend_MockBackend_PassesThrough(t *testing.T) {
	mock := newMockBackend()
	mgr := NewManager(mock)
	// Tests in the session package use a mockBackend that is neither
	// CliBackend nor ApiBackend nor HybridBackend. resolvedBackend must
	// return it unchanged so the existing test suite keeps working.
	if got := mgr.resolvedBackend("any-model"); got != mock {
		t.Fatalf("expected mockBackend to pass through unchanged, got %T", got)
	}
}

func TestResolvedBackend_Hybrid_ClaudeRoutesToCli(t *testing.T) {
	registerSessionTestModels(t)
	hybrid := backend.NewHybridBackend()
	mgr := NewManager(hybrid)
	got := mgr.resolvedBackend("claude-session-test")
	if _, ok := got.(*backend.CliBackend); !ok {
		t.Fatalf("expected hybrid + claude-* to resolve to *CliBackend, got %T", got)
	}
	if got != hybrid.InnerCli() {
		t.Fatalf("expected exactly the hybrid's inner CliBackend, got different pointer")
	}
}

func TestResolvedBackend_Hybrid_OpenAIRoutesToApi(t *testing.T) {
	registerSessionTestModels(t)
	hybrid := backend.NewHybridBackend()
	mgr := NewManager(hybrid)
	got := mgr.resolvedBackend("gpt-session-test")
	if _, ok := got.(*backend.ApiBackend); !ok {
		t.Fatalf("expected hybrid + gpt-* to resolve to *ApiBackend, got %T", got)
	}
	if got != hybrid.InnerApi() {
		t.Fatalf("expected exactly the hybrid's inner ApiBackend, got different pointer")
	}
}

func TestResolvedBackend_Hybrid_UnknownRoutesToApi(t *testing.T) {
	hybrid := backend.NewHybridBackend()
	mgr := NewManager(hybrid)
	// "completely-unregistered" is not in the model registry, so
	// GetModelInfo returns nil and routing defaults to ApiBackend (safe
	// default — provider error surfaces cleanly).
	got := mgr.resolvedBackend("completely-unregistered")
	if _, ok := got.(*backend.ApiBackend); !ok {
		t.Fatalf("expected hybrid + unknown model to default to *ApiBackend, got %T", got)
	}
	if got != hybrid.InnerApi() {
		t.Fatalf("expected exactly the hybrid's inner ApiBackend, got different pointer")
	}
}

func TestResolvedBackend_Hybrid_EmptyModelRoutesToApi(t *testing.T) {
	hybrid := backend.NewHybridBackend()
	mgr := NewManager(hybrid)
	// Empty model string — same default behavior as unknown.
	got := mgr.resolvedBackend("")
	if _, ok := got.(*backend.ApiBackend); !ok {
		t.Fatalf("expected hybrid + empty model to default to *ApiBackend, got %T", got)
	}
}
