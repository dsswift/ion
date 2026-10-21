package extension

import (
	"errors"
	"testing"

	"github.com/dsswift/ion/engine/internal/asyncreg"
)

func intervalJob(id string) ScheduleJob {
	return ScheduleJob{JobID: id, Kind: ScheduleInterval, IntervalMs: 60_000}
}

func TestHostScopeDefaultsToSession(t *testing.T) {
	h := NewHost()
	if h.Scope() != HostScopeSession || h.ManifestScope() != ManifestScopeSession || h.IsEngineHost() {
		t.Fatal("a host never given a scope is a session host of a session-scoped extension")
	}
	h.SetScope("", "")
	if h.Scope() != HostScopeSession || h.ManifestScope() != ManifestScopeSession {
		t.Fatal("empty values resolve to session")
	}
}

func TestSessionHostOfSessionExtensionAcceptsAsync(t *testing.T) {
	h := NewHost()
	h.SetScope(HostScopeSession, ManifestScopeSession)
	if err := h.RegisterScheduleDecl(intervalJob("tick"), asyncreg.OriginRuntime); err != nil {
		t.Fatalf("schedule refused on a plain session host: %v", err)
	}
	if err := h.RegisterWebhookDecl(WebhookRoute{Path: "/hook", Auth: WebhookAuth{Kind: AuthNone}}, asyncreg.OriginRuntime); err != nil {
		t.Fatalf("webhook refused on a plain session host: %v", err)
	}
}

func TestSessionHostOfScopedExtensionRefusesAsync(t *testing.T) {
	for _, scope := range []ManifestScope{ManifestScopeBoth, ManifestScopeEngine} {
		h := NewHost()
		h.SetScope(HostScopeSession, scope)
		err := h.RegisterScheduleDecl(intervalJob("tick"), asyncreg.OriginRuntime)
		if !errors.Is(err, ErrScopeMismatch) {
			t.Fatalf("manifest %s: schedule error = %v, want ErrScopeMismatch", scope, err)
		}
		err = h.RegisterWebhookDecl(WebhookRoute{Path: "/hook", Auth: WebhookAuth{Kind: AuthNone}}, asyncreg.OriginRuntime)
		if !errors.Is(err, ErrScopeMismatch) {
			t.Fatalf("manifest %s: webhook error = %v, want ErrScopeMismatch", scope, err)
		}
		if len(h.Schedules()) != 0 || len(h.Webhooks()) != 0 {
			t.Fatal("a refused registration must not land in the registry")
		}
		if asyncRPCErrorCode(err) != -32000 {
			t.Fatal("scope mismatch is a registration-declined RPC error")
		}
	}
}

func TestEngineHostAcceptsAsync(t *testing.T) {
	h := NewHost()
	h.SetScope(HostScopeEngine, ManifestScopeBoth)
	if !h.IsEngineHost() {
		t.Fatal("engine host")
	}
	if err := h.RegisterScheduleDecl(intervalJob("tick"), asyncreg.OriginInit); err != nil {
		t.Fatalf("schedule refused on the engine host: %v", err)
	}
	if err := h.RegisterWebhookDecl(WebhookRoute{Path: "/hook", Auth: WebhookAuth{Kind: AuthNone}}, asyncreg.OriginInit); err != nil {
		t.Fatalf("webhook refused on the engine host: %v", err)
	}
}

func TestEngineHostInitDropsSessionSurface(t *testing.T) {
	h := NewHost()
	h.SetScope(HostScopeEngine, ManifestScopeEngine)
	commands := map[string]struct {
		Description string `json:"description"`
	}{"dashboard": {Description: "x"}}
	tools, cmds, hooks := h.filterEngineHostInit(
		[]toolRegistryTool{{Name: "echo"}}, commands,
		[]string{HookSessionStart, HookIdentityChanged, HookScheduleMissed, HookToolStart},
	)
	if len(tools) != 0 || len(cmds) != 0 {
		t.Fatalf("tools/commands kept on an engine host: %v %v", tools, cmds)
	}
	if len(hooks) != 2 || hooks[0] != HookIdentityChanged || hooks[1] != HookScheduleMissed {
		t.Fatalf("hooks = %v, want only the engine-host hooks", hooks)
	}
}

func TestSessionHostInitKeepsSessionSurface(t *testing.T) {
	h := NewHost()
	h.SetScope(HostScopeSession, ManifestScopeBoth)
	commands := map[string]struct {
		Description string `json:"description"`
	}{"dashboard": {Description: "x"}}
	tools, cmds, hooks := h.filterEngineHostInit([]toolRegistryTool{{Name: "echo"}}, commands, []string{HookSessionStart})
	if len(tools) != 1 || len(cmds) != 1 || len(hooks) != 1 {
		t.Fatal("a session host keeps everything it declared")
	}
}
